import { describe, expect, it, vi } from 'vitest';

import { AU_KM } from '../core/constants.js';
import { vec3, type Vec3 } from '../core/vec3.js';

import {
  EXPOSURE_KEY,
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  EXPOSURE_TAU_BRIGHT_TO_DARK_SEC,
  EXPOSURE_TAU_DARK_TO_BRIGHT_SEC,
  ExposureController,
  FIXED_EXPOSURE,
  solarIlluminanceRatio,
} from './exposureController.js';
import type { ExposureSinkPort } from './lightingPostPipeline.js';
import { SUN_MAGNITUDE_AT_ONE_AU, apparentMagnitude } from './visualTier.js';

const SUN_INDEX = 0;
const MERCURY_INDEX = 1;
const EARTH_INDEX = 2;
const NEPTUNE_INDEX = 3;
const BODY_COUNT = 4;

const SOLAR_RADIUS_KM = 695_700;
const NEAR_SUN_KM = 25 * SOLAR_RADIUS_KM;
const MERCURY_AU = 0.387_098;
const NEPTUNE_AU = 30.069_9;

/** Sun, Mercury, Earth, Neptune strung along +x, plus a ship slot the ladder shares. */
function createFixture(): {
  readonly controller: ExposureController;
  readonly positionsKm: Float64Array;
  readonly sink: ExposureSinkPort & { setExposure: ReturnType<typeof vi.fn> };
} {
  const positionsKm = new Float64Array((BODY_COUNT + 1) * 3);
  positionsKm[MERCURY_INDEX * 3] = MERCURY_AU * AU_KM;
  positionsKm[EARTH_INDEX * 3] = AU_KM;
  positionsKm[NEPTUNE_INDEX * 3] = NEPTUNE_AU * AU_KM;
  const bodyRadiiKm = Float64Array.from([SOLAR_RADIUS_KM, 2_439.7, 6_371, 24_622]);
  const bodyGeometricAlbedos = Float64Array.from([1, 0.142, 0.434, 0.442]);
  const sink = { setExposure: vi.fn() };
  const controller = new ExposureController({
    sink,
    positionsKm,
    sunIndex: SUN_INDEX,
    bodyRadiiKm,
    bodyGeometricAlbedos,
  });
  return { controller, positionsKm, sink };
}

function cameraAtHeliocentricKm(distanceKm: number): Vec3 {
  return vec3(distanceKm, 0, 0);
}

/** Runs `update` at 60 Hz and returns the wall time at which `predicate` first held. */
function timeToReachSec(
  controller: ExposureController,
  camera: Vec3,
  dominantBodyIndex: number,
  predicate: (exposure: number) => boolean,
  limitSec = 60,
): number {
  const stepSec = 1 / 60;
  for (let elapsedSec = 0; elapsedSec <= limitSec; elapsedSec += stepSec) {
    controller.update(stepSec, camera, dominantBodyIndex);
    if (predicate(controller.exposure)) return elapsedSec + stepSec;
  }
  return Number.POSITIVE_INFINITY;
}

describe('ExposureController scene key', () => {
  it('reuses visualTier magnitudes for the solar term', () => {
    const { controller, positionsKm } = createFixture();
    const camera = cameraAtHeliocentricKm(0.5 * AU_KM);

    controller.update(0, camera, -1);

    const solarMagnitude = apparentMagnitude(
      SUN_INDEX,
      SUN_INDEX,
      SOLAR_RADIUS_KM,
      1,
      positionsKm,
      camera,
    );
    expect(controller.sceneLuminance).toBeCloseTo(solarIlluminanceRatio(solarMagnitude), 12);
    // Inverse square, expressed in solar constants at 1 AU.
    expect(controller.sceneLuminance).toBeCloseTo(4, 9);
  });

  it('adds the dominant body reflected term with albedo and phase', () => {
    const { controller, positionsKm } = createFixture();
    // Between the Sun and Earth, 400 km up: a full Earth filling the sky.
    const camera = cameraAtHeliocentricKm(AU_KM - 6_771);

    controller.update(0, camera, EARTH_INDEX);
    const withEarth = controller.sceneLuminance;
    controller.update(0, camera, -1);
    const withoutEarth = controller.sceneLuminance;

    const earthMagnitude = apparentMagnitude(
      EARTH_INDEX,
      SUN_INDEX,
      6_371,
      0.434,
      positionsKm,
      camera,
    );
    expect(withEarth - withoutEarth).toBeCloseTo(solarIlluminanceRatio(earthMagnitude), 12);
    // Roughly a third of a solar constant of earthshine, and it darkens exposure.
    expect(withEarth - withoutEarth).toBeGreaterThan(0.3);
    expect(withEarth).toBeGreaterThan(withoutEarth);
  });

  it('never counts the Sun twice and ignores an absent dominant body', () => {
    const { controller } = createFixture();
    const camera = cameraAtHeliocentricKm(AU_KM);

    controller.update(0, camera, SUN_INDEX);
    const asDominant = controller.sceneLuminance;
    controller.update(0, camera, -1);
    expect(controller.sceneLuminance).toBe(asDominant);
    expect(asDominant).toBeCloseTo(1, 9);
  });
});

