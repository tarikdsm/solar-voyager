import { describe, expect, it } from 'vitest';

import { WarningFlag, type SimSnapshot } from '../../sim/simulationSnapshot.js';
import { DEFAULT_AUDIO_SETTINGS } from '../settings.js';
import type { AudioBodyClass } from './audioDirector.js';
import { AudioSystem } from './audioSystem.js';

const BODY_CLASSES: readonly AudioBodyClass[] = Object.freeze(['star', 'giant', 'terrestrial']);
const FRAME_SEC = 1 / 60;

function createSnapshot(overrides: Partial<SimSnapshot> = {}): SimSnapshot {
  return {
    throttle: 0,
    gamma: 1,
    effectiveWarp: 1,
    dominantBodyIndex: -1,
    warningFlags: WarningFlag.NONE,
    impactOccurred: 0,
    ...overrides,
  } as unknown as SimSnapshot;
}

function createSystem(): { system: AudioSystem; contexts: number } {
  const created = { count: 0 };
  const system = new AudioSystem({
    bodyClasses: BODY_CLASSES,
    levels: DEFAULT_AUDIO_SETTINGS,
    createContext: () => {
      created.count += 1;
      throw new Error('the tests that need a real graph live in audioEngine.test.ts');
    },
  });
  return { system, contexts: created.count };
}

describe('AudioSystem', () => {
  it('decides every frame without ever touching the browser before a gesture', () => {
    const { system } = createSystem();
    // Long enough for the 4 s opening crossfade to complete.
    for (let index = 0; index < 300; index += 1) {
      system.update(createSnapshot({ throttle: 1 }), 'chase', false, FRAME_SEC);
    }
    expect(system.engine.unlocked).toBe(false);
    expect(system.engine.contextCreationCount).toBe(0);
    expect(system.engine.paramWriteCount).toBe(0);
    // The decisions ran anyway: the hum is at full lever and the score has faded in.
    expect(system.mix.engineGain).toBeCloseTo(1, 10);
    expect(system.mix.musicLayerGains[0]).toBeCloseTo(1, 6);
  });

  it('exposes one stable mix object', () => {
    const { system } = createSystem();
    const mix = system.mix;
    system.update(createSnapshot(), 'chase', false, FRAME_SEC);
    expect(system.mix).toBe(mix);
    expect(system.mix).toBe(system.director.state);
  });

  it('routes level changes to the director', () => {
    const { system } = createSystem();
    system.setLevels({ ...DEFAULT_AUDIO_SETTINGS, master: 0 });
    system.update(createSnapshot(), 'chase', false, FRAME_SEC);
    expect(system.mix.masterGain).toBe(0);
  });

  it('routes camera mode into the Kubrick decision', () => {
    const { system } = createSystem();
    system.update(createSnapshot(), 'observatory', false, FRAME_SEC);
    expect(system.mix.perspective).toBe('exterior');
    expect(system.mix.sfxBusGain).toBe(0);
  });

  it('reports visibility state without a context to suspend', () => {
    const { system } = createSystem();
    expect(() => {
      system.setPageHidden(true);
      system.setPageHidden(false);
    }).not.toThrow();
    expect(system.engine.contextState).toBe('none');
  });

  it('disposes cleanly having never unlocked', () => {
    const { system } = createSystem();
    expect(() => system.dispose()).not.toThrow();
  });
});
