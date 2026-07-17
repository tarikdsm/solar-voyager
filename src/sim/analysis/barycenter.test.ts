import { describe, expect, it } from 'vitest';

import { evaluateBarycenterInto } from './barycenter.js';

describe('evaluateBarycenterInto', () => {
  it('matches an independent GM-weighted catalog sum', () => {
    // physics-spec.md §6 — masses may be represented by GM because G cancels.
    const muKm3S2 = new Float64Array([10, 3, 2]);
    const positionsKm = new Float64Array([2, -1, 4, -5, 7, 11, 13, 17, -19]);
    const velocitiesKmS = new Float64Array([1, 2, -3, 5, -7, 11, -13, 17, 19]);
    const positionOut = new Float64Array(3);
    const velocityOut = new Float64Array(3);

    const returned = evaluateBarycenterInto(
      positionOut,
      velocityOut,
      muKm3S2,
      positionsKm,
      velocitiesKmS,
    );

    expect(returned).toBe(positionOut);
    expect(positionOut[0]).toBeCloseTo((10 * 2 + 3 * -5 + 2 * 13) / 15, 15);
    expect(positionOut[1]).toBeCloseTo((10 * -1 + 3 * 7 + 2 * 17) / 15, 15);
    expect(positionOut[2]).toBeCloseTo((10 * 4 + 3 * 11 + 2 * -19) / 15, 15);
    expect(velocityOut[0]).toBeCloseTo((10 * 1 + 3 * 5 + 2 * -13) / 15, 15);
    expect(velocityOut[1]).toBeCloseTo((10 * 2 + 3 * -7 + 2 * 17) / 15, 15);
    expect(velocityOut[2]).toBeCloseTo((10 * -3 + 3 * 11 + 2 * 19) / 15, 15);
  });

  it('rejects buffers that cannot describe the same catalog', () => {
    const output = new Float64Array(3);

    expect(() =>
      evaluateBarycenterInto(
        output,
        output,
        new Float64Array([1, 2]),
        new Float64Array(3),
        new Float64Array(6),
      ),
    ).toThrow(/6 packed position components/u);
    expect(() =>
      evaluateBarycenterInto(
        output,
        output,
        new Float64Array(),
        new Float64Array(),
        new Float64Array(),
      ),
    ).toThrow(/positive total GM/u);
  });
});
