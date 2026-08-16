import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import bodiesDocument from '../../data/bodies.json';
import {
  BodySpin,
  bodySpinAngleRad,
  EARTH_PRIME_MERIDIAN_EPOCH_RAD,
  primeMeridianEpochRad,
  writeBodyAttitudeInto,
  writeBodyFrameVectorInto,
  writeBodyPoleInto,
  writeEquatorFrameVectorInto,
  type BodySpinDefinition,
} from './bodySpin.js';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
} from '../sim/propagation/rails.js';

const RAD_TO_DEG = 180 / Math.PI;
const EARTH_TILT_RAD = 0.409_092_627_750_149_04;
const EARTH_SIDEREAL_SEC = 86_164.100_352;

/**
 * Independent reference values for 2026-01-01T00:00:00 UT (JD 2461041.5), from
 * the USNO low-precision solar coordinates and GMST short form. They are NOT
 * derived from `bodySpin.ts`; only the epoch is shared.
 */
const REFERENCE_SUBSOLAR_LONGITUDE_DEG = -179.167_203;
const REFERENCE_SUBSOLAR_LATITUDE_DEG = -23.014_614;

function definitionsFromCatalog(): BodySpinDefinition[] {
  return bodiesDocument.bodies.map((body) => ({
    id: body.id,
    siderealRotationPeriodSec: body.siderealRotationPeriodSec,
    axialTiltRad: body.axialTiltRad,
  }));
}

function railsPositionsAt(simTimeSec: number): Float64Array {
  const catalog = compileRailsCatalog(bodiesDocument.bodies);
  const state = createRailsState(catalog);
  evaluateRailsInto(state, catalog, simTimeSec, createRailsWorkspace());
  return state.positionsKm;
}

function bodyIndex(id: string): number {
  const index = bodiesDocument.bodies.findIndex((body) => body.id === id);
  if (index < 0) throw new Error(`Unknown catalog body ${id}.`);
  return index;
}

/** Sub-solar longitude/latitude in the body-fixed frame, degrees, east-positive. */
function subSolarDegrees(
  simTimeSec: number,
  id: string,
): { longitudeDeg: number; latitudeDeg: number } {
  const positionsKm = railsPositionsAt(simTimeSec);
  const body = bodiesDocument.bodies[bodyIndex(id)];
  if (body === undefined) throw new Error('Catalog body is missing.');
  const bodyOffset = bodyIndex(id) * 3;
  const sunOffset = bodyIndex('sun') * 3;
  const sunX = (positionsKm[sunOffset] as number) - (positionsKm[bodyOffset] as number);
  const sunY = (positionsKm[sunOffset + 1] as number) - (positionsKm[bodyOffset + 1] as number);
  const sunZ = (positionsKm[sunOffset + 2] as number) - (positionsKm[bodyOffset + 2] as number);
  const scratch = new Float64Array(3);
  writeBodyFrameVectorInto(
    scratch,
    sunX,
    sunY,
    sunZ,
    body.axialTiltRad,
    bodySpinAngleRad(simTimeSec, body.siderealRotationPeriodSec, primeMeridianEpochRad(id)),
  );
  const x = scratch[0] as number;
  const y = scratch[1] as number;
  const z = scratch[2] as number;
  const length = Math.hypot(x, y, z);
  return {
    longitudeDeg: Math.atan2(-z, x) * RAD_TO_DEG,
    latitudeDeg: Math.asin(y / length) * RAD_TO_DEG,
  };
}

