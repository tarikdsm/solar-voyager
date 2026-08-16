import { MAX_THRUST_WARP } from '../../core/time.js';
import { WarningFlag, type SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { CameraMode } from '../cameraDirector.js';
import type { AudioSettings } from '../settings.js';

/**
 * How a body sounds, not how it is classified astronomically.
 *
 * Only `star` and `giant` change the music context today; the rest exist so
 * T0145 can key ship-bed and ambience variation off the same one table instead
 * of inventing a second one.
 */
export type AudioBodyClass = 'star' | 'giant' | 'terrestrial' | 'moon' | 'small' | 'none';

/** The four adaptive music contexts of spec section 9, in layer-buffer order. */
export const MUSIC_CONTEXTS: readonly MusicContext[] = Object.freeze([
  'deep-space',
  'giant-approach',
  'near-sun',
  'warning',
] as const);

export type MusicContext = 'deep-space' | 'giant-approach' | 'near-sun' | 'warning';

/** Interior cameras hear the ship; exterior cameras are in vacuum (Kubrick mode). */
export type AudioPerspective = 'interior' | 'exterior';

/** Adaptive music crossfade window, seconds (spec section 9). */
export const MUSIC_CROSSFADE_SEC = 4;

/**
 * How long the `warning` context survives after the impact flag clears, seconds.
 *
 * A predicted impact can flicker on and off across a periapsis as the predictor
 * re-solves. Entry is immediate — the whole value of the cue is that it is early
 * — but leaving is held, so a flickering prediction cannot strobe the score.
 */
export const WARNING_RELEASE_HOLD_SEC = 4;

/** Reactor bed under a closed throttle: the ship is never a dead object. */
export const ENGINE_IDLE_GAIN = 0.12;

/** Lowpass cutoff at a closed throttle and the span the lever opens, Hz. */
const ENGINE_CUTOFF_BASE_HZ = 220;
const ENGINE_CUTOFF_SPAN_HZ = 3400;

/** Saw detune at rest, and the spans throttle and gamma add, cents. */
const ENGINE_DETUNE_BASE_CENTS = 6;
const ENGINE_DETUNE_THROTTLE_CENTS = 18;
const ENGINE_DETUNE_GAMMA_CENTS = 26;

/** Fraction of the drive tone and of the sfx bus that full warp muffle removes. */
const WARP_ENGINE_DUCK = 0.85;
const WARP_SFX_DUCK = 0.6;

/** Fraction of the music bus that full gamma stress hands to the ship. */
const GAMMA_MUSIC_DUCK = 0.35;

/** Gamma at which the relativistic stress term saturates. */
const GAMMA_STRESS_CEILING = 10;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Mixer taper: slider position to linear gain.
 *
 * A square rather than a decibel curve, because it is exact at both ends
 * (0 is silence, 1 is unity) and monotone, while a true `20*log10` fader needs a
 * floor constant that would then have to be persisted alongside the level.
 */
export function levelToGain(level: number): number {
  const clamped = clamp01(level);
  return clamped * clamped;
}

/**
 * One frame of audio decisions. Allocated once and rewritten in place.
 *
 * Every field is a target the engine ramps towards; nothing here is a command to
 * start or stop a node.
 */
export interface AudioMixState {
  /** Highest-priority context this frame — the crossfade target, not its state. */
  musicContext: MusicContext;
  /** Equal-power layer weights in `MUSIC_CONTEXTS` order; T0145 attaches stems. */
  readonly musicLayerGains: Float64Array;
  musicBusGain: number;
  sfxBusGain: number;
  uiBusGain: number;
  masterGain: number;
  /** Hum level inside the sfx bus, so Kubrick mode silences it with everything else. */
  engineGain: number;
  engineCutoffHz: number;
  engineDetuneCents: number;
  perspective: AudioPerspective;
  warningActive: boolean;
  /** 0 at 1x, 1 at and above `MAX_THRUST_WARP`. */
  warpMuffle: number;
  /** 0 at rest, 1 at and above gamma 10. */
  gammaStress: number;
}

export interface AudioDirectorOptions {
  /** Audio class per body, indexed like `SimSnapshot.bodyIds`. */
  readonly bodyClasses: readonly AudioBodyClass[];
  readonly levels: AudioSettings;
  readonly crossfadeSec?: number;
  readonly warningHoldSec?: number;
}

/** Allocates one complete mix-state buffer. One per director, at setup. */
export function createAudioMixState(): AudioMixState {
  return {
    musicContext: 'deep-space',
    musicLayerGains: new Float64Array(MUSIC_CONTEXTS.length),
    musicBusGain: 0,
    sfxBusGain: 0,
    uiBusGain: 0,
    masterGain: 0,
    engineGain: ENGINE_IDLE_GAIN,
    engineCutoffHz: ENGINE_CUTOFF_BASE_HZ,
    engineDetuneCents: ENGINE_DETUNE_BASE_CENTS,
    perspective: 'interior',
    warningActive: false,
    warpMuffle: 0,
    gammaStress: 0,
  };
}

/**
 * Maps snapshot facts, camera mode and mixer settings to audio layer states.
 *
 * **Pure decision module.** No `AudioContext`, no DOM, no clock: every threshold,
 * curve and hold timer in the audio subsystem lives here so all of them are
 * unit-testable in Node, and `WebAudioEngine` is left with nothing to decide.
 * `update()` is allocation-free — it rewrites one preallocated `AudioMixState`.
 *
 * Design: `docs/superpowers/specs/2026-08-16-audio-engine-design.md` section 5.
 * Decision record: `docs/decisions/ADR-041-audio-architecture.md`.
 */
export class AudioDirector {
  private readonly bodyClasses: readonly AudioBodyClass[];
  private readonly crossfadeSec: number;
  private readonly warningHoldSec: number;
  private readonly mixState = createAudioMixState();
  /** Linear crossfade ramps; `musicLayerGains` publishes their square roots. */
  private readonly layerRamps = new Float64Array(MUSIC_CONTEXTS.length);

  private levels: AudioSettings;
  private warningHoldRemainingSec = 0;

  constructor(options: AudioDirectorOptions) {
    this.bodyClasses = options.bodyClasses;
    this.levels = options.levels;
    this.crossfadeSec = options.crossfadeSec ?? MUSIC_CROSSFADE_SEC;
    this.warningHoldSec = options.warningHoldSec ?? WARNING_RELEASE_HOLD_SEC;
    if (!Number.isFinite(this.crossfadeSec) || this.crossfadeSec <= 0) {
      throw new RangeError('Audio crossfade duration must be finite and positive.');
    }
    if (!Number.isFinite(this.warningHoldSec) || this.warningHoldSec < 0) {
      throw new RangeError('Audio warning hold must be finite and nonnegative.');
    }
  }

  /** Live state; the same object every frame, safe to hold a reference to. */
  get state(): AudioMixState {
    return this.mixState;
  }

  /** Applies persisted mixer levels. Does not disturb an in-flight crossfade. */
  setLevels(levels: AudioSettings): void {
    this.levels = levels;
  }

  /**
   * Recomputes the whole mix from this frame's facts.
   *
   * `wallDtSec` is deliberately the **wall** delta, not the sim delta: a paused
   * game (T0112 holds the simulation at zero while the loop keeps running) must
   * still finish its crossfade and its Kubrick ramp rather than freezing
   * mid-blend for the length of a menu visit.
   */
  update(snapshot: SimSnapshot, cameraMode: CameraMode, paused: boolean, wallDtSec: number): void {
    // Clamped rather than thrown: audio must never be the reason a frame dies.
    const deltaSec = Number.isFinite(wallDtSec) && wallDtSec > 0 ? wallDtSec : 0;
    const state = this.mixState;
    const levels = this.levels;

    const exterior = cameraMode === 'cinematic' || cameraMode === 'observatory';
    state.perspective = exterior ? 'exterior' : 'interior';

    const warpMuffle = clamp01(Math.log10(snapshot.effectiveWarp) / Math.log10(MAX_THRUST_WARP));
    const gammaStress = clamp01(Math.log10(snapshot.gamma) / Math.log10(GAMMA_STRESS_CEILING));
    state.warpMuffle = warpMuffle;
    state.gammaStress = gammaStress;

    const warningRaw =
      snapshot.impactOccurred === 1 || (snapshot.warningFlags & WarningFlag.IMPACT) !== 0;
    if (warningRaw) this.warningHoldRemainingSec = this.warningHoldSec;
    else if (this.warningHoldRemainingSec > 0) {
      this.warningHoldRemainingSec = Math.max(0, this.warningHoldRemainingSec - deltaSec);
    }
    const warningActive = warningRaw || this.warningHoldRemainingSec > 0;
    state.warningActive = warningActive;

    const context = this.selectMusicContext(snapshot, warningActive);
    state.musicContext = context;
    this.advanceCrossfade(MUSIC_CONTEXTS.indexOf(context), deltaSec);

    const throttle = clamp01(snapshot.throttle);
    state.engineGain =
      (ENGINE_IDLE_GAIN + (1 - ENGINE_IDLE_GAIN) * Math.pow(throttle, 0.6)) *
      (1 - WARP_ENGINE_DUCK * warpMuffle);
    state.engineCutoffHz = ENGINE_CUTOFF_BASE_HZ + ENGINE_CUTOFF_SPAN_HZ * Math.pow(throttle, 0.8);
    state.engineDetuneCents =
      ENGINE_DETUNE_BASE_CENTS +
      ENGINE_DETUNE_THROTTLE_CENTS * throttle +
      ENGINE_DETUNE_GAMMA_CENTS * gammaStress;

    state.masterGain = levelToGain(levels.master);
    // The score is non-diegetic: warp never touches it, and it is the one thing
    // that should survive a time skip intact.
    state.musicBusGain =
      exterior && !levels.exteriorMusic
        ? 0
        : levelToGain(levels.music) * (1 - GAMMA_MUSIC_DUCK * gammaStress);
    // Kubrick mode, and the pause: outside the hull there is no medium, and a
    // held simulation has nothing to make a sustained sound about.
    state.sfxBusGain =
      exterior || paused ? 0 : levelToGain(levels.sfx) * (1 - WARP_SFX_DUCK * warpMuffle);
    // Never silenced by the camera. UI sound is not in the vacuum, and a settings
    // panel whose buttons stop clicking reads as a bug.
    state.uiBusGain = levelToGain(levels.ui);
  }

  private selectMusicContext(snapshot: SimSnapshot, warningActive: boolean): MusicContext {
    if (warningActive) return 'warning';
    const bodyClass = this.classOf(snapshot.dominantBodyIndex);
    if (bodyClass === 'star') return 'near-sun';
    if (bodyClass === 'giant') return 'giant-approach';
    return 'deep-space';
  }

  private classOf(bodyIndex: number): AudioBodyClass {
    if (bodyIndex < 0 || bodyIndex >= this.bodyClasses.length) return 'none';
    return this.bodyClasses[bodyIndex] ?? 'none';
  }

  /**
   * Walks every layer ramp towards a one-hot target and republishes the weights.
   *
   * The published value is `sqrt(ramp)`, so a two-layer crossfade holds constant
   * power (the sum of squares stays at unity through the blend) while a fade-in
   * from silence still starts at zero. Doing this here rather than with four
   * `setTargetAtTime` calls keeps it observable from a browser gate and saves
   * T0145 from re-deriving it.
   */
  private advanceCrossfade(targetIndex: number, deltaSec: number): void {
    const step = deltaSec / this.crossfadeSec;
    const ramps = this.layerRamps;
    const published = this.mixState.musicLayerGains;
    for (let index = 0; index < ramps.length; index += 1) {
      const current = ramps[index] as number;
      const next =
        index === targetIndex ? Math.min(1, current + step) : Math.max(0, current - step);
      ramps[index] = next;
      published[index] = Math.sqrt(next);
    }
  }
}
