import { describe, expect, it } from 'vitest';

import { createAudioMixState, MUSIC_CONTEXTS, type AudioMixState } from './audioDirector.js';
import {
  ENGINE_BASE_FREQUENCY_HZ,
  ENGINE_FILTER_Q,
  NOISE_BUFFER_SEC,
  WebAudioEngine,
} from './audioEngine.js';

/**
 * A recording stand-in for the Web Audio API.
 *
 * The engine is typed against the real DOM interfaces, so this is cast in; the
 * point of the fake is that graph topology, lifecycle and param-write behavior
 * are all assertable in Node, leaving only "does it make a noise" for the
 * browser gate.
 */
interface FakeParam {
  value: number;
  readonly writes: number[];
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

interface FakeNode {
  readonly kind: string;
  readonly connections: FakeNode[];
  [key: string]: unknown;
}

function createParam(initial: number): FakeParam {
  const writes: number[] = [];
  return {
    value: initial,
    writes,
    setTargetAtTime(value: number) {
      writes.push(value);
      this.value = value;
    },
  };
}

function createNode(kind: string, extra: Record<string, unknown> = {}): FakeNode {
  const connections: FakeNode[] = [];
  return {
    kind,
    connections,
    connect(target: FakeNode) {
      connections.push(target);
      return target;
    },
    disconnect() {
      connections.length = 0;
    },
    ...extra,
  };
}

class FakeContext {
  state = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48_000;
  readonly destination = createNode('destination');
  readonly created: FakeNode[] = [];
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;
  rejectResume = false;

  createGain(): FakeNode {
    return this.track(createNode('gain', { gain: createParam(1) }));
  }

  createOscillator(): FakeNode {
    return this.track(
      createNode('oscillator', {
        type: 'sine',
        frequency: createParam(440),
        detune: createParam(0),
        started: 0,
        start() {
          (this as unknown as { started: number }).started += 1;
        },
        stop() {
          /* single-use nodes are never stopped by this engine */
        },
      }),
    );
  }

  createBiquadFilter(): FakeNode {
    return this.track(
      createNode('biquad', {
        type: 'peaking',
        frequency: createParam(350),
        Q: createParam(1),
      }),
    );
  }

  createBufferSource(): FakeNode {
    return this.track(
      createNode('bufferSource', {
        buffer: null,
        loop: false,
        started: 0,
        start() {
          (this as unknown as { started: number }).started += 1;
        },
        stop() {
          /* single-use nodes are never stopped by this engine */
        },
      }),
    );
  }

  createBuffer(channels: number, length: number, sampleRate: number): unknown {
    const data = new Float32Array(length);
    return {
      length,
      numberOfChannels: channels,
      sampleRate,
      getChannelData: () => data,
    };
  }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.rejectResume) throw new Error('resume blocked');
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCount += 1;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.state = 'closed';
  }

  private track(node: FakeNode): FakeNode {
    this.created.push(node);
    return node;
  }
}

interface Harness {
  readonly engine: WebAudioEngine;
  readonly contexts: FakeContext[];
  latest(): FakeContext;
}

function createHarness(configure: (context: FakeContext) => void = () => undefined): Harness {
  const contexts: FakeContext[] = [];
  const engine = new WebAudioEngine({
    createContext: () => {
      const context = new FakeContext();
      configure(context);
      contexts.push(context);
      return context as unknown as AudioContext;
    },
  });
  return {
    engine,
    contexts,
    latest: () => contexts[contexts.length - 1] as FakeContext,
  };
}

function nodesOfKind(context: FakeContext, kind: string): FakeNode[] {
  return context.created.filter((node) => node.kind === kind);
}

function gainOf(node: FakeNode): FakeParam {
  return node.gain as FakeParam;
}

function createState(overrides: Partial<AudioMixState> = {}): AudioMixState {
  const state = createAudioMixState();
  state.masterGain = 0.5;
  state.musicBusGain = 0.25;
  state.sfxBusGain = 0.5;
  state.uiBusGain = 0.25;
  state.engineGain = 0.12;
  state.engineCutoffHz = 220;
  state.engineDetuneCents = 6;
  return Object.assign(state, overrides);
}

