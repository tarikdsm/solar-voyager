import { MUSIC_CONTEXTS, type AudioMixState } from './audioDirector.js';

/** Fundamental of the drive hum: A1. Low enough to be felt, high enough to carry. */
export const ENGINE_BASE_FREQUENCY_HZ = 55;

/** Lowpass resonance. Just under critical — a shelf, not a whistle. */
export const ENGINE_FILTER_Q = 0.9;

/** Length of the looped white-noise bed, seconds. */
export const NOISE_BUFFER_SEC = 2;

/**
 * Peak amplitude of the noise bed, baked into the buffer samples.
 *
 * Baked rather than applied through a trim GainNode: the level never changes, so
 * a node for it would be one more thing in the graph and one more thing to
 * explain.
 */
const NOISE_AMPLITUDE = 0.12;

/** Ramp time constants: buses breathe, the drive responds. */
const BUS_TIME_CONSTANT_SEC = 0.12;
const ENGINE_TIME_CONSTANT_SEC = 0.05;

/** Below these deltas a rewrite is inaudible and is skipped. */
const GAIN_EPSILON = 1e-4;
const FREQUENCY_EPSILON_HZ = 0.5;
const DETUNE_EPSILON_CENTS = 0.05;

/** Slots in the last-written table, in write order. */
const PARAM_MASTER = 0;
const PARAM_MUSIC = 1;
const PARAM_SFX = 2;
const PARAM_UI = 3;
const PARAM_ENGINE_GAIN = 4;
const PARAM_ENGINE_CUTOFF = 5;
const PARAM_DETUNE_A = 6;
const PARAM_DETUNE_B = 7;
const PARAM_MUSIC_LAYER_BASE = 8;
const PARAM_COUNT = PARAM_MUSIC_LAYER_BASE + MUSIC_CONTEXTS.length;

/**
 * The one browser capability this module needs, injected.
 *
 * `bootstrap/composition.ts` supplies it, exactly as it supplies
 * `PointerLockSurface` and `GamepadHost`, so `game/` never reaches for a global.
 */
export interface AudioEnginePorts {
  createContext(): AudioContext;
}

interface AudioGraph {
  readonly context: AudioContext;
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly ui: GainNode;
  readonly engine: GainNode;
  readonly filter: BiquadFilterNode;
  readonly sawA: OscillatorNode;
  readonly sawB: OscillatorNode;
  readonly musicLayers: readonly GainNode[];
}

/**
 * Owns the Web Audio graph, the context lifecycle and the synthesized drive hum.
 *
 * **Decides nothing.** It reads an `AudioMixState` produced by `AudioDirector`
 * and moves `AudioParam`s towards it; every threshold and curve lives in the
 * director so it can be tested without a browser.
 *
 * The context is **not constructed until `unlock()`** — not constructed
 * suspended and resumed later. A context that does not exist cannot be blocked
 * by the autoplay policy and cannot log the autoplay warning, which is what
 * makes `?autostart=1` (six browser gates, no user gesture) silent *and* clean.
 *
 * Design: `docs/superpowers/specs/2026-08-16-audio-engine-design.md` sections 3-4.
 * Decision record: `docs/decisions/ADR-041-audio-architecture.md`.
 */
export class WebAudioEngine {
  private readonly ports: AudioEnginePorts;
  private readonly lastWritten = new Float64Array(PARAM_COUNT).fill(Number.NaN);

  private graph: AudioGraph | null = null;
  private contextCreations = 0;
  private unlockAttempts = 0;
  private paramWrites = 0;
  private pageHidden = false;
  private visibilitySuspended = false;

  constructor(ports: AudioEnginePorts) {
    this.ports = ports;
  }

  get unlocked(): boolean {
    return this.graph !== null;
  }

  /** `'none'` until a gesture arrives; the context's own state afterwards. */
  get contextState(): string {
    return this.graph === null ? 'none' : this.graph.context.state;
  }

  /** Proves "exactly one context, ever" from outside the process. */
  get contextCreationCount(): number {
    return this.contextCreations;
  }

  /** Counts gestures offered, including the ones that found it already unlocked. */
  get unlockAttemptCount(): number {
    return this.unlockAttempts;
  }

