import { describe, expect, it } from 'vitest';

import saveV1Fixture from '../../tests/fixtures/save-v1.json';
import saveV2MidburnFixture from '../../tests/fixtures/save-v2-midburn.json';
import saveV2Fixture from '../../tests/fixtures/save-v2.json';
import { WarpClampReason } from '../sim/simulationSnapshot.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import {
  createBurnLog,
  DEFAULT_BURN_LOG_CAPACITY,
  SIMULATION_STATE_DIMENSION,
  type BurnLogEntry,
} from '../sim/ship/ledger.js';
import { relativisticKineticEnergyJ } from '../sim/ship/relativity.js';
import { DEFAULT_VESSEL } from '../sim/ship/vessel.js';
import {
  createSaveEnvelope,
  parseSaveEnvelope,
  SAVE_STORAGE_KEY,
  SaveRepository,
  serializeSaveEnvelope,
} from './saveLoad.js';
import {
  DEFAULT_GAME_SETTINGS,
  projectGameSettingsV1,
  rebindInput,
  type KeyValueStorage,
} from './settings.js';

function parseSave(text: string, bodyIds: readonly string[] = ['earth']) {
  return parseSaveEnvelope(text, bodyIds, DEFAULT_VESSEL);
}

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  getError: unknown = null;
  setError: unknown = null;

  getItem(key: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError !== null) throw this.setError;
    this.values.set(key, value);
  }
}

function burnEntry(overrides: Partial<BurnLogEntry> = {}): BurnLogEntry {
  return {
    startTimeSec: 1,
    endTimeSec: 2,
    startProperTimeSec: 1,
    endProperTimeSec: 2,
    energySpentJ: 10,
    properDeltaVMS: 3,
    peakPowerW: 5,
    dominantBodyId: 'earth',
    progradeDeltaVMS: 2,
    normalDeltaVMS: 1,
    radialDeltaVMS: 0,
    ...overrides,
  };
}

function persistentState(): SimulationPersistentState {
  const state = new Float64Array(SIMULATION_STATE_DIMENSION);
  state.set([100, 200, 300, 4, 5, 6, 7, 18, 12, 3, 2, 1]);
  return {
    simTimeSec: 42,
    vessel: DEFAULT_VESSEL,
    state,
    attitudeQuaternion: new Float64Array([0, 0, 0, 1]),
    throttle: 0.25,
    attitudeMode: 'prograde',
    rotationRatesRadS: new Float64Array([0.1, 0.2, 0.3]),
    requestedWarp: 5,
    effectiveWarp: 5,
    warpClampReason: WarpClampReason.NONE,
    targetBodyId: 'earth',
    initialKineticEnergyJ: 123,
    burnLog: {
      capacity: DEFAULT_BURN_LOG_CAPACITY,
      entries: [burnEntry()],
      active: {
        entry: burnEntry({
          startTimeSec: 3,
          endTimeSec: 42,
          startProperTimeSec: 3,
          endProperTimeSec: 7,
        }),
        startEnergyJ: 8,
        startProperDeltaVMS: 9,
        startVectorMS: new Float64Array([1, 1, 1]),
        progradeBasis: new Float64Array([1, 0, 0]),
        normalBasis: new Float64Array([0, 1, 0]),
        radialBasis: new Float64Array([0, 0, 1]),
      },
    },
  };
}

