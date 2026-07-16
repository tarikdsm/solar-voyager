import bodiesDocument from '../../data/bodies.json';
import { describe, expect, it } from 'vitest';

import { createEpochState } from './createEpochState.js';

describe('createEpochState', () => {
  it('evaluates every finite J2026 rail and starts exactly 400 km above Earth', () => {
    const state = createEpochState();
    const earthIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'earth');
    const earth = bodiesDocument.bodies[earthIndex];
    if (earth === undefined) throw new Error('Earth fixture is missing.');
    const earthOffset = earthIndex * 3;
    const earthX = state.positionsKm[earthOffset];
    if (earthX === undefined) throw new Error('Earth rail position is missing.');

    expect(state.bodies).toHaveLength(bodiesDocument.bodies.length);
    expect(state.positionsKm).toHaveLength(bodiesDocument.bodies.length * 3);
    expect(Array.from(state.positionsKm).every(Number.isFinite)).toBe(true);
    expect(state.cameraPositionKm).toEqual({
      x: earthX + earth.meanRadiusKm + 400,
      y: state.positionsKm[earthOffset + 1],
      z: state.positionsKm[earthOffset + 2],
    });
  });
});