  /** Total `AudioParam` writes since boot. Flat in steady flight, by design. */
  get paramWriteCount(): number {
    return this.paramWrites;
  }

  get suspendedByVisibility(): boolean {
    return this.visibilitySuspended;
  }

  get masterBus(): GainNode | null {
    return this.graph?.master ?? null;
  }

  get musicBus(): GainNode | null {
    return this.graph?.music ?? null;
  }

  get sfxBus(): GainNode | null {
    return this.graph?.sfx ?? null;
  }

  get uiBus(): GainNode | null {
    return this.graph?.ui ?? null;
  }

  get engineBus(): GainNode | null {
    return this.graph?.engine ?? null;
  }

  get engineFilter(): BiquadFilterNode | null {
    return this.graph?.filter ?? null;
  }

  /**
   * Attachment point for one adaptive music layer (T0145 connects stems here).
   *
   * Returns `null` before unlock and for an out-of-range index, so the caller
   * never has to know whether a gesture has happened yet.
   */
  musicLayerInput(index: number): GainNode | null {
    if (this.graph === null || index < 0 || index >= this.graph.musicLayers.length) return null;
    return this.graph.musicLayers[index] ?? null;
  }

  /**
   * First user gesture: build the graph and start the context.
   *
   * Idempotent. `resume()` returns a promise whose rejection would surface as a
   * Playwright `pageerror` and fail every browser gate, so it is swallowed —
   * the same trap `createCanvasPointerLockSurface` documents for
   * `requestPointerLock`.
   */
  unlock(): void {
    this.unlockAttempts += 1;
    if (this.graph !== null) return;
    const context = this.ports.createContext();
    this.contextCreations += 1;
    this.graph = buildGraph(context);
    // A gesture can arrive on a hidden page (a keypress into a background tab
    // that still has focus). Honour the visibility rule over the gesture rather
    // than resuming something the player cannot see.
    if (this.pageHidden) this.visibilitySuspended = true;
    else void context.resume().catch(() => undefined);
  }

  /**
   * Suspends on a hidden tab and resumes on return.
   *
   * Visibility, not blur: blur fires when the player alt-tabs to a wiki with the
   * game still on a second monitor, and killing the score there would be wrong.
   */
  setPageHidden(hidden: boolean): void {
    this.pageHidden = hidden;
    const graph = this.graph;
    if (graph === null) return;
    if (hidden) {
      if (this.visibilitySuspended) return;
      this.visibilitySuspended = true;
      void graph.context.suspend().catch(() => undefined);
      return;
    }
    if (!this.visibilitySuspended) return;
    this.visibilitySuspended = false;
    void graph.context.resume().catch(() => undefined);
  }

  /**
   * Moves the graph towards this frame's mix. Allocation-free.
   *
   * `setTargetAtTime` rather than `param.value = x`: a direct assignment applies
   * at the next 128-sample render quantum and holds, so assigning at 60 Hz on a
   * loud tone is an audible 16.7 ms staircase. Handing the interpolation to the
   * audio thread is what the automation API is for.
   */
  apply(state: AudioMixState): void {
    const graph = this.graph;
    if (graph === null) return;
    const now = graph.context.currentTime;
    this.write(
      PARAM_MASTER,
      graph.master.gain,
      state.masterGain,
      GAIN_EPSILON,
      now,
      BUS_TIME_CONSTANT_SEC,
    );
    this.write(
      PARAM_MUSIC,
      graph.music.gain,
      state.musicBusGain,
      GAIN_EPSILON,
      now,
      BUS_TIME_CONSTANT_SEC,
    );
    this.write(
      PARAM_SFX,
      graph.sfx.gain,
      state.sfxBusGain,
      GAIN_EPSILON,
      now,
      BUS_TIME_CONSTANT_SEC,
    );
    this.write(PARAM_UI, graph.ui.gain, state.uiBusGain, GAIN_EPSILON, now, BUS_TIME_CONSTANT_SEC);
    this.write(
      PARAM_ENGINE_GAIN,
      graph.engine.gain,
      state.engineGain,
      GAIN_EPSILON,
      now,
      ENGINE_TIME_CONSTANT_SEC,
    );
    this.write(
      PARAM_ENGINE_CUTOFF,
      graph.filter.frequency,
      state.engineCutoffHz,
      FREQUENCY_EPSILON_HZ,
      now,
      ENGINE_TIME_CONSTANT_SEC,
    );
    // Split symmetrically so widening the beat never moves the pitch.
    const halfDetune = state.engineDetuneCents / 2;
    this.write(
      PARAM_DETUNE_A,
      graph.sawA.detune,
      -halfDetune,
      DETUNE_EPSILON_CENTS,
      now,
      ENGINE_TIME_CONSTANT_SEC,
    );
    this.write(
      PARAM_DETUNE_B,
      graph.sawB.detune,
      halfDetune,
      DETUNE_EPSILON_CENTS,
      now,
      ENGINE_TIME_CONSTANT_SEC,
    );
    for (let index = 0; index < graph.musicLayers.length; index += 1) {
      const layer = graph.musicLayers[index];
      if (layer === undefined) continue;
      this.write(
        PARAM_MUSIC_LAYER_BASE + index,
        layer.gain,
        state.musicLayerGains[index] as number,
        GAIN_EPSILON,
        now,
        BUS_TIME_CONSTANT_SEC,
      );
    }
  }

