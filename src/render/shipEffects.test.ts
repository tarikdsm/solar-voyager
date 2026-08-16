import { MeshStandardMaterial, Object3D } from 'three';
import { describe, expect, test } from 'vitest';

import { writeQuaternionFromForwardInto } from '../sim/ship/attitude.js';

import { createEffectBindingTelemetry } from './effectBindingGuard.js';
import { QUALITY_PROFILES } from './perfGovernor.js';
import { plumeApparentMagnitude } from './plumeRadiance.js';
import {
  SHIP_NOZZLE_THROAT_X_M,
  SHIP_RCS_POD_NODE_NAMES,
  SHIP_RCS_POD_ORIGINS_M,
} from './shipEffectAnchors.js';
import {
  ShipEffects,
  SHIP_EFFECTS_BINDING_LABEL,
  type ShipEffectsScenePort,
} from './shipEffects.js';
import { SHIP_MODEL_SCALE_KM_PER_UNIT } from './shipVisual.js';

const AU_KM = 149_597_870.7;
const FULL_POWER_W = 2.939_95e14;
const SUN_INDEX = 0;
const SHIP_INDEX = 1;

interface Harness {
  readonly effects: ShipEffects;
  readonly positionsKm: Float64Array;
  readonly bindCalls: { visual: Object3D; offset: number; label: string }[];
  readonly plumeMagnitudes: number[];
}

/** Records the binding and hands back a fixed render quaternion (identity). */
function harness(renderQuaternion = new Float64Array([0, 0, 0, 1])): Harness {
  const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);
  const bindCalls: { visual: Object3D; offset: number; label: string }[] = [];
  const plumeMagnitudes: number[] = [];
  const spaceScene: ShipEffectsScenePort = {
    effectBindingTelemetry: createEffectBindingTelemetry(),
    bindPackedEffectVisual(visual, _positions, componentOffset, label) {
      bindCalls.push({ visual, offset: componentOffset, label });
    },
    unbindVisual() {
      return true;
    },
  };
  const effects = new ShipEffects({
    spaceScene,
    shipVisual: {
      setPlumeMagnitude(magnitude) {
        plumeMagnitudes.push(magnitude);
      },
      writeRenderQuaternionInto(target) {
        target.set(renderQuaternion);
      },
    },
    positionsKm,
    shipIndex: SHIP_INDEX,
  });
  return { effects, positionsKm, bindCalls, plumeMagnitudes };
}

/** Nose along +X, so the exhaust leaves along -X. */
function attitudeAlongX(): Float64Array {
  const quaternion = new Float64Array(4);
  writeQuaternionFromForwardInto(quaternion, 1, 0, 0);
  return quaternion;
}

/** A body-frame rotation of `angle` about `(x, y, z)` applied to `base`. */
function rotated(base: Float64Array, x: number, y: number, z: number, angle: number): Float64Array {
  const half = angle / 2;
  const sine = Math.sin(half);
  const length = Math.hypot(x, y, z);
  const dx = (x / length) * sine;
  const dy = (y / length) * sine;
  const dz = (z / length) * sine;
  const dw = Math.cos(half);
  const bx = base[0] as number;
  const by = base[1] as number;
  const bz = base[2] as number;
  const bw = base[3] as number;
  return new Float64Array([
    bw * dx + bx * dw + by * dz - bz * dy,
    bw * dy - bx * dz + by * dw + bz * dx,
    bw * dz + bx * dy - by * dx + bz * dw,
    bw * dw - bx * dx - by * dy - bz * dz,
  ]);
}

describe('scene binding', () => {
  test('uses T0129 effect binding, not the throwing ship binding', () => {
    const { effects, bindCalls } = harness();
    try {
      expect(bindCalls).toHaveLength(1);
      expect(bindCalls[0]?.visual).toBe(effects.root);
      expect(bindCalls[0]?.offset).toBe(SHIP_INDEX * 3);
      expect(bindCalls[0]?.label).toBe(SHIP_EFFECTS_BINDING_LABEL);
      expect(effects.nonFiniteObserved).toBe(false);
      expect(effects.degradedBindingCount).toBe(0);
      expect(effects.skippedBindCount).toBe(0);
    } finally {
      effects.dispose();
    }
  });

  test('the root carries the ship scale and three child draw objects', () => {
    const { effects } = harness();
    try {
      expect(effects.root.scale.x).toBe(SHIP_MODEL_SCALE_KM_PER_UNIT);
      expect(effects.root.children).toHaveLength(3);
      expect(effects.root.children.every((child) => !child.visible)).toBe(true);
    } finally {
      effects.dispose();
    }
  });

  test('rejects a ship index that does not address a packed triple', () => {
    expect(
      () =>
        new ShipEffects({
          spaceScene: {
            effectBindingTelemetry: createEffectBindingTelemetry(),
            bindPackedEffectVisual() {},
            unbindVisual: () => true,
          },
          shipVisual: { setPlumeMagnitude() {}, writeRenderQuaternionInto() {} },
          positionsKm: new Float64Array(6),
          shipIndex: 2,
        }),
    ).toThrow(RangeError);
  });
});

