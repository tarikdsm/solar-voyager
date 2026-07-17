import { describe, expect, it } from 'vitest';

import saveV1Fixture from '../../tests/fixtures/save-v1.json';
import { WarpClampReason } from '../sim/simulationSnapshot.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import {
  createBurnLog,
  SIMULATION_STATE_DIMENSION,
  type BurnLogEntry,
} from '../sim/ship/ledger.js';
import {
  createSaveEnvelope,
  parseSaveEnvelope,
  SAVE_STORAGE_KEY,
  SaveRepository,
  serializeSaveEnvelope,
} from './saveLoad.js';
import { DEFAULT_GAME_SETTINGS, rebindInput, type KeyValueStorage } from './settings.js';

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
  state.set([100, 200, 300, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  return {
    simTimeSec: 42,
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
      capacity: 4,
      entries: [burnEntry()],
      active: {
        entry: burnEntry({ startTimeSec: 3, endTimeSec: 4 }),
        startEnergyJ: 8,
        startProperDeltaVMS: 2,
        startVectorMS: new Float64Array([1, 2, 3]),
        progradeBasis: new Float64Array([1, 0, 0]),
        normalBasis: new Float64Array([0, 1, 0]),
        radialBasis: new Float64Array([0, 0, 1]),
      },
    },
  };
}

describe('save envelope', () => {
  it('round-trips v2 through JSON without serializing rails body arrays', () => {
    const settings = rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI');
    const envelope = createSaveEnvelope(persistentState(), settings, ['earth']);

    const json = serializeSaveEnvelope(envelope);
    const restored = parseSaveEnvelope(json, ['earth']);

    expect(restored).toEqual(envelope);
    expect(json).not.toContain('bodyPositionsKm');
    expect(json).not.toContain('bodyVelocitiesKmS');
  });

  it('migrates the committed v1 fixture into the exact v2 state layout', () => {
    const migrated = parseSaveEnvelope(JSON.stringify(saveV1Fixture), ['earth']);

    expect(migrated.version).toBe(2);
    expect(migrated.phase).toBe('space');
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
  });

  it('rejects malformed JSON, unknown versions, invalid numbers, targets, and burns', () => {
    expect(() => parseSaveEnvelope('{bad', ['earth'])).toThrow(/parse save JSON/u);
    expect(() => parseSaveEnvelope('{"version":99}', ['earth'])).toThrow(/version/u);

    const valid = JSON.parse(
      serializeSaveEnvelope(
        createSaveEnvelope(persistentState(), DEFAULT_GAME_SETTINGS, ['earth']),
      ),
    ) as Record<string, unknown>;
    const invalidNumber = structuredClone(valid);
    ((invalidNumber.simulation as Record<string, unknown>).state as unknown[])[0] = null;
    expect(() => parseSaveEnvelope(JSON.stringify(invalidNumber), ['earth'])).toThrow(
      /state\[0\]/u,
    );

    const invalidTarget = structuredClone(valid);
    (invalidTarget.simulation as Record<string, unknown>).targetBodyId = 'mars';
    expect(() => parseSaveEnvelope(JSON.stringify(invalidTarget), ['earth'])).toThrow(/target/u);

    const invalidBurn = structuredClone(valid);
    const burnLog = (invalidBurn.simulation as Record<string, unknown>).burnLog as Record<
      string,
      unknown
    >;
    const firstBurn = (burnLog.entries as Array<Record<string, unknown>>)[0];
    if (firstBurn === undefined) throw new Error('test save has no burn entry');
    firstBurn.dominantBodyId = 'mars';
    expect(() => parseSaveEnvelope(JSON.stringify(invalidBurn), ['earth'])).toThrow(
      /burn log body/u,
    );
  });

  it('distinguishes a missing slot from invalid or unavailable storage', () => {
    const storage = new MemoryStorage();
    const repository = new SaveRepository(storage);

    expect(repository.load(['earth'])).toEqual({ ok: false, reason: 'not-found' });
    storage.values.set(SAVE_STORAGE_KEY, '{bad');
    expect(repository.load(['earth'])).toMatchObject({ ok: false, reason: 'invalid' });
    storage.getError = new Error('denied');
    expect(repository.load(['earth'])).toMatchObject({ ok: false, reason: 'storage' });
  });

  it('round-trips localStorage and reports write failures', () => {
    const storage = new MemoryStorage();
    const repository = new SaveRepository(storage);
    const envelope = createSaveEnvelope(persistentState(), DEFAULT_GAME_SETTINGS, ['earth']);

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