  /** Releases the context. Safe before unlock and safe twice. */
  dispose(): void {
    const graph = this.graph;
    this.graph = null;
    this.visibilitySuspended = false;
    this.lastWritten.fill(Number.NaN);
    if (graph === null) return;
    void graph.context.close().catch(() => undefined);
  }

  private write(
    slot: number,
    param: AudioParam,
    target: number,
    epsilon: number,
    startTime: number,
    timeConstant: number,
  ): void {
    // A non-finite target would poison the AudioParam for the rest of the
    // session — the automation curve never recovers — so it is dropped and the
    // last good value stands.
    if (!Number.isFinite(target)) return;
    if (Math.abs(target - (this.lastWritten[slot] as number)) < epsilon) return;
    this.lastWritten[slot] = target;
    param.setTargetAtTime(target, startTime, timeConstant);
    this.paramWrites += 1;
  }
}

/**
 * Builds the four-bus mixer and the hum chain, silent.
 *
 * Every gain starts at 0 and the first `apply()` ramps it up, so unlocking on a
 * gesture fades in over a few hundred milliseconds instead of popping.
 *
 * The oscillators are started once and never stopped: `OscillatorNode` is
 * single-use, so an engine that stopped the hum at throttle zero would have to
 * allocate a replacement node per burn, in the frame path. The hum runs for the
 * session and is gated entirely by its gain.
 */
function buildGraph(context: AudioContext): AudioGraph {
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);

  const music = context.createGain();
  music.gain.value = 0;
  music.connect(master);

  const sfx = context.createGain();
  sfx.gain.value = 0;
  sfx.connect(master);

  const ui = context.createGain();
  ui.gain.value = 0;
  ui.connect(master);

  const engine = context.createGain();
  engine.gain.value = 0;
  engine.connect(sfx);

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 220;
  filter.Q.value = ENGINE_FILTER_Q;
  filter.connect(engine);

  const sawA = createSaw(context, filter, -3);
  const sawB = createSaw(context, filter, 3);

  const sampleCount = Math.round(context.sampleRate * NOISE_BUFFER_SEC);
  const noiseBuffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = noiseBuffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (Math.random() * 2 - 1) * NOISE_AMPLITUDE;
  }
  const noise = context.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  noise.connect(filter);
  noise.start();

  const musicLayers: GainNode[] = [];
  for (let index = 0; index < MUSIC_CONTEXTS.length; index += 1) {
    const layer = context.createGain();
    layer.gain.value = 0;
    layer.connect(music);
    musicLayers.push(layer);
  }

  return { context, master, music, sfx, ui, engine, filter, sawA, sawB, musicLayers };
}

function createSaw(
  context: AudioContext,
  destination: BiquadFilterNode,
  detuneCents: number,
): OscillatorNode {
  const oscillator = context.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.value = ENGINE_BASE_FREQUENCY_HZ;
  oscillator.detune.value = detuneCents;
  oscillator.connect(destination);
  oscillator.start();
  return oscillator;
}