describe('ExposureController pose trend', () => {
  it('orders scene luminance and exposure across Mercury, Earth, Neptune and near-Sun', () => {
    const { controller } = createFixture();
    const poses = [
      { label: 'near-Sun', camera: cameraAtHeliocentricKm(NEAR_SUN_KM) },
      { label: 'Mercury', camera: cameraAtHeliocentricKm(MERCURY_AU * AU_KM) },
      { label: 'Earth', camera: cameraAtHeliocentricKm(AU_KM) },
      { label: 'Neptune', camera: cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM) },
    ];

    const luminances: number[] = [];
    const targets: number[] = [];
    for (const pose of poses) {
      controller.reset(pose.camera, -1);
      luminances.push(controller.sceneLuminance);
      targets.push(controller.targetExposure);
    }

    // The physics is strictly monotonic even where the artistic clamps bind.
    for (let index = 1; index < luminances.length; index += 1) {
      expect(luminances[index]).toBeLessThan(luminances[index - 1] as number);
    }
    // ...and so is the displayed exposure at these four poses.
    for (let index = 1; index < targets.length; index += 1) {
      expect(targets[index]).toBeGreaterThan(targets[index - 1] as number);
    }

    expect(luminances[0]).toBeCloseTo(73.98, 1);
    expect(targets[0]).toBe(EXPOSURE_MIN);
    expect(targets[1]).toBeCloseTo(EXPOSURE_KEY / 6.6733, 4);
    expect(targets[2]).toBeCloseTo(1, 9);
    expect(targets[3]).toBe(EXPOSURE_MAX);
  });

  it('clamps to the photosphere floor and the ambient-limited ceiling', () => {
    const { controller } = createFixture();

    controller.reset(cameraAtHeliocentricKm(2 * SOLAR_RADIUS_KM), -1);
    expect(controller.targetExposure).toBe(EXPOSURE_MIN);
    expect(controller.exposure).toBe(EXPOSURE_MIN);

    controller.reset(cameraAtHeliocentricKm(1_000 * AU_KM), -1);
    expect(controller.targetExposure).toBe(EXPOSURE_MAX);
    expect(controller.exposure).toBe(EXPOSURE_MAX);
  });
});

describe('ExposureController adaptation', () => {
  it('closes 63.2 percent of the stop gap in 6 s going bright to dark', () => {
    const { controller } = createFixture();
    const earth = cameraAtHeliocentricKm(AU_KM);
    const neptune = cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM);
    controller.reset(earth, -1);
    expect(controller.exposure).toBeCloseTo(1, 9);

    const gapStops = Math.log2(EXPOSURE_MAX) - Math.log2(1);
    const constantExposure = Math.pow(2, Math.log2(1) + gapStops * (1 - Math.exp(-1)));
    const reachedSec = timeToReachSec(
      controller,
      neptune,
      -1,
      (exposure) => exposure >= constantExposure,
    );

    expect(reachedSec).toBeGreaterThan(EXPOSURE_TAU_BRIGHT_TO_DARK_SEC * 0.9);
    expect(reachedSec).toBeLessThan(EXPOSURE_TAU_BRIGHT_TO_DARK_SEC * 1.1);
  });

  it('closes 63.2 percent of the stop gap in 2 s going dark to bright', () => {
    const { controller } = createFixture();
    const neptune = cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM);
    const nearSun = cameraAtHeliocentricKm(NEAR_SUN_KM);
    controller.reset(neptune, -1);
    expect(controller.exposure).toBe(EXPOSURE_MAX);

    const gapStops = Math.log2(EXPOSURE_MIN) - Math.log2(EXPOSURE_MAX);
    const constantExposure = Math.pow(2, Math.log2(EXPOSURE_MAX) + gapStops * (1 - Math.exp(-1)));
    const reachedSec = timeToReachSec(
      controller,
      nearSun,
      -1,
      (exposure) => exposure <= constantExposure,
    );

    expect(reachedSec).toBeGreaterThan(EXPOSURE_TAU_DARK_TO_BRIGHT_SEC * 0.9);
    expect(reachedSec).toBeLessThan(EXPOSURE_TAU_DARK_TO_BRIGHT_SEC * 1.1);
  });

  it('converges on the target and publishes every frame', () => {
    const { controller, sink } = createFixture();
    const neptune = cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM);
    controller.reset(cameraAtHeliocentricKm(AU_KM), -1);
    sink.setExposure.mockClear();

    for (let step = 0; step < 60 * 40; step += 1) controller.update(1 / 60, neptune, -1);

    // Asymptotic, never overshooting: 40 s is 6.7 tau, leaving 0.005 of a stop.
    expect(controller.exposure).toBeLessThanOrEqual(EXPOSURE_MAX);
    expect(controller.exposure / EXPOSURE_MAX).toBeGreaterThan(0.99);
    expect(sink.setExposure).toHaveBeenCalledTimes(60 * 40);
    expect(sink.setExposure).toHaveBeenLastCalledWith(controller.exposure);
  });

  it('holds still for a zero delta and rejects a bad one', () => {
    const { controller } = createFixture();
    const earth = cameraAtHeliocentricKm(AU_KM);
    controller.reset(earth, -1);
    const before = controller.exposure;

    controller.update(0, cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM), -1);
    expect(controller.exposure).toBe(before);

    expect(() => controller.update(-1, earth, -1)).toThrow(/delta/iu);
    expect(() => controller.update(Number.NaN, earth, -1)).toThrow(/delta/iu);
  });
});

