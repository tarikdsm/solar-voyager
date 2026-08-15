import { describe, expect, it, vi } from 'vitest';

import { OrbitCameraController } from '../game/orbitCameraController.js';
import { SystemMapController } from '../game/systemMapController.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import { SharedCameraControls } from './sharedCameraControls.js';

const BODY_IDS = ['sun', 'earth', 'mars'] as const;
const SHIP_ID = 'ship';

/** Sun, Earth, Mars, then the ship — the epoch world's target ordering. */
function positions(): Float64Array {
  return new Float64Array([0, 0, 0, 1_000, 0, 0, 2_000, 0, 0, 1_000, 0, 100]);
}

function createRig() {
  const positionsKm = positions();
  const camera = new OrbitCameraController({
    positionsKm,
    targets: [
      { id: 'sun', positionOffset: 0, meanRadiusKm: 100 },
      { id: 'earth', positionOffset: 3, meanRadiusKm: 10 },
      { id: 'mars', positionOffset: 6, meanRadiusKm: 5 },
      { id: SHIP_ID, positionOffset: 9, meanRadiusKm: 0.013_06 },
    ],
    initialFocusId: 'earth',
    initialCameraPositionKm: { x: 1_050, y: 0, z: 0 },
  });
  const onFocusChange = vi.fn((bodyId: string) => {
    // The production relay: the map tells the space camera where to look.
    camera.focusBody(bodyId);
  });
  const map = new SystemMapController({
    bodyIds: [...BODY_IDS],
    initialFocusId: 'earth',
    onFocusChange,
  });
  const setTarget = vi.fn();
  const commands = {
    setThrottle: vi.fn(),
    setAttitudeMode: vi.fn(),
    rotate: vi.fn(),
    setWarp: vi.fn(),
    setTarget,
  } as unknown as Commands;
  const controls = new SharedCameraControls(camera, map, commands, [...BODY_IDS]);
  return { camera, controls, map, onFocusChange, setTarget };
}

describe('SharedCameraControls', () => {
  it('reports the camera focus so a non-catalog focus can be labelled', () => {
    const rig = createRig();
    expect(rig.controls.focusId).toBe('earth');
    rig.controls.cycleFocus(-1);
    rig.controls.cycleFocus(-1);
    expect(rig.controls.focusId).toBe(SHIP_ID);
  });

  it('never routes a non-catalog focus at the map or the simulation', () => {
    const rig = createRig();
    // earth -> sun -> ship
    expect(rig.controls.cycleFocus(-1)).toBe('sun');
    expect(rig.controls.cycleFocus(-1)).toBe(SHIP_ID);
    expect(rig.camera.focusId).toBe(SHIP_ID);
    expect(rig.map.focusId).toBe('sun');
    expect(rig.setTarget.mock.calls).toEqual([['sun']]);
  });

  it('recalls the camera from the ship even when the map focus does not move', () => {
    const rig = createRig();
    rig.controls.cycleFocus(-1);
    rig.controls.cycleFocus(-1);
    expect(rig.camera.focusId).toBe(SHIP_ID);
    expect(rig.map.focusId).toBe('sun');

    // The map is already on the Sun, so `SystemMapController.focusBody` returns
    // early and never fires the relay. The camera must still leave the ship.
    const onFocusChangeCalls = rig.onFocusChange.mock.calls.length;
    expect(rig.controls.focusBody('sun')).toBe(true);
    expect(rig.onFocusChange.mock.calls).toHaveLength(onFocusChangeCalls);
    expect(rig.camera.focusId).toBe('sun');
    expect(rig.controls.focusId).toBe('sun');
  });

  it('still drives the map and the simulation when the focus really changes', () => {
    const rig = createRig();
    expect(rig.controls.focusBody('mars')).toBe(true);
    expect(rig.camera.focusId).toBe('mars');
    expect(rig.map.focusId).toBe('mars');
    expect(rig.setTarget.mock.calls).toEqual([['mars']]);
    expect(rig.onFocusChange.mock.calls).toEqual([['mars']]);
  });

  it('reports no change and touches nothing for an unknown id', () => {
    const rig = createRig();
    expect(rig.controls.focusBody('pluto')).toBe(false);
    expect(rig.camera.focusId).toBe('earth');
    expect(rig.map.focusId).toBe('earth');
    expect(rig.setTarget).not.toHaveBeenCalled();
  });
});
