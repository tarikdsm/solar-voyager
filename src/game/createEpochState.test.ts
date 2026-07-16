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
    const earthY = state.positionsKm[earthOffset + 1];
    const earthZ = state.positionsKm[earthOffset + 2];
    if (earthX === undefined || earthY === undefined || earthZ === undefined) {
      throw new Error('Earth rail position is missing.');
    }

    expect(state.bodies).toHaveLength(bodiesDocument.bodies.length);
    expect(state.positionsKm).toHaveLength(bodiesDocument.bodies.length * 3);
    expect(Array.from(state.positionsKm).every(Number.isFinite)).toBe(true);
    const offsetX = state.cameraPositionKm.x - earthX;
    const offsetY = state.cameraPositionKm.y - earthY;
    const offsetZ = state.cameraPositionKm.z - earthZ;
    expect(Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ)).toBeCloseTo(
      earth.meanRadiusKm + 400,
      6,
    );
    expect(offsetX * earthX + offsetY * earthY + offsetZ * earthZ).toBeLessThan(0);
    const look = state.cameraLookDirection;
    expect(Math.sqrt(look.x * look.x + look.y * look.y + look.z * look.z)).toBeCloseTo(1, 12);
  });
});
