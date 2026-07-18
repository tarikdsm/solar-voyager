import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { fillMissingSouth, preparePlutoMaps } from './preparePlutoMap.mjs';


function fixture() {
  const width = 8;
  const height = 24;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const enclosedSouthernGap = y === 12 && x >= 3 && x <= 4;
      const valid = y < 20 && !enclosedSouthernGap;
      if (valid) {
        pixels[offset] = 90 + x * 4;
        pixels[offset + 1] = 60 + y * 5;
        pixels[offset + 2] = 50 + x * 2;
      }
    }
  }
  return { height, pixels, width };
}


describe('Pluto south-cap reconstruction', () => {
  it('preserves mapped pixels outside the feather and deterministically fills no-data', () => {
    const { height, pixels, width } = fixture();
    const before = Uint8Array.from(pixels);
    const first = fillMissingSouth(pixels, width, height, { seed: 999 });
    const second = fillMissingSouth(before, width, height, { seed: 999 });
    const differentSeed = fillMissingSouth(before, width, height, { seed: 1000 });

    expect(first).toEqual(second);
    expect(first).not.toEqual(differentSeed);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const originallyMapped = before[offset] + before[offset + 1] + before[offset + 2] > 0;
        if (originallyMapped && y === 0) {
          expect(first.slice(offset, offset + 3)).toEqual(before.slice(offset, offset + 3));
        } else if (!originallyMapped) {
          expect(first[offset] + first[offset + 1] + first[offset + 2]).toBeGreaterThan(24);
        }
      }
    }
  });

  it('converges every longitude to one continuous south-pole color', () => {
    const { height, pixels, width } = fixture();
    const output = fillMissingSouth(pixels, width, height, { seed: 999 });
    const firstPole = output.slice((height - 1) * width * 3, (height - 1) * width * 3 + 3);
    for (let x = 1; x < width; x += 1) {
      const offset = ((height - 1) * width + x) * 3;
      expect(output.slice(offset, offset + 3)).toEqual(firstPole);
    }
  });

  it('rejects malformed inputs and images without a southern no-data region', () => {
    const { height, pixels, width } = fixture();
    expect(() => fillMissingSouth(pixels.subarray(1), width, height)).toThrow(/byte length/u);
    expect(() => fillMissingSouth(new Uint8Array(width * height * 3).fill(80), width, height)).toThrow(
      /no-data/u,
    );
  });

  it(
    'rebuilds the real map without a black artifact, row band, or discontinuous pole',
    async () => {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'solar-voyager-pluto-map-'));
      try {
        await preparePlutoMaps({ outputDirectory });
        const { data, info } = await sharp(join(outputDirectory, '2k_pluto.jpg'))
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect([info.width, info.height, info.channels]).toEqual([2048, 1024, 3]);

        let maximumRowGradient = 0;
        let blackArtifactPixels = 0;
        let maximumSouthSeamGradient = 0;
        let southLumaSquareSum = 0;
        let southLumaSum = 0;
        let southSamples = 0;
        for (let y = Math.floor(info.height / 2); y < info.height; y += 1) {
          let rowGradient = 0;
          for (let x = 0; x < info.width; x += 1) {
            const offset = (y * info.width + x) * info.channels;
            if (
              (data[offset] ?? 0) <= 12 &&
              (data[offset + 1] ?? 0) <= 12 &&
              (data[offset + 2] ?? 0) <= 12
            ) {
              blackArtifactPixels += 1;
            }
            if (y === Math.floor(info.height / 2)) continue;
            for (let channel = 0; channel < info.channels; channel += 1) {
              rowGradient += Math.abs(
                (data[offset + channel] ?? 0) -
                  (data[offset - info.width * info.channels + channel] ?? 0),
              );
            }
          }
          maximumRowGradient = Math.max(
            maximumRowGradient,
            rowGradient / (info.width * info.channels),
          );
          if (y >= Math.floor(info.height * 0.75) && y < Math.floor(info.height * 0.93)) {
            const firstOffset = y * info.width * info.channels;
            const lastOffset = firstOffset + (info.width - 1) * info.channels;
            for (let channel = 0; channel < info.channels; channel += 1) {
              maximumSouthSeamGradient = Math.max(
                maximumSouthSeamGradient,
                Math.abs((data[firstOffset + channel] ?? 0) - (data[lastOffset + channel] ?? 0)),
              );
            }
            for (let x = 0; x < info.width; x += 1) {
              const offset = (y * info.width + x) * info.channels;
              const pixelLuma =
                ((data[offset] ?? 0) + (data[offset + 1] ?? 0) + (data[offset + 2] ?? 0)) /
                info.channels;
              southLumaSum += pixelLuma;
              southLumaSquareSum += pixelLuma * pixelLuma;
              southSamples += 1;
            }
          }
        }
        expect(blackArtifactPixels).toBe(0);
        expect(maximumRowGradient).toBeLessThan(8);
        expect(maximumSouthSeamGradient).toBeLessThan(8);
        const southLumaMean = southLumaSum / southSamples;
        const southLumaDeviation = Math.sqrt(
          southLumaSquareSum / southSamples - southLumaMean * southLumaMean,
        );
        expect(southLumaDeviation).toBeGreaterThan(6);

        const polarRingRows = Math.ceil(info.height / 20);
        let maximumPolarRingGradient = 0;
        for (let y = info.height - polarRingRows; y < info.height; y += 1) {
          const rowOffset = y * info.width * info.channels;
          const rowColor = data.slice(rowOffset, rowOffset + info.channels);
          for (let x = 1; x < info.width; x += 1) {
            const offset = (y * info.width + x) * info.channels;
            for (let channel = 0; channel < info.channels; channel += 1) {
              maximumPolarRingGradient = Math.max(
                maximumPolarRingGradient,
                Math.abs((data[offset + channel] ?? 0) - (rowColor[channel] ?? 0)),
              );
            }
          }
        }
        expect(maximumPolarRingGradient).toBeLessThanOrEqual(2);
      } finally {
        await rm(outputDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );
});