describe('ExposureController modes', () => {
  it('lets either the player setting or the governor pin fixed exposure', () => {
    const { controller } = createFixture();
    const neptune = cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM);

    expect(controller.mode).toBe('auto');
    controller.reset(neptune, -1);
    expect(controller.targetExposure).toBe(EXPOSURE_MAX);

    controller.setUserMode('fixed');
    expect(controller.mode).toBe('fixed');
    controller.reset(neptune, -1);
    expect(controller.targetExposure).toBe(FIXED_EXPOSURE);
    expect(controller.exposure).toBe(FIXED_EXPOSURE);

    controller.setUserMode('auto');
    controller.setGovernorMode('fixed');
    expect(controller.mode).toBe('fixed');
    controller.reset(neptune, -1);
    expect(controller.targetExposure).toBe(FIXED_EXPOSURE);

    // A player who wants auto cannot override a governed pin, and vice versa.
    controller.setUserMode('fixed');
    controller.setGovernorMode('auto');
    expect(controller.mode).toBe('fixed');

    controller.setUserMode('auto');
    expect(controller.mode).toBe('auto');
    controller.reset(neptune, -1);
    expect(controller.targetExposure).toBe(EXPOSURE_MAX);
  });

  it('ramps into a governed pin instead of flashing', () => {
    const { controller } = createFixture();
    const neptune = cameraAtHeliocentricKm(NEPTUNE_AU * AU_KM);
    controller.reset(neptune, -1);

    controller.setGovernorMode('fixed');
    controller.update(1 / 60, neptune, -1);
    expect(controller.exposure).toBeLessThan(EXPOSURE_MAX);
    expect(controller.exposure).toBeGreaterThan(FIXED_EXPOSURE);
  });

  it('rejects unknown modes and malformed catalogs', () => {
    const { controller } = createFixture();
    expect(() => controller.setUserMode('bright' as never)).toThrow(/exposure mode/iu);
    expect(() => controller.setGovernorMode('bright' as never)).toThrow(/exposure mode/iu);

    const sink = { setExposure: vi.fn() };
    expect(
      () =>
        new ExposureController({
          sink,
          positionsKm: new Float64Array(11),
          sunIndex: 0,
          bodyRadiiKm: Float64Array.from([1]),
          bodyGeometricAlbedos: Float64Array.from([1]),
        }),
    ).toThrow(/xyz/iu);
    expect(
      () =>
        new ExposureController({
          sink,
          positionsKm: new Float64Array(12),
          sunIndex: 4,
          bodyRadiiKm: Float64Array.from([1, 1, 1, 1]),
          bodyGeometricAlbedos: Float64Array.from([1, 1, 1, 1]),
        }),
    ).toThrow(/sun/iu);
    expect(
      () =>
        new ExposureController({
          sink,
          positionsKm: new Float64Array(12),
          sunIndex: 0,
          bodyRadiiKm: Float64Array.from([1, 1, 1, 1]),
          bodyGeometricAlbedos: Float64Array.from([1, 1, 1]),
        }),
    ).toThrow(/albedo/iu);
  });

  it('ignores a dominant body index outside the catalog', () => {
    const { controller } = createFixture();
    const camera = cameraAtHeliocentricKm(AU_KM);
    controller.reset(camera, -1);
    const solarOnly = controller.sceneLuminance;

    controller.update(0, camera, BODY_COUNT);
    expect(controller.sceneLuminance).toBe(solarOnly);
  });
});

describe('solarIlluminanceRatio', () => {
  it('is one solar constant at the Sun magnitude at 1 AU', () => {
    expect(solarIlluminanceRatio(SUN_MAGNITUDE_AT_ONE_AU)).toBeCloseTo(1, 12);
    expect(solarIlluminanceRatio(SUN_MAGNITUDE_AT_ONE_AU + 5)).toBeCloseTo(0.01, 12);
  });
});
