import { describe, expect, it } from 'vitest';

import { loadStarCatalog, parseStarCatalog } from '../../src/render/starCatalog.js';

function validPayload(): Float32Array {
  return new Float32Array([1, 0, 0, -1.46, 0.63, 0.71, 1, 0, 1, 0, -0.72, 0.64, 0.72, 1]);
}

describe('star catalog loader — rendering-spec.md §5', () => {
  it('returns the original interleaved Float32 payload without copying', () => {
    const source = validPayload();
    const buffer = source.buffer as ArrayBuffer;

    const catalog = parseStarCatalog(buffer);

    expect(catalog.starCount).toBe(2);
    expect(catalog.strideFloats).toBe(7);
    expect(catalog.data.buffer).toBe(buffer);
    expect(catalog.data).toEqual(source);
  });

  it.each([
    {
      name: 'non-finite component',
      mutate: (payload: Float32Array) => {
        payload[0] = Number.NaN;
      },
      error: /record 0.*non-finite/u,
    },
    {
      name: 'non-unit direction',
      mutate: (payload: Float32Array) => {
        payload[0] = 0.5;
      },
      error: /record 0.*direction/u,
    },
    {
      name: 'magnitude outside the source envelope',
      mutate: (payload: Float32Array) => {
        payload[3] = 8.1;
      },
      error: /record 0.*magnitude/u,
    },
    {
      name: 'RGB outside the normalized range',
      mutate: (payload: Float32Array) => {
        payload[4] = -0.1;
      },
      error: /record 0.*red/u,
    },
  ])('rejects $name', ({ mutate, error }) => {
    const payload = validPayload();
    mutate(payload);

    expect(() => parseStarCatalog(payload.buffer as ArrayBuffer)).toThrow(error);
  });

  it('rejects empty and stride-misaligned payloads', () => {
    expect(() => parseStarCatalog(new ArrayBuffer(0))).toThrow(/positive multiple of 28/u);
    expect(() => parseStarCatalog(new ArrayBuffer(4))).toThrow(/positive multiple of 28/u);
  });

  it('loads and validates a fetched catalog', async () => {
    const payload = validPayload();
    const catalog = await loadStarCatalog('/stars.bin', async (input) => {
      expect(input).toBe('/stars.bin');
      return new Response(payload.buffer as ArrayBuffer);
    });

    expect(catalog.starCount).toBe(2);
  });

  it('reports unsuccessful catalog responses', async () => {
    await expect(
      loadStarCatalog('/stars.bin', async () => new Response(null, { status: 503 })),
    ).rejects.toThrow('failed to load star catalog: HTTP 503');
  });
});