describe('body spin geometry', () => {
  it('carries the model pole to the tilted world axis and keeps the spin about it', () => {
    const attitude = new Float64Array(4);
    const pole = new Float64Array(3);
    const quaternion = new Quaternion();
    const modelPole = new Vector3();

    for (const tiltRad of [0, 0.1, EARTH_TILT_RAD, Math.PI / 2, 2.138]) {
      writeBodyPoleInto(pole, 0, tiltRad);
      expect(pole[0]).toBeCloseTo(0, 12);
      expect(pole[1]).toBeCloseTo(Math.sin(tiltRad), 12);
      expect(pole[2]).toBeCloseTo(Math.cos(tiltRad), 12);

      for (const spinRad of [0, 1.2, -2.7, Math.PI]) {
        writeBodyAttitudeInto(attitude, 0, tiltRad, spinRad);
        quaternion.set(
          attitude[0] as number,
          attitude[1] as number,
          attitude[2] as number,
          attitude[3] as number,
        );
        expect(quaternion.length()).toBeCloseTo(1, 12);
        // The spin axis is invariant: the model pole always lands on the world pole.
        modelPole.set(0, 1, 0).applyQuaternion(quaternion);
        expect(modelPole.x).toBeCloseTo(pole[0] as number, 12);
        expect(modelPole.y).toBeCloseTo(pole[1] as number, 12);
        expect(modelPole.z).toBeCloseTo(pole[2] as number, 12);
      }
    }
  });

  it('inverts the attitude exactly in the equatorial and body-fixed vector helpers', () => {
    const attitude = new Float64Array(4);
    const scratch = new Float64Array(3);
    const quaternion = new Quaternion();
    const world = new Vector3(3, -4, 12);
    const tiltRad = 0.4665;
    const spinRad = 1.3;

    writeBodyAttitudeInto(attitude, 0, tiltRad, spinRad);
    quaternion.set(
      attitude[0] as number,
      attitude[1] as number,
      attitude[2] as number,
      attitude[3] as number,
    );
    const expected = world.clone().applyQuaternion(quaternion.clone().invert());
    writeBodyFrameVectorInto(scratch, world.x, world.y, world.z, tiltRad, spinRad);
    expect(scratch[0]).toBeCloseTo(expected.x, 10);
    expect(scratch[1]).toBeCloseTo(expected.y, 10);
    expect(scratch[2]).toBeCloseTo(expected.z, 10);

    // The equatorial frame is the same rotation with the spin removed.
    writeEquatorFrameVectorInto(scratch, world.x, world.y, world.z, tiltRad);
    const equatorial = new Float64Array(3);
    writeBodyFrameVectorInto(equatorial, world.x, world.y, world.z, tiltRad, 0);
    expect(scratch[0]).toBeCloseTo(equatorial[0] as number, 12);
    expect(scratch[1]).toBeCloseTo(equatorial[1] as number, 12);
    expect(scratch[2]).toBeCloseTo(equatorial[2] as number, 12);
  });

  it('turns once per signed sidereal period and stays bounded over long sessions', () => {
    const period = 86_164.100_352;
    expect(bodySpinAngleRad(0, period)).toBe(0);
    expect(bodySpinAngleRad(period / 4, period)).toBeCloseTo(Math.PI / 2, 12);
    expect(bodySpinAngleRad(period * 10_001.25, period)).toBeCloseTo(Math.PI / 2, 8);
    // Signed period: negative means retrograde about the declared pole.
    expect(bodySpinAngleRad(period / 4, -period)).toBeCloseTo(-Math.PI / 2, 12);
    expect(bodySpinAngleRad(period * 10_001.25, -period)).toBeCloseTo(-Math.PI / 2, 8);
    // The epoch phase is an additive anchor, not a rate change.
    expect(bodySpinAngleRad(period / 4, period, 0.5)).toBeCloseTo(Math.PI / 2 + 0.5, 12);
    expect(() => bodySpinAngleRad(0, 0)).toThrow(/period/iu);
    expect(() => bodySpinAngleRad(Number.NaN, period)).toThrow(/finite/iu);
  });

  it("anchors Earth's prime meridian to the epoch Greenwich sidereal angle", () => {
    expect(primeMeridianEpochRad('earth')).toBe(EARTH_PRIME_MERIDIAN_EPOCH_RAD);
    expect(EARTH_PRIME_MERIDIAN_EPOCH_RAD * RAD_TO_DEG).toBeCloseTo(100.660_859, 4);
    expect(primeMeridianEpochRad('mars')).toBe(0);
    expect(primeMeridianEpochRad('io')).toBe(0);
  });

  it('places the epoch sub-solar point within one degree of the published position', () => {
    const subSolar = subSolarDegrees(0, 'earth');

    expect(Math.abs(subSolar.longitudeDeg - REFERENCE_SUBSOLAR_LONGITUDE_DEG)).toBeLessThan(1);
    expect(Math.abs(subSolar.latitudeDeg - REFERENCE_SUBSOLAR_LATITUDE_DEG)).toBeLessThan(1);
  });

  it('reproduces the solstices, which is what pins the tilt direction', () => {
    // 2026 June solstice is 2026-06-21T08:24 UT; December solstice 2026-12-21T20:50 UT.
    const juneSolsticeSec = 171 * 86_400 + 8.4 * 3_600;
    const decemberSolsticeSec = 354 * 86_400 + 20.8 * 3_600;

    expect(subSolarDegrees(juneSolsticeSec, 'earth').latitudeDeg).toBeCloseTo(23.44, 1);
    expect(subSolarDegrees(decemberSolsticeSec, 'earth').latitudeDeg).toBeCloseTo(-23.44, 1);
  });

  it('advances the sub-solar longitude by one solar day, not one sidereal day', () => {
    const atEpoch = subSolarDegrees(0, 'earth').longitudeDeg;
    const afterSolarDay = subSolarDegrees(86_400, 'earth').longitudeDeg;
    const afterSiderealDay = subSolarDegrees(EARTH_SIDEREAL_SEC, 'earth').longitudeDeg;

    expect(Math.abs(afterSolarDay - atEpoch)).toBeLessThan(0.5);
    expect(Math.abs(afterSiderealDay - atEpoch)).toBeGreaterThan(0.7);
  });

  it('keeps ellipsoid normals exact under the tier-2 oblate scale', () => {
    // Object-space non-uniform scale plus three.js' inverse-transpose normal
    // matrix must reproduce the analytic normal of x^2/a^2 + y^2/b^2 + z^2/a^2 = 1.
    const polarRatio = 0.902_037_565_540_585_3;
    const equatorialKm = 60_268;
    const attitude = new Float64Array(4);
    writeBodyAttitudeInto(attitude, 0, 0.4665, 1.1);
    const quaternion = new Quaternion(
      attitude[0] as number,
      attitude[1] as number,
      attitude[2] as number,
      attitude[3] as number,
    );
    const model = new Matrix4().compose(
      new Vector3(1_000, -2_000, 500),
      quaternion,
      new Vector3(equatorialKm, equatorialKm * polarRatio, equatorialKm),
    );
    const normalMatrix = new Matrix3().getNormalMatrix(model);

    for (const surface of [
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0.5, 0.6, -0.62449979983983983).normalize(),
      new Vector3(-0.3, -0.8, 0.5196152422706632).normalize(),
    ]) {
      const shaded = surface.clone().applyMatrix3(normalMatrix).normalize();
      const analytic = new Vector3(
        surface.x / equatorialKm,
        surface.y / (equatorialKm * polarRatio),
        surface.z / equatorialKm,
      )
        .normalize()
        .applyQuaternion(quaternion);
      expect(shaded.dot(analytic)).toBeCloseTo(1, 10);
    }
  });
});