describe('far-field plume magnitude', () => {
  test('is infinitely faint while coasting, so the point sprite is unchanged', () => {
    const { effects, plumeMagnitudes } = harness();
    try {
      effects.writeState(attitudeAlongX(), 0, 0, 0, 1 / 60);
      effects.update({ x: 0, y: 0, z: 0 });
      expect(plumeMagnitudes.at(-1)).toBe(Number.POSITIVE_INFINITY);
    } finally {
      effects.dispose();
    }
  });

  test('matches the documented photometry looking down the beam at 1 AU', () => {
    const { effects, plumeMagnitudes } = harness();
    try {
      // Ship at +1 AU with its nose along +X, so the exhaust points at an
      // observer sitting at the origin.
      effects.writeState(attitudeAlongX(), 1, FULL_POWER_W, 0, 1 / 60);
      effects.update({ x: 0, y: 0, z: 0 });
      expect(effects.cosExhaustAngle).toBeCloseTo(1, 9);
      expect(plumeMagnitudes.at(-1)).toBeCloseTo(plumeApparentMagnitude(FULL_POWER_W, 1, AU_KM), 9);
      expect(plumeMagnitudes.at(-1) as number).toBeLessThan(0);
    } finally {
      effects.dispose();
    }
  });

  test('is far dimmer, but still naked-eye-scale, from broadside at 1 AU', () => {
    const { effects, plumeMagnitudes } = harness();
    try {
      effects.writeState(attitudeAlongX(), 1, FULL_POWER_W, 0, 1 / 60);
      effects.update({ x: AU_KM, y: AU_KM, z: 0 });
      expect(effects.cosExhaustAngle).toBeCloseTo(0, 9);
      const magnitude = plumeMagnitudes.at(-1) as number;
      expect(magnitude).toBeGreaterThan(0);
      expect(magnitude).toBeLessThan(12);
    } finally {
      effects.dispose();
    }
  });
});

describe('rotation-derived RCS firing', () => {
  test('a hold-mode slew fires puffs even though no rate was commanded', () => {
    const { effects } = harness();
    try {
      const base = attitudeAlongX();
      effects.writeState(base, 0, 0, 0, 1 / 60);
      expect(effects.rcsFiring).toBe(false);
      // Body +Z is yaw; 0.2 rad/s over one 60 Hz simulated step.
      const turned = rotated(base, 0, 0, 1, 0.2 / 60);
      effects.writeState(turned, 0, 0, 1 / 60, 1 / 60);
      expect(effects.rcsFiring).toBe(true);
      expect(effects.rcsLivePuffCount).toBe(4);
    } finally {
      effects.dispose();
    }
  });

  test('a step too large to differentiate is dropped and counted, not believed', () => {
    const { effects } = harness();
    try {
      const base = attitudeAlongX();
      effects.writeState(base, 0, 0, 0, 1);
      effects.writeState(rotated(base, 0, 0, 1, 2.5), 0, 0, 1, 1);
      expect(effects.rcsFiring).toBe(false);
      expect(effects.degradedRateSteps).toBe(1);
    } finally {
      effects.dispose();
    }
  });

  test('a paused frame produces no rate at all', () => {
    const { effects } = harness();
    try {
      const base = attitudeAlongX();
      effects.writeState(base, 0, 0, 0, 1 / 60);
      effects.writeState(rotated(base, 0, 0, 1, 0.01), 0, 0, 0, 0);
      expect(effects.rcsFiring).toBe(false);
      expect(effects.degradedRateSteps).toBe(0);
    } finally {
      effects.dispose();
    }
  });

  test('a non-finite attitude silences the puffs instead of throwing', () => {
    const { effects } = harness();
    try {
      effects.writeState(attitudeAlongX(), 0.5, FULL_POWER_W, 0, 1 / 60);
      expect(() => {
        effects.writeState(new Float64Array([Number.NaN, 0, 0, 1]), 0.5, FULL_POWER_W, 1, 1 / 60);
      }).not.toThrow();
      expect(effects.rcsFiring).toBe(false);
      // The beam is throttle-driven, so it keeps burning: only the attitude went bad.
      expect(effects.burning).toBe(true);
    } finally {
      effects.dispose();
    }
  });
});

