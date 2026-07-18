import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import { RelativisticVisualController } from './relativisticVisualController.js';

function createFixture() {
  const spaceScene = { setRelativisticObserver: vi.fn() };
  const starfield = { setRelativisticObserver: vi.fn() };
  const postPass = { updateObserver: vi.fn() };
  const controller = new RelativisticVisualController({ postPass, spaceScene, starfield });
  const camera = new PerspectiveCamera();
  camera.updateMatrixWorld(true);
  const snapshot = createSimulationSnapshotBuffer([]);
  return { camera, controller, postPass, snapshot, spaceScene, starfield };
}

function setBeta(snapshot: ReturnType<typeof createSimulationSnapshotBuffer>, beta: number): void {
  snapshot.shipCoordinateVelocityKmS.set([beta * SPEED_OF_LIGHT_KM_S, 0, 0]);
  snapshot.speedFractionOfLight = beta;
  snapshot.gamma = 1 / Math.sqrt(1 - beta * beta);
}

describe('RelativisticVisualController', () => {
  it('validates before changing any consumer', () => {
    const fixture = createFixture();
    fixture.controller.setQualityEnabled(true);
    setBeta(fixture.snapshot, 0.5);
    fixture.snapshot.gamma = Number.NaN;

    expect(() => fixture.controller.update(fixture.snapshot, fixture.camera)).toThrow(RangeError);
    expect(fixture.spaceScene.setRelativisticObserver).not.toHaveBeenCalled();
    expect(fixture.starfield.setRelativisticObserver).not.toHaveBeenCalled();
    expect(fixture.postPass.updateObserver).not.toHaveBeenCalled();
  });

  it('reuses one observer object across consumers and frames', () => {
    const fixture = createFixture();
    fixture.controller.setQualityEnabled(true);
    setBeta(fixture.snapshot, 0.9);

    fixture.controller.update(fixture.snapshot, fixture.camera);
    const firstState = fixture.spaceScene.setRelativisticObserver.mock.calls[0]?.[0];
    expect(firstState).toBe(fixture.starfield.setRelativisticObserver.mock.calls[0]?.[0]);
    expect(firstState).toBe(fixture.postPass.updateObserver.mock.calls[0]?.[0]);
    expect(firstState?.activation).toBe(1);

    setBeta(fixture.snapshot, 0.5);
    fixture.controller.update(fixture.snapshot, fixture.camera);
    expect(fixture.spaceScene.setRelativisticObserver.mock.calls[1]?.[0]).toBe(firstState);
    expect(fixture.postPass.updateObserver.mock.calls[1]?.[1]).toBe(fixture.camera);
  });

  it('writes an identity observer while quality is disabled', () => {
    const fixture = createFixture();
    setBeta(fixture.snapshot, 0.9);

    fixture.controller.update(fixture.snapshot, fixture.camera);

    const state = fixture.postPass.updateObserver.mock.calls[0]?.[0];
    expect(state?.activation).toBe(0);
    expect(state?.betaX).toBeCloseTo(0.9, 14);
  });
});