describe('WebAudioEngine', () => {
  describe('before the first user gesture', () => {
    it('constructs no AudioContext at all', () => {
      const { engine, contexts } = createHarness();
      expect(contexts).toHaveLength(0);
      expect(engine.unlocked).toBe(false);
      expect(engine.contextState).toBe('none');
      expect(engine.contextCreationCount).toBe(0);
      expect(engine.unlockAttemptCount).toBe(0);
    });

    it('accepts frames and writes nothing', () => {
      const { engine, contexts } = createHarness();
      for (let index = 0; index < 10; index += 1) engine.apply(createState());
      expect(contexts).toHaveLength(0);
      expect(engine.paramWriteCount).toBe(0);
    });

    it('records a visibility change without creating a context to suspend', () => {
      const { engine, contexts } = createHarness();
      engine.setPageHidden(true);
      expect(contexts).toHaveLength(0);
      expect(engine.contextState).toBe('none');
    });
  });

  describe('unlock', () => {
    it('creates exactly one context and resumes it', () => {
      const { engine, contexts, latest } = createHarness();
      engine.unlock();
      expect(contexts).toHaveLength(1);
      expect(engine.unlocked).toBe(true);
      expect(engine.contextCreationCount).toBe(1);
      expect(engine.unlockAttemptCount).toBe(1);
      expect(latest().resumeCount).toBe(1);
    });

    it('is idempotent — a second gesture never builds a second graph', () => {
      const { engine, contexts, latest } = createHarness();
      engine.unlock();
      const nodeCount = latest().created.length;
      engine.unlock();
      engine.unlock();
      expect(contexts).toHaveLength(1);
      expect(engine.contextCreationCount).toBe(1);
      expect(engine.unlockAttemptCount).toBe(3);
      expect(latest().created).toHaveLength(nodeCount);
    });

    it('survives a rejected resume without an unhandled rejection', async () => {
      const { engine } = createHarness((context) => {
        context.rejectResume = true;
      });
      expect(() => engine.unlock()).not.toThrow();
      await Promise.resolve();
      expect(engine.unlocked).toBe(true);
    });
  });

  describe('graph', () => {
    it('wires music, sfx and ui buses into one master, and master into the destination', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      const context = latest();
      const master = engine.masterBus as unknown as FakeNode;
      expect(master.connections).toEqual([context.destination]);
      for (const bus of ['musicBus', 'sfxBus', 'uiBus'] as const) {
        const node = engine[bus] as unknown as FakeNode;
        expect(node.connections).toEqual([master]);
      }
    });

    it('starts two detuned sawtooth oscillators through the lowpass', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      const context = latest();
      const oscillators = nodesOfKind(context, 'oscillator');
      expect(oscillators).toHaveLength(2);
      const filter = nodesOfKind(context, 'biquad')[0] as FakeNode;
      for (const oscillator of oscillators) {
        expect(oscillator.type).toBe('sawtooth');
        expect((oscillator.frequency as FakeParam).value).toBe(ENGINE_BASE_FREQUENCY_HZ);
        expect(oscillator.started).toBe(1);
        expect(oscillator.connections).toEqual([filter]);
      }
      // Opposite signs: the pair beats around the base frequency instead of
      // drifting off it, so widening the detune never changes the pitch.
      const detunes = oscillators.map((oscillator) => (oscillator.detune as FakeParam).value);
      expect(detunes[0]).toBe(-(detunes[1] as number));
      expect(filter.type).toBe('lowpass');
      expect((filter.Q as FakeParam).value).toBe(ENGINE_FILTER_Q);
    });

    it('loops a filled noise buffer into the same lowpass', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      const context = latest();
      const filter = nodesOfKind(context, 'biquad')[0] as FakeNode;
      const noise = nodesOfKind(context, 'bufferSource')[0] as FakeNode;
      expect(noise.loop).toBe(true);
      expect(noise.started).toBe(1);
      expect(noise.connections).toEqual([filter]);
      const buffer = noise.buffer as { length: number; getChannelData(): Float32Array };
      expect(buffer.length).toBe(Math.round(context.sampleRate * NOISE_BUFFER_SEC));
      const samples = buffer.getChannelData();
      let nonZero = 0;
      for (let index = 0; index < samples.length; index += 1) {
        if (samples[index] !== 0) nonZero += 1;
      }
      expect(nonZero).toBeGreaterThan(samples.length * 0.9);
    });

    it('routes the hum through the sfx bus so Kubrick mode silences it too', () => {
      const { engine } = createHarness();
      engine.unlock();
      const filter = engine.engineFilter as unknown as FakeNode;
      const engineGain = engine.engineBus as unknown as FakeNode;
      expect(filter.connections).toEqual([engineGain]);
      expect(engineGain.connections).toEqual([engine.sfxBus as unknown as FakeNode]);
    });

    it('exposes four music layer inputs for T0145 to attach stems to', () => {
      const { engine } = createHarness();
      engine.unlock();
      const musicBus = engine.musicBus as unknown as FakeNode;
      for (let index = 0; index < MUSIC_CONTEXTS.length; index += 1) {
        const layer = engine.musicLayerInput(index) as unknown as FakeNode;
        expect(layer.connections).toEqual([musicBus]);
      }
      expect(engine.musicLayerInput(MUSIC_CONTEXTS.length)).toBeNull();
    });

    it('builds the graph silent so unlocking never pops', () => {
      const { engine } = createHarness();
      engine.unlock();
      for (const bus of ['masterBus', 'musicBus', 'sfxBus', 'uiBus', 'engineBus'] as const) {
        expect(gainOf(engine[bus] as unknown as FakeNode).value).toBe(0);
      }
    });
  });

  describe('param writes', () => {
    it('writes every param on the first frame after unlock', () => {
      const { engine } = createHarness();
      engine.unlock();
      engine.apply(createState());
      expect(engine.paramWriteCount).toBeGreaterThan(0);
      expect(gainOf(engine.masterBus as unknown as FakeNode).value).toBeCloseTo(0.5, 10);
      expect(gainOf(engine.sfxBus as unknown as FakeNode).value).toBeCloseTo(0.5, 10);
    });

    it('writes nothing at all on an unchanged frame', () => {
      const { engine } = createHarness();
      engine.unlock();
      const state = createState();
      engine.apply(state);
      const afterFirst = engine.paramWriteCount;
      for (let index = 0; index < 60; index += 1) engine.apply(state);
      expect(engine.paramWriteCount).toBe(afterFirst);
    });

    it('ignores changes below the audible epsilon', () => {
      const { engine } = createHarness();
      engine.unlock();
      const state = createState();
      engine.apply(state);
      const afterFirst = engine.paramWriteCount;
      state.masterGain += 1e-7;
      engine.apply(state);
      expect(engine.paramWriteCount).toBe(afterFirst);
    });

    it('writes the changed param and only that one', () => {
      const { engine } = createHarness();
      engine.unlock();
      const state = createState();
      engine.apply(state);
      const afterFirst = engine.paramWriteCount;
      state.engineGain = 0.9;
      engine.apply(state);
      expect(engine.paramWriteCount).toBe(afterFirst + 1);
      expect(gainOf(engine.engineBus as unknown as FakeNode).value).toBeCloseTo(0.9, 10);
    });

    it('splits the detune symmetrically across the two saws', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      const state = createState({ engineDetuneCents: 30 });
      engine.apply(state);
      const oscillators = nodesOfKind(latest(), 'oscillator');
      expect((oscillators[0]?.detune as FakeParam).value).toBeCloseTo(-15, 10);
      expect((oscillators[1]?.detune as FakeParam).value).toBeCloseTo(15, 10);
    });

    it('drives the music layer gains from the published crossfade weights', () => {
      const { engine } = createHarness();
      engine.unlock();
      const state = createState();
      state.musicLayerGains[0] = 0.7071;
      state.musicLayerGains[2] = 0.7071;
      engine.apply(state);
      expect(gainOf(engine.musicLayerInput(0) as unknown as FakeNode).value).toBeCloseTo(
        0.7071,
        10,
      );
      expect(gainOf(engine.musicLayerInput(2) as unknown as FakeNode).value).toBeCloseTo(
        0.7071,
        10,
      );
      expect(gainOf(engine.musicLayerInput(1) as unknown as FakeNode).value).toBe(0);
    });

    it('rejects a non-finite target rather than poisoning an AudioParam', () => {
      const { engine } = createHarness();
      engine.unlock();
      const state = createState();
      engine.apply(state);
      const afterFirst = engine.paramWriteCount;
      state.masterGain = Number.NaN;
      state.engineCutoffHz = Number.POSITIVE_INFINITY;
      engine.apply(state);
      expect(engine.paramWriteCount).toBe(afterFirst);
      expect(gainOf(engine.masterBus as unknown as FakeNode).value).toBeCloseTo(0.5, 10);
    });
  });

  describe('visibility', () => {
    it('suspends when the tab hides and resumes when it returns', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      const context = latest();
      expect(context.resumeCount).toBe(1);
      engine.setPageHidden(true);
      expect(context.suspendCount).toBe(1);
      expect(engine.suspendedByVisibility).toBe(true);
      engine.setPageHidden(false);
      expect(context.resumeCount).toBe(2);
      expect(engine.suspendedByVisibility).toBe(false);
    });

    it('does not suspend twice for one hide', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      engine.setPageHidden(true);
      engine.setPageHidden(true);
      expect(latest().suspendCount).toBe(1);
    });

    it('does not resume a context it never suspended', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      engine.setPageHidden(false);
      expect(latest().resumeCount).toBe(1);
    });

    it('unlocks straight into a suspended state when the page is already hidden', () => {
      const { engine, latest } = createHarness();
      engine.setPageHidden(true);
      engine.unlock();
      expect(engine.unlocked).toBe(true);
      expect(engine.suspendedByVisibility).toBe(true);
      expect(latest().resumeCount).toBe(0);
      engine.setPageHidden(false);
      expect(latest().resumeCount).toBe(1);
    });
  });

  describe('dispose', () => {
    it('closes the context and stops accepting frames', () => {
      const { engine, latest } = createHarness();
      engine.unlock();
      engine.apply(createState());
      engine.dispose();
      expect(latest().closeCount).toBe(1);
      const afterDispose = engine.paramWriteCount;
      engine.apply(createState({ masterGain: 0.9 }));
      expect(engine.paramWriteCount).toBe(afterDispose);
      expect(engine.contextState).toBe('none');
    });

    it('is safe before unlock and safe twice', () => {
      const { engine } = createHarness();
      expect(() => {
        engine.dispose();
        engine.dispose();
      }).not.toThrow();
    });
  });
});
