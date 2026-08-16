import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CONSTELLATION_BYTES_PER_SEGMENT,
  CONSTELLATION_SEGMENT_CAPACITY,
  parseConstellationLines,
} from './constellationCatalog.js';
import { CONSTELLATION_MAX_SEGMENTS } from './constellationLines.js';

function payloadOf(pairs: readonly (readonly [number, number])[]): ArrayBuffer {
  const indices = new Uint16Array(pairs.length * 2);
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index] as readonly [number, number];
    indices[index * 2] = pair[0];
    indices[index * 2 + 1] = pair[1];
  }
  return indices.buffer;
}

describe('parseConstellationLines', () => {
  it('parses packed index pairs', () => {
    const catalog = parseConstellationLines(
      payloadOf([
        [0, 1],
        [1, 7],
      ]),
      16,
    );
    expect(catalog.segmentCount).toBe(2);
    expect(Array.from(catalog.starIndices)).toEqual([0, 1, 1, 7]);
  });

  it('rejects a payload that is not whole segments', () => {
    expect(() => parseConstellationLines(new Uint8Array([1, 2, 3]).buffer, 16)).toThrow(RangeError);
    expect(() => parseConstellationLines(new ArrayBuffer(0), 16)).toThrow(RangeError);
  });

  it('rejects an index outside the star catalog', () => {
    expect(() => parseConstellationLines(payloadOf([[0, 99]]), 16)).toThrow(/outside/u);
  });

  it('rejects a segment that joins a star to itself', () => {
    expect(() => parseConstellationLines(payloadOf([[3, 3]]), 16)).toThrow(/itself/u);
  });

  it('rejects a payload larger than the preallocated batch', () => {
    const pairs = Array.from({ length: CONSTELLATION_SEGMENT_CAPACITY + 1 }, () => [0, 1] as const);
    expect(() => parseConstellationLines(payloadOf(pairs), 16)).toThrow(/preallocated/u);
  });

  it('keeps the parser capacity and the batch capacity in step', () => {
    // The parser must stay free of three.js, so the constant is duplicated
    // rather than imported. This is the lock.
    expect(CONSTELLATION_SEGMENT_CAPACITY).toBe(CONSTELLATION_MAX_SEGMENTS);
  });

  it('accepts the committed payload', () => {
    const file = readFileSync(new URL('../../data/constellations.bin', import.meta.url));
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const catalog = parseConstellationLines(buffer, 9_096);
    expect(catalog.segmentCount).toBe(buffer.byteLength / CONSTELLATION_BYTES_PER_SEGMENT);
    expect(catalog.segmentCount).toBe(657);
    expect(catalog.segmentCount).toBeLessThanOrEqual(CONSTELLATION_SEGMENT_CAPACITY);
  });
});