describe('save envelope', () => {
  it('round-trips v3 through JSON without serializing rails body arrays', () => {
    const settings = projectGameSettingsV1(rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI'));
    const envelope = createSaveEnvelope(persistentState(), settings, ['earth']);

    const json = serializeSaveEnvelope(envelope);
    const restored = parseSave(json);

    expect(restored).toEqual(envelope);
    expect(json).not.toContain('bodyPositionsKm');
    expect(json).not.toContain('bodyVelocitiesKmS');
  });

  it('carries the vessel through the v3 document and back (ADR-034)', () => {
    const vessel = {
      restMassKg: 12_500,
      alphaMaxMS2: 147.09975,
      alphaManualMaxMS2: 29.41995,
      maxSlewRadPerSimS: 0.5,
    };

    const json = serializeSaveEnvelope(
      createSaveEnvelope(
        { ...persistentState(), vessel },
        projectGameSettingsV1(DEFAULT_GAME_SETTINGS),
        ['earth'],
      ),
    );
    const document = JSON.parse(json) as { version: number; simulation: Record<string, unknown> };

    expect(document.version).toBe(3);
    expect(document.simulation.vessel).toEqual(vessel);
    expect(parseSave(json).simulation.vessel).toEqual(vessel);
  });

  it('migrates the committed v2 fixture to v3 by adopting the running vessel', () => {
    const migrated = parseSaveEnvelope(
      JSON.stringify(saveV2Fixture),
      ['earth', 'mars'],
      DEFAULT_VESSEL,
    );

    expect(migrated.version).toBe(3);
    expect(migrated.phase).toBe('space');
    expect(migrated.simulation.vessel).toEqual(DEFAULT_VESSEL);
    // Everything the v2 document already carried survives untouched.
    expect([...migrated.simulation.state]).toEqual(saveV2Fixture.simulation.state);
    expect(migrated.simulation.simTimeSec).toBe(saveV2Fixture.simulation.simTimeSec);
    expect(migrated.simulation.targetBodyId).toBe('mars');
    expect(migrated.simulation.requestedWarp).toBe(10);
    expect(migrated.simulation.initialKineticEnergyJ).toBe(
      saveV2Fixture.simulation.initialKineticEnergyJ,
    );
    expect(migrated.simulation.burnLog.entries).toEqual(saveV2Fixture.simulation.burnLog.entries);
    // T0108 appended seven input actions. A document written before they existed
    // is backfilled from the defaults, never rejected: `parseGameSettings` is on
    // the critical path of every save load, so rejecting would have made this
    // committed fixture — and every real pre-T0108 save — unloadable.
    expect(migrated.settings).toMatchObject(saveV2Fixture.settings);
    expect(migrated.settings.inputBindings).toEqual(DEFAULT_GAME_SETTINGS.inputBindings);
  });

  it('migrates a mid-burn v2 fixture with its active burn and ledger intact', () => {
    const bodyIds = saveV2MidburnFixture.simulation.burnLog.active.entry.dominantBodyId;
    const migrated = parseSaveEnvelope(
      JSON.stringify(saveV2MidburnFixture),
      [bodyIds, 'mars'],
      DEFAULT_VESSEL,
    );
    const active = migrated.simulation.burnLog.active;

    expect(migrated.simulation.throttle).toBe(0.6);
    expect(active).not.toBeNull();
    expect(active?.entry.energySpentJ).toBe(
      saveV2MidburnFixture.simulation.burnLog.active.entry.energySpentJ,
    );
    expect(active?.entry.peakPowerW).toBe(
      saveV2MidburnFixture.simulation.burnLog.active.entry.peakPowerW,
    );
    expect(migrated.simulation.vessel).toEqual(DEFAULT_VESSEL);
  });

  it('refuses to re-price a legacy ledger under a different rest mass', () => {
    // Regression: a mid-burn v2 document keeps a 10 t-priced burn log while the
    // restored continuation would be priced at the new mass, and nothing
    // downstream can detect it — validateActiveBurnConsistency compares the burn
    // log against state-vector deltas from the same document, so it is
    // mass-independent by construction. Migration must fail closed (ADR-034).
    const heavyVessel = { ...DEFAULT_VESSEL, restMassKg: 42_000 };

    expect(() =>
      parseSaveEnvelope(JSON.stringify(saveV2MidburnFixture), ['earth', 'mars'], heavyVessel),
    ).toThrow(/save v2 migration requires a 10000 kg vessel/u);
    expect(() =>
      parseSaveEnvelope(JSON.stringify(saveV2Fixture), ['earth', 'mars'], heavyVessel),
    ).toThrow(/cannot be re-priced at 42000 kg/u);
    expect(() => parseSaveEnvelope(JSON.stringify(saveV1Fixture), ['earth'], heavyVessel)).toThrow(
      /save v1 migration requires a 10000 kg vessel/u,
    );

    // Drive limits and slew rate are absent from the ledger, so they may differ.
    const rebuiltDrive = { ...DEFAULT_VESSEL, alphaMaxMS2: 300, alphaManualMaxMS2: 5 };
    expect(
      parseSaveEnvelope(JSON.stringify(saveV2Fixture), ['earth', 'mars'], rebuiltDrive).simulation
        .vessel,
    ).toEqual(rebuiltDrive);
  });

  it('rejects a v2 document whose version field disagrees with its dispatch', () => {
    const mislabelled = structuredClone(saveV2Fixture) as Record<string, unknown>;
    mislabelled.version = 2.0000001;
    expect(() => parseSave(JSON.stringify(mislabelled), ['earth', 'mars'])).toThrow(
      /save version is not supported/u,
    );
  });

  it('rejects a negative kinetic-energy baseline', () => {
    const negative = structuredClone(saveV2Fixture) as Record<string, unknown>;
    (negative.simulation as Record<string, unknown>).initialKineticEnergyJ = -1;
    expect(() => parseSave(JSON.stringify(negative), ['earth', 'mars'])).toThrow(
      /kinetic-energy baseline must be finite and non-negative/u,
    );
  });

  it('rejects a v2 document that already carries a vessel and a v3 document missing one', () => {
    const v2WithVessel = structuredClone(saveV2Fixture) as Record<string, unknown>;
    (v2WithVessel.simulation as Record<string, unknown>).vessel = DEFAULT_VESSEL;
    expect(() => parseSave(JSON.stringify(v2WithVessel), ['earth', 'mars'])).toThrow(
      /unknown field vessel/u,
    );

    const v3WithoutVessel = JSON.parse(
      serializeSaveEnvelope(
        createSaveEnvelope(persistentState(), projectGameSettingsV1(DEFAULT_GAME_SETTINGS), [
          'earth',
        ]),
      ),
    ) as Record<string, unknown>;
    delete (v3WithoutVessel.simulation as Record<string, unknown>).vessel;
    expect(() => parseSave(JSON.stringify(v3WithoutVessel))).toThrow(
      /simulation\.vessel is missing/u,
    );
  });

  it('rejects an out-of-range vessel in an untrusted v3 document', () => {
    const document = JSON.parse(
      serializeSaveEnvelope(
        createSaveEnvelope(persistentState(), projectGameSettingsV1(DEFAULT_GAME_SETTINGS), [
          'earth',
        ]),
      ),
    ) as Record<string, unknown>;
    const simulation = document.simulation as Record<string, unknown>;

    const zeroMass = structuredClone(document);
    (
      (zeroMass.simulation as Record<string, unknown>).vessel as Record<string, unknown>
    ).restMassKg = 0;
    expect(() => parseSave(JSON.stringify(zeroMass))).toThrow(/rest mass/u);

    const manualAboveLimit = structuredClone(document);
    (
      (manualAboveLimit.simulation as Record<string, unknown>).vessel as Record<string, unknown>
    ).alphaManualMaxMS2 = 1_000;
    expect(() => parseSave(JSON.stringify(manualAboveLimit))).toThrow(/must not exceed/u);

    const unknownField = structuredClone(document);
    (
      (unknownField.simulation as Record<string, unknown>).vessel as Record<string, unknown>
    ).rcsAuthority = 1;
    expect(() => parseSave(JSON.stringify(unknownField))).toThrow(/unknown field rcsAuthority/u);

    expect(simulation.vessel).toEqual(DEFAULT_VESSEL);
  });

  it('keeps save v3 settings as the v1 preferences DTO without tutorial state', () => {
    const profile = {
      ...DEFAULT_GAME_SETTINGS,
      tutorial: { status: 'active' as const, stepId: 'warp' as const },
    };

    const json = serializeSaveEnvelope(
      createSaveEnvelope(persistentState(), projectGameSettingsV1(profile), ['earth']),
    );
    const document = JSON.parse(json) as { settings: Record<string, unknown> };

    expect(document.settings.version).toBe(1);
    expect(document.settings).not.toHaveProperty('tutorial');
  });

  it('accepts a normalized burn frame where prograde has a radial component', () => {
    const source = persistentState();
    const active = source.burnLog.active;
    if (active === null) throw new Error('test save has no active burn');
    const invSqrtTwo = 1 / Math.sqrt(2);
    const envelope = createSaveEnvelope(
      {
        ...source,
        burnLog: {
          ...source.burnLog,
          active: {
            ...active,
            entry: {
              ...active.entry,
              progradeDeltaVMS: 3 * invSqrtTwo,
              normalDeltaVMS: 0,
              radialDeltaVMS: 2,
            },
            progradeBasis: new Float64Array([invSqrtTwo, invSqrtTwo, 0]),
            normalBasis: new Float64Array([0, 0, 1]),
            radialBasis: new Float64Array([1, 0, 0]),
          },
        },
      },
      projectGameSettingsV1(DEFAULT_GAME_SETTINGS),
      ['earth'],
    );

    expect(envelope.simulation.burnLog.active?.entry.radialDeltaVMS).toBe(2);
  });

  it('migrates the committed v1 fixture into the exact v3 state layout', () => {
    const migrated = parseSaveEnvelope(JSON.stringify(saveV1Fixture), ['earth'], DEFAULT_VESSEL);

    expect(migrated.version).toBe(3);
    expect(migrated.phase).toBe('space');
    expect(migrated.simulation.vessel).toEqual(DEFAULT_VESSEL);
    expect(migrated.settings.qualityLock).toBe('medium');
    expect([...migrated.simulation.state]).toEqual([
      ...saveV1Fixture.shipState,
      saveV1Fixture.ledger.energySpentJ,
      saveV1Fixture.ledger.properDeltaVMS,
      0,
      0,
      0,
    ]);
    expect(migrated.simulation.simTimeSec).toBe(86400);
    expect(migrated.simulation.attitudeQuaternion).toEqual(new Float64Array([0, 0, 0, 1]));
    expect(migrated.simulation.requestedWarp).toBe(1);
    expect(migrated.simulation.burnLog.entries).toEqual(saveV1Fixture.burnLog);
    expect(migrated.simulation.initialKineticEnergyJ).toBe(
      relativisticKineticEnergyJ(
        saveV1Fixture.shipState[3] as number,
        saveV1Fixture.shipState[4] as number,
        saveV1Fixture.shipState[5] as number,
        DEFAULT_VESSEL.restMassKg,
      ),
    );
  });

  it('rejects oversized v1 burn history before materializing migrated entries', () => {
    const oversizedV1 = structuredClone(saveV1Fixture);
    const entry = saveV1Fixture.burnLog[0];
    if (entry === undefined) throw new Error('v1 fixture has no burn entry');
    oversizedV1.burnLog = Array.from({ length: DEFAULT_BURN_LOG_CAPACITY + 1 }, () => ({
      ...entry,
    }));

    expect(() => parseSave(JSON.stringify(oversizedV1))).toThrow(
      /save v1 burn log entries exceed capacity/u,
    );
  });

  it('rejects malformed JSON, unknown versions, invalid numbers, targets, and burns', () => {
    expect(() => parseSave('{bad')).toThrow(/parse save JSON/u);
    expect(() => parseSave('{"version":99}')).toThrow(/version/u);

    const valid = JSON.parse(
      serializeSaveEnvelope(
        createSaveEnvelope(persistentState(), projectGameSettingsV1(DEFAULT_GAME_SETTINGS), [
          'earth',
        ]),
      ),
    ) as Record<string, unknown>;
    const invalidNumber = structuredClone(valid);
    ((invalidNumber.simulation as Record<string, unknown>).state as unknown[])[0] = null;
    expect(() => parseSave(JSON.stringify(invalidNumber))).toThrow(/state\[0\]/u);

    const invalidTarget = structuredClone(valid);
    (invalidTarget.simulation as Record<string, unknown>).targetBodyId = 'mars';
    expect(() => parseSave(JSON.stringify(invalidTarget))).toThrow(/target/u);

    const invalidBurn = structuredClone(valid);
    const burnLog = (invalidBurn.simulation as Record<string, unknown>).burnLog as Record<
      string,
      unknown
    >;
    const firstBurn = (burnLog.entries as Array<Record<string, unknown>>)[0];
    if (firstBurn === undefined) throw new Error('test save has no burn entry');
    firstBurn.dominantBodyId = 'mars';
    expect(() => parseSave(JSON.stringify(invalidBurn))).toThrow(/burn log body/u);

    const oversizedCapacity = structuredClone(valid);
    (
      (oversizedCapacity.simulation as Record<string, unknown>).burnLog as Record<string, unknown>
    ).capacity = 10_000;
    expect(() => parseSave(JSON.stringify(oversizedCapacity))).toThrow(/burn log capacity/u);

    const tooManyEntries = structuredClone(valid);
    const tooManyBurnLog = (tooManyEntries.simulation as Record<string, unknown>).burnLog as Record<
      string,
      unknown
    >;
    tooManyBurnLog.entries = Array.from({ length: DEFAULT_BURN_LOG_CAPACITY + 1 }, () =>
      burnEntry(),
    );
    expect(() => parseSave(JSON.stringify(tooManyEntries))).toThrow(/entries exceed capacity/u);

    const inactiveThrottle = structuredClone(valid);
    (inactiveThrottle.simulation as Record<string, unknown>).throttle = 0;
    expect(() => parseSave(JSON.stringify(inactiveThrottle))).toThrow(/throttle and active burn/u);

    const inconsistentActiveBurn = structuredClone(valid);
    const inconsistentBurnLog = (inconsistentActiveBurn.simulation as Record<string, unknown>)
      .burnLog as Record<string, unknown>;
    (
      (inconsistentBurnLog.active as Record<string, unknown>).entry as Record<string, unknown>
    ).energySpentJ = 9;
    expect(() => parseSave(JSON.stringify(inconsistentActiveBurn))).toThrow(/active burn ledger/u);

    const invalidBasis = structuredClone(valid);
    const invalidBasisBurnLog = (invalidBasis.simulation as Record<string, unknown>)
      .burnLog as Record<string, unknown>;
    (invalidBasisBurnLog.active as Record<string, unknown>).normalBasis = [1, 0, 0];
    expect(() => parseSave(JSON.stringify(invalidBasis))).toThrow(/normalized orbital frame/u);
  });

  it('distinguishes a missing slot from invalid or unavailable storage', () => {
    const storage = new MemoryStorage();
    const repository = new SaveRepository(storage, DEFAULT_VESSEL);

    expect(repository.load(['earth'])).toEqual({ ok: false, reason: 'not-found' });
    storage.values.set(SAVE_STORAGE_KEY, '{bad');
    expect(repository.load(['earth'])).toMatchObject({ ok: false, reason: 'invalid' });
    storage.getError = new Error('denied');
    expect(repository.load(['earth'])).toMatchObject({ ok: false, reason: 'storage' });
  });

  it('round-trips localStorage and reports write failures', () => {
    const storage = new MemoryStorage();
    const repository = new SaveRepository(storage, DEFAULT_VESSEL);
    const envelope = createSaveEnvelope(
      persistentState(),
      projectGameSettingsV1(DEFAULT_GAME_SETTINGS),
      ['earth'],
    );

    expect(repository.save(envelope)).toEqual({ ok: true });
    expect(repository.load(['earth'])).toEqual({ ok: true, envelope });
    storage.setError = new Error('quota');
    expect(repository.save(envelope)).toMatchObject({ ok: false });
  });

  it('does not rely on the burn-log factory accepting malformed public JSON', () => {
    const empty = createBurnLog().persistence.exportState();
    expect(empty.entries).toEqual([]);
  });
});
