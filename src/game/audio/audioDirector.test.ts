import { describe, expect, it } from 'vitest';

import { WarningFlag, type SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { CameraMode } from '../cameraDirector.js';
import type { AudioSettings } from '../settings.js';
import {
  AudioDirector,
  ENGINE_IDLE_GAIN,
  MUSIC_CONTEXTS,
  MUSIC_CROSSFADE_SEC,
  WARNING_RELEASE_HOLD_SEC,
  levelToGain,
  type AudioBodyClass,
  type MusicContext,
} from './audioDirector.js';

/** sun, jupiter, earth, moon, ceres, 67p — one of every audio class. */
const BODY_CLASSES: readonly AudioBodyClass[] = Object.freeze([
  'star',
  'giant',
  'terrestrial',
  'moon',
  'terrestrial',
  'small',
] as const);

const FRAME_SEC = 1 / 60;

const UNIT_LEVELS: AudioSettings = Object.freeze({
  master: 1,
  music: 1,
  sfx: 1,
  ui: 1,
  exteriorMusic: true,
});

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

function createDirector(levels: AudioSettings = UNIT_LEVELS): AudioDirector {
  return new AudioDirector({ bodyClasses: BODY_CLASSES, levels });
}

/** Runs `seconds` of frames so a crossfade or a hold timer actually elapses. */
function advance(
  director: AudioDirector,
  seconds: number,
  snapshot: SimSnapshot,
  mode: CameraMode = 'chase',
  paused = false,
): void {
  const frames = Math.round(seconds / FRAME_SEC);
  for (let index = 0; index < frames; index += 1) {
    director.update(snapshot, mode, paused, FRAME_SEC);
  }
}

function layerGain(director: AudioDirector, context: MusicContext): number {
  return director.state.musicLayerGains[MUSIC_CONTEXTS.indexOf(context)] as number;
}

describe('AudioDirector', () => {
  it('decides without any Web Audio API present', () => {
    // The acceptance criterion, asserted rather than assumed: this suite runs in
    // Node, where there is no AudioContext to accidentally depend on.
    expect((globalThis as Record<string, unknown>).AudioContext).toBeUndefined();
    const director = createDirector();
    director.update(createSnapshot(), 'chase', false, FRAME_SEC);
    expect(director.state.perspective).toBe('interior');
  });

  it('maps every camera mode to a perspective', () => {
    const director = createDirector();
    const snapshot = createSnapshot();
    const seen: Record<CameraMode, string> = {
      chase: '',
      cockpit: '',
      cinematic: '',
      observatory: '',
    };
    for (const mode of ['chase', 'cockpit', 'cinematic', 'observatory'] as const) {
      director.update(snapshot, mode, false, FRAME_SEC);
      seen[mode] = director.state.perspective;
    }
    expect(seen).toEqual({
      chase: 'interior',
      cockpit: 'interior',
      cinematic: 'exterior',
      observatory: 'exterior',
    });
  });

  describe('Kubrick mode', () => {
    it('silences the sfx bus on exterior cameras and restores it on interior ones', () => {
      const director = createDirector();
      const snapshot = createSnapshot();
      director.update(snapshot, 'chase', false, FRAME_SEC);
      expect(director.state.sfxBusGain).toBeGreaterThan(0);
      director.update(snapshot, 'observatory', false, FRAME_SEC);
      expect(director.state.sfxBusGain).toBe(0);
      director.update(snapshot, 'cinematic', false, FRAME_SEC);
      expect(director.state.sfxBusGain).toBe(0);
      director.update(snapshot, 'cockpit', false, FRAME_SEC);
      expect(director.state.sfxBusGain).toBeGreaterThan(0);
    });

    it('keeps the score on exterior cameras when exteriorMusic is on', () => {
      const director = createDirector({ ...UNIT_LEVELS, exteriorMusic: true });
      director.update(createSnapshot(), 'observatory', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBeGreaterThan(0);
    });

    it('goes fully vacuum-silent on exterior cameras when exteriorMusic is off', () => {
      const director = createDirector({ ...UNIT_LEVELS, exteriorMusic: false });
      const snapshot = createSnapshot();
      director.update(snapshot, 'observatory', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBe(0);
      expect(director.state.sfxBusGain).toBe(0);
      director.update(snapshot, 'chase', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBeGreaterThan(0);
    });

    it('never silences the ui bus, whatever the camera', () => {
      const director = createDirector({ ...UNIT_LEVELS, exteriorMusic: false });
      const snapshot = createSnapshot();
      director.update(snapshot, 'chase', false, FRAME_SEC);
      const interior = director.state.uiBusGain;
      director.update(snapshot, 'observatory', false, FRAME_SEC);
      expect(director.state.uiBusGain).toBe(interior);
      expect(interior).toBeGreaterThan(0);
    });
  });

  describe('music context', () => {
    it('sits in deep space with no dominant body', () => {
      const director = createDirector();
      director.update(createSnapshot({ dominantBodyIndex: -1 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('deep-space');
    });

    it('picks giant-approach inside a gas giant sphere of influence', () => {
      const director = createDirector();
      director.update(createSnapshot({ dominantBodyIndex: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('giant-approach');
    });

    it('picks near-sun when the star dominates', () => {
      const director = createDirector();
      director.update(createSnapshot({ dominantBodyIndex: 0 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('near-sun');
    });

    it('stays in deep space around a terrestrial body or a moon', () => {
      const director = createDirector();
      director.update(createSnapshot({ dominantBodyIndex: 2 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('deep-space');
      director.update(createSnapshot({ dominantBodyIndex: 3 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('deep-space');
    });

    it('outranks every other context with an impact warning', () => {
      const director = createDirector();
      director.update(
        createSnapshot({ dominantBodyIndex: 0, warningFlags: WarningFlag.IMPACT }),
        'chase',
        false,
        FRAME_SEC,
      );
      expect(director.state.musicContext).toBe('warning');
      expect(director.state.warningActive).toBe(true);
    });

    it('treats a completed impact as a warning too', () => {
      const director = createDirector();
      director.update(createSnapshot({ impactOccurred: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('warning');
    });

    it('ignores warning flags that are not the impact flag', () => {
      const director = createDirector();
      director.update(
        createSnapshot({ warningFlags: WarningFlag.SOI_CHANGE | WarningFlag.ESCAPE }),
        'chase',
        false,
        FRAME_SEC,
      );
      expect(director.state.musicContext).toBe('deep-space');
    });

    it('holds the warning context for the release window after the flag clears', () => {
      const director = createDirector();
      director.update(
        createSnapshot({ warningFlags: WarningFlag.IMPACT }),
        'chase',
        false,
        FRAME_SEC,
      );
      expect(director.state.musicContext).toBe('warning');
      const clear = createSnapshot();
      advance(director, WARNING_RELEASE_HOLD_SEC - 0.5, clear);
      expect(director.state.musicContext).toBe('warning');
      advance(director, 1, clear);
      expect(director.state.musicContext).toBe('deep-space');
    });

    it('re-arms the hold when the flag returns', () => {
      const director = createDirector();
      const warned = createSnapshot({ warningFlags: WarningFlag.IMPACT });
      const clear = createSnapshot();
      director.update(warned, 'chase', false, FRAME_SEC);
      advance(director, 2, clear);
      director.update(warned, 'chase', false, FRAME_SEC);
      advance(director, 3, clear);
      expect(director.state.musicContext).toBe('warning');
    });
  });

  describe('music crossfade', () => {
    it('fades the opening bed in over the crossfade window instead of cutting in', () => {
      const director = createDirector();
      const snapshot = createSnapshot();
      director.update(snapshot, 'chase', false, FRAME_SEC);
      expect(layerGain(director, 'deep-space')).toBeLessThan(0.2);
      advance(director, MUSIC_CROSSFADE_SEC, snapshot);
      expect(layerGain(director, 'deep-space')).toBeCloseTo(1, 6);
    });

    it('crosses two layers at equal power', () => {
      const director = createDirector();
      const deepSpace = createSnapshot();
      advance(director, MUSIC_CROSSFADE_SEC + 1, deepSpace);
      const nearSun = createSnapshot({ dominantBodyIndex: 0 });
      advance(director, MUSIC_CROSSFADE_SEC / 2, nearSun);
      const outgoing = layerGain(director, 'deep-space');
      const incoming = layerGain(director, 'near-sun');
      expect(outgoing).toBeGreaterThan(0.5);
      expect(incoming).toBeGreaterThan(0.5);
      // Equal-power: the published weights are square roots of linear ramps, so
      // the sum of squares stays at unity through the whole blend.
      expect(outgoing * outgoing + incoming * incoming).toBeCloseTo(1, 6);
    });

    it('settles on exactly one layer once the crossfade completes', () => {
      const director = createDirector();
      advance(director, MUSIC_CROSSFADE_SEC + 1, createSnapshot());
      advance(director, 2 * MUSIC_CROSSFADE_SEC, createSnapshot({ dominantBodyIndex: 1 }));
      expect(layerGain(director, 'giant-approach')).toBeCloseTo(1, 6);
      expect(layerGain(director, 'deep-space')).toBeCloseTo(0, 6);
      expect(layerGain(director, 'near-sun')).toBeCloseTo(0, 6);
      expect(layerGain(director, 'warning')).toBeCloseTo(0, 6);
    });

    it('advances the crossfade on wall time while the game is paused', () => {
      const director = createDirector();
      advance(director, MUSIC_CROSSFADE_SEC + 1, createSnapshot(), 'chase', true);
      expect(layerGain(director, 'deep-space')).toBeCloseTo(1, 6);
    });
  });

  describe('engine hum', () => {
    it('idles above silence with the throttle closed', () => {
      const director = createDirector();
      director.update(createSnapshot({ throttle: 0 }), 'chase', false, FRAME_SEC);
      expect(director.state.engineGain).toBeCloseTo(ENGINE_IDLE_GAIN, 10);
    });

    it('rises monotonically with throttle and reaches unity at full lever', () => {
      const director = createDirector();
      let previous = -1;
      for (const throttle of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
        director.update(createSnapshot({ throttle }), 'chase', false, FRAME_SEC);
        expect(director.state.engineGain).toBeGreaterThan(previous);
        previous = director.state.engineGain;
      }
      expect(previous).toBeCloseTo(1, 10);
    });

    it('opens the lowpass with throttle', () => {
      const director = createDirector();
      director.update(createSnapshot({ throttle: 0 }), 'chase', false, FRAME_SEC);
      const closed = director.state.engineCutoffHz;
      director.update(createSnapshot({ throttle: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.engineCutoffHz).toBeGreaterThan(closed * 4);
      expect(closed).toBeGreaterThan(0);
    });

    it('widens the saw detune with throttle and again with gamma', () => {
      const director = createDirector();
      director.update(createSnapshot({ throttle: 0, gamma: 1 }), 'chase', false, FRAME_SEC);
      const rest = director.state.engineDetuneCents;
      director.update(createSnapshot({ throttle: 1, gamma: 1 }), 'chase', false, FRAME_SEC);
      const burning = director.state.engineDetuneCents;
      director.update(createSnapshot({ throttle: 1, gamma: 10 }), 'chase', false, FRAME_SEC);
      const relativistic = director.state.engineDetuneCents;
      expect(burning).toBeGreaterThan(rest);
      expect(relativistic).toBeGreaterThan(burning);
    });

    it('mutes the hum while the game is paused', () => {
      const director = createDirector();
      director.update(createSnapshot({ throttle: 1 }), 'chase', true, FRAME_SEC);
      expect(director.state.sfxBusGain).toBe(0);
      director.update(createSnapshot({ throttle: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.sfxBusGain).toBeGreaterThan(0);
    });
  });

  describe('warp', () => {
    it('reports no muffle at 1x and full muffle at the thrust ceiling', () => {
      const director = createDirector();
      director.update(createSnapshot({ effectiveWarp: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.warpMuffle).toBe(0);
      director.update(createSnapshot({ effectiveWarp: 1e3 }), 'chase', false, FRAME_SEC);
      expect(director.state.warpMuffle).toBe(1);
      director.update(createSnapshot({ effectiveWarp: 1e7 }), 'chase', false, FRAME_SEC);
      expect(director.state.warpMuffle).toBe(1);
    });

    it('fades the drive tone and ducks the sfx bus as warp climbs', () => {
      const director = createDirector();
      director.update(createSnapshot({ throttle: 1, effectiveWarp: 1 }), 'chase', false, FRAME_SEC);
      const humAtRest = director.state.engineGain;
      const sfxAtRest = director.state.sfxBusGain;
      director.update(
        createSnapshot({ throttle: 1, effectiveWarp: 1e3 }),
        'chase',
        false,
        FRAME_SEC,
      );
      expect(director.state.engineGain).toBeLessThan(humAtRest * 0.2);
      expect(director.state.sfxBusGain).toBeLessThan(sfxAtRest * 0.5);
      expect(director.state.sfxBusGain).toBeGreaterThan(0);
    });

    it('leaves the non-diegetic music bus alone at every warp tier', () => {
      const director = createDirector();
      director.update(createSnapshot({ effectiveWarp: 1 }), 'chase', false, FRAME_SEC);
      const music = director.state.musicBusGain;
      director.update(createSnapshot({ effectiveWarp: 1e7 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBe(music);
    });
  });

  describe('gamma', () => {
    it('reports no stress at rest and full stress at gamma ten', () => {
      const director = createDirector();
      director.update(createSnapshot({ gamma: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.gammaStress).toBe(0);
      director.update(createSnapshot({ gamma: 10 }), 'chase', false, FRAME_SEC);
      expect(director.state.gammaStress).toBeCloseTo(1, 10);
      director.update(createSnapshot({ gamma: 1000 }), 'chase', false, FRAME_SEC);
      expect(director.state.gammaStress).toBe(1);
    });

    it('lets the ship take the room from the score as gamma climbs', () => {
      const director = createDirector();
      director.update(createSnapshot({ gamma: 1 }), 'chase', false, FRAME_SEC);
      const rest = director.state.musicBusGain;
      director.update(createSnapshot({ gamma: 10 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBeCloseTo(rest * 0.65, 6);
    });
  });

  describe('mixer levels', () => {
    it('applies a squared taper so the slider position is what gets stored', () => {
      expect(levelToGain(0)).toBe(0);
      expect(levelToGain(1)).toBe(1);
      expect(levelToGain(0.5)).toBeCloseTo(0.25, 10);
    });

    it('scales each bus by its own level and all of them by master', () => {
      const director = createDirector({
        master: 0.5,
        music: 0.5,
        sfx: 1,
        ui: 0.25,
        exteriorMusic: true,
      });
      director.update(createSnapshot(), 'chase', false, FRAME_SEC);
      expect(director.state.masterGain).toBeCloseTo(0.25, 10);
      expect(director.state.musicBusGain).toBeCloseTo(0.25, 10);
      expect(director.state.sfxBusGain).toBeCloseTo(1, 10);
      expect(director.state.uiBusGain).toBeCloseTo(0.0625, 10);
    });

    it('takes a level change without restarting the crossfade', () => {
      const director = createDirector();
      const snapshot = createSnapshot();
      advance(director, MUSIC_CROSSFADE_SEC + 1, snapshot);
      director.setLevels({ ...UNIT_LEVELS, music: 0 });
      director.update(snapshot, 'chase', false, FRAME_SEC);
      expect(director.state.musicBusGain).toBe(0);
      expect(layerGain(director, 'deep-space')).toBeCloseTo(1, 6);
    });

    it('silences everything at master zero', () => {
      const director = createDirector({ ...UNIT_LEVELS, master: 0 });
      director.update(createSnapshot({ throttle: 1 }), 'chase', false, FRAME_SEC);
      expect(director.state.masterGain).toBe(0);
    });
  });

  describe('frame-path hygiene', () => {
    it('reuses one state object and one layer buffer across updates', () => {
      const director = createDirector();
      const state = director.state;
      const layers = state.musicLayerGains;
      for (let index = 0; index < 200; index += 1) {
        director.update(createSnapshot({ throttle: index / 200 }), 'chase', false, FRAME_SEC);
      }
      expect(director.state).toBe(state);
      expect(director.state.musicLayerGains).toBe(layers);
      expect(layers).toHaveLength(MUSIC_CONTEXTS.length);
    });

    it('clamps hostile deltas instead of producing non-finite gains', () => {
      const director = createDirector();
      const snapshot = createSnapshot();
      director.update(snapshot, 'chase', false, 0);
      director.update(snapshot, 'chase', false, 1e6);
      expect(Number.isFinite(director.state.musicBusGain)).toBe(true);
      expect(layerGain(director, 'deep-space')).toBeCloseTo(1, 6);
    });

    it('tolerates a dominant body index outside the class table', () => {
      const director = createDirector();
      director.update(createSnapshot({ dominantBodyIndex: 999 }), 'chase', false, FRAME_SEC);
      expect(director.state.musicContext).toBe('deep-space');
    });
  });
});