describe('BodySpin', () => {
  it('publishes one preallocated quaternion per catalog body', () => {
    const definitions = definitionsFromCatalog();
    const spin = new BodySpin(definitions);

    expect(definitions.length).toBe(43);
    expect(spin.count).toBe(43);
    expect(spin.attitudesXyzw.length).toBe(43 * 4);
    expect(spin.spinAnglesRad.length).toBe(43);

    const attitudes = spin.attitudesXyzw;
    const angles = spin.spinAnglesRad;
    spin.update(0);
    spin.update(12_345.5);
    expect(spin.attitudesXyzw).toBe(attitudes);
    expect(spin.spinAnglesRad).toBe(angles);
  });

  it('matches the standalone helpers for every catalog body and is deterministic', () => {
    const definitions = definitionsFromCatalog();
    const spin = new BodySpin(definitions);
    const expected = new Float64Array(4);
    const simTimeSec = 987_654.25;

    spin.update(simTimeSec);
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index] as BodySpinDefinition;
      const angle = bodySpinAngleRad(
        simTimeSec,
        definition.siderealRotationPeriodSec,
        primeMeridianEpochRad(definition.id),
      );
      expect(spin.spinAngleRadAt(index)).toBeCloseTo(angle, 12);
      writeBodyAttitudeInto(expected, 0, definition.axialTiltRad, angle);
      for (let component = 0; component < 4; component += 1) {
        expect(spin.attitudesXyzw[index * 4 + component]).toBeCloseTo(
          expected[component] as number,
          12,
        );
      }
    }

    const first = spin.attitudesXyzw.slice();
    spin.update(0);
    spin.update(simTimeSec);
    expect(Array.from(spin.attitudesXyzw)).toEqual(Array.from(first));
  });

  it('freezes when simulation time does not advance and rejects invalid input', () => {
    const spin = new BodySpin([
      { id: 'earth', siderealRotationPeriodSec: EARTH_SIDEREAL_SEC, axialTiltRad: EARTH_TILT_RAD },
    ]);

    spin.update(1_000);
    const frozen = spin.attitudesXyzw.slice();
    spin.update(1_000);
    expect(Array.from(spin.attitudesXyzw)).toEqual(Array.from(frozen));
    spin.update(1_100);
    expect(Array.from(spin.attitudesXyzw)).not.toEqual(Array.from(frozen));

    expect(() => spin.update(Number.NaN)).toThrow(/finite/iu);
    expect(() => new BodySpin([])).toThrow(/at least one/iu);
    expect(
      () => new BodySpin([{ id: 'x', siderealRotationPeriodSec: 0, axialTiltRad: 0 }]),
    ).toThrow(/period/iu);
    expect(
      () => new BodySpin([{ id: 'x', siderealRotationPeriodSec: 10, axialTiltRad: -1 }]),
    ).toThrow(/tilt/iu);
  });
});