describe('governor and warm-up', () => {
  test('the top and bottom rungs move both the beam and the puff pool', () => {
    const { effects } = harness();
    try {
      const top = QUALITY_PROFILES[0];
      const bottom = QUALITY_PROFILES[QUALITY_PROFILES.length - 1];
      if (top === undefined || bottom === undefined) throw new Error('missing profile');
      effects.applyQuality(top);
      expect(effects.beamSegments).toBe(24);
      expect(effects.rcsLiveCapacity).toBe(16);
      effects.applyQuality(bottom);
      expect(effects.beamSegments).toBe(6);
      expect(effects.rcsLiveCapacity).toBe(0);
      effects.writeState(attitudeAlongX(), 0, 0, 0, 1 / 60);
      expect(effects.rcsFiring).toBe(false);
    } finally {
      effects.dispose();
    }
  });

  test('the compilation pass lights everything, and putting it back is exact', () => {
    const { effects } = harness();
    try {
      effects.writeState(attitudeAlongX(), 0, 0, 0, 1 / 60);
      effects.prepareCompilationPass();
      expect(effects.root.children.every((child) => child.visible)).toBe(true);
      // A snapshot that arrives mid-warm-up must not undo it.
      effects.writeState(attitudeAlongX(), 0, 0, 0.1, 1 / 60);
      expect(effects.root.children.every((child) => child.visible)).toBe(true);
      effects.endCompilationPass();
      expect(effects.root.children.some((child) => child.visible)).toBe(false);
      expect(effects.burning).toBe(false);
    } finally {
      effects.dispose();
    }
  });
});

describe('asset anchor verification', () => {
  function shipModel(nozzleX: number): Object3D {
    const root = new Object3D();
    const nozzle = new Object3D();
    nozzle.name = 'engine_nozzle';
    nozzle.position.set(nozzleX, 0, 0);
    root.add(nozzle);
    for (let index = 0; index < SHIP_RCS_POD_NODE_NAMES.length; index += 1) {
      const pod = new Object3D();
      pod.name = SHIP_RCS_POD_NODE_NAMES[index] as string;
      const origin = SHIP_RCS_POD_ORIGINS_M[index] as readonly [number, number, number];
      pod.position.set(origin[0], origin[1], origin[2]);
      root.add(pod);
    }
    return root;
  }

  test('accepts the committed asset within float32 rounding', () => {
    const { effects } = harness();
    try {
      const material = new MeshStandardMaterial();
      material.name = 'mat_light_beacon';
      effects.bindModel(shipModel(SHIP_NOZZLE_THROAT_X_M), [material]);
      expect(effects.modelBound).toBe(true);
      expect(effects.anchorErrorM).toBeLessThan(1e-5);
      expect(effects.anchorsVerified).toBe(true);
      expect(effects.lightCount).toBe(1);
    } finally {
      effects.dispose();
    }
  });

  test('reports a moved node as a number rather than throwing mid-load', () => {
    const { effects } = harness();
    try {
      effects.bindModel(shipModel(SHIP_NOZZLE_THROAT_X_M + 0.5), []);
      expect(effects.anchorErrorM).toBeCloseTo(0.5, 9);
      expect(effects.anchorsVerified).toBe(false);
    } finally {
      effects.dispose();
    }
  });

  test('a missing node is an infinite error, never a silent pass', () => {
    const { effects } = harness();
    try {
      effects.bindModel(new Object3D(), []);
      expect(effects.anchorErrorM).toBe(Number.POSITIVE_INFINITY);
      expect(effects.anchorsVerified).toBe(false);
    } finally {
      effects.dispose();
    }
  });
});

describe('effect-binding telemetry passthrough', () => {
  test('publishes the scene counters T0129 asked this task to surface', () => {
    const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);
    const telemetry = createEffectBindingTelemetry();
    const effects = new ShipEffects({
      spaceScene: {
        effectBindingTelemetry: telemetry,
        bindPackedEffectVisual() {},
        unbindVisual: () => true,
      },
      shipVisual: { setPlumeMagnitude() {}, writeRenderQuaternionInto() {} },
      positionsKm,
      shipIndex: SHIP_INDEX,
    });
    try {
      expect(effects.nonFiniteObserved).toBe(false);
      telemetry.nonFiniteObserved = true;
      telemetry.degradedBindingCount = 1;
      telemetry.skippedBindCount = 7;
      expect(effects.nonFiniteObserved).toBe(true);
      expect(effects.degradedBindingCount).toBe(1);
      expect(effects.skippedBindCount).toBe(7);
    } finally {
      effects.dispose();
    }
  });

  test('the sun slot is never disturbed by the effects root', () => {
    const { effects, positionsKm } = harness();
    try {
      effects.writeState(attitudeAlongX(), 1, FULL_POWER_W, 0, 1 / 60);
      effects.update({ x: 0, y: 0, z: 0 });
      expect(positionsKm[SUN_INDEX * 3]).toBe(0);
      expect(positionsKm[SHIP_INDEX * 3]).toBe(AU_KM);
    } finally {
      effects.dispose();
    }
  });
});
