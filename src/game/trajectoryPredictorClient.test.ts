import { describe, expect, it } from 'vitest';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import type {
  PredictorRequestMessage,
  PredictorResponseMessage,
} from '../workers/predictorProtocol.js';
import {
  createTrajectoryPredictorClient,
  type TrajectoryPredictorWorkerPort,
} from './trajectoryPredictorClient.js';

interface PostedRequest {
  readonly message: PredictorRequestMessage;
  readonly transfer: readonly Transferable[];
}

class FakePredictorPort implements TrajectoryPredictorWorkerPort {
  readonly posted: PostedRequest[] = [];
  terminated = false;
  throwOnNextPost = false;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: ((event: MessageEvent<unknown>) => void) | null = null;

  addEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListener = listener as (event: MessageEvent<unknown>) => void;
    } else if (type === 'error') {
      this.errorListener = listener as (event: ErrorEvent) => void;
    } else {
      this.messageErrorListener = listener as (event: MessageEvent<unknown>) => void;
    }
  }

  removeEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null;
    if (type === 'error' && this.errorListener === listener) this.errorListener = null;
    if (type === 'messageerror' && this.messageErrorListener === listener) {
      this.messageErrorListener = null;
    }
  }

  postMessage(message: PredictorRequestMessage, transfer: Transferable[]): void {
    if (this.throwOnNextPost) {
      this.throwOnNextPost = false;
      throw new DOMException('host-dependent clone failure', 'DataCloneError');
    }
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.messageListener?.({ data } as MessageEvent<unknown>);
  }

  fail(type: 'error' | 'messageerror'): void {
    if (type === 'error') {
      this.errorListener?.(new Event('error') as ErrorEvent);
    } else {
      this.messageErrorListener?.({ data: 'host-dependent payload' } as MessageEvent<unknown>);
    }
  }

  hasListeners(): boolean {
    return (
      this.messageListener !== null ||
      this.errorListener !== null ||
      this.messageErrorListener !== null
    );
  }
}

function createSnapshot(): SimSnapshot {
  return {
    simTimeSec: 123,
    shipState: new Float64Array([7_000, 1, 2, 3, 7.5, 5, 6]),
    dominantBodyIndex: 3,
    targetBodyIndex: 4,
    osculatingElements: { periodSec: 5_000 },
  } as SimSnapshot;
}

function createSuccess(requestId: number): PredictorResponseMessage {
  return {
    type: 'success',
    requestId,
    points: new Float64Array([123, 1, 2, 3, 124, 4, 5, 6]),
    events: new Float64Array(),
  };
}

describe('trajectory predictor client', () => {
  it('accepts the browser Worker event surface without adapters', () => {
    const asPredictorPort = (worker: Worker): TrajectoryPredictorWorkerPort => worker;

    expect(asPredictorPort).toBeTypeOf('function');
  });

  it('dispatches only after 500 ms without a newer invalidation', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 499;
    client.update(snapshot);
    expect(port.posted).toHaveLength(0);

    client.invalidate();
    nowMs = 998;
    client.update(snapshot);
    expect(port.posted).toHaveLength(0);
    nowMs = 999;
    client.update(snapshot);

    expect(port.posted).toHaveLength(1);
  });

  it('copies the current seven-component celerity state only when dispatching', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    client.update(snapshot);
    snapshot.shipState[0] = 8_000;
    nowMs = 500;
    client.update(snapshot);

    const posted = port.posted[0];
    expect(posted?.message.shipState).toEqual(new Float64Array([8_000, 1, 2, 3, 7.5, 5, 6]));
    expect(posted?.message.shipState).not.toBe(snapshot.shipState);
    expect(posted?.transfer).toEqual([posted?.message.shipState.buffer]);
  });

  it('uses safe monotonically increasing request IDs', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const firstId = port.posted[0]?.message.requestId ?? -1;
    port.respond(createSuccess(firstId));
    client.invalidate();
    nowMs = 1_000;
    client.update(snapshot);
    const secondId = port.posted[1]?.message.requestId ?? -1;

    expect(Number.isSafeInteger(firstId)).toBe(true);
    expect(Number.isSafeInteger(secondId)).toBe(true);
    expect(secondId).toBeGreaterThan(firstId);
  });

  it('keeps one job outstanding and suppresses a result invalidated while it ran', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const received: PredictorResponseMessage[] = [];
    const client = createTrajectoryPredictorClient(port, 9, (result) => received.push(result), {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const staleId = port.posted[0]?.message.requestId ?? -1;

    nowMs = 600;
    client.invalidate();
    nowMs = 1_100;
    client.update(snapshot);
    expect(port.posted).toHaveLength(1);

    port.respond(createSuccess(staleId));
    expect(received).toHaveLength(0);
    client.update(snapshot);
    expect(port.posted).toHaveLength(2);

    const currentId = port.posted[1]?.message.requestId ?? -1;
    port.respond(createSuccess(currentId));
    expect(received).toEqual([createSuccess(currentId)]);
  });

  it('reports a synchronous dispatch failure and retries after the debounce', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const received: PredictorResponseMessage[] = [];
    const client = createTrajectoryPredictorClient(port, 9, (result) => received.push(result), {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    port.throwOnNextPost = true;
    client.invalidate();
    nowMs = 500;
    expect(() => client.update(snapshot)).not.toThrow();
    expect(received).toEqual([
      { type: 'error', requestId: 1, message: 'trajectory predictor dispatch failed' },
    ]);

    nowMs = 999;
    client.update(snapshot);
    expect(port.posted).toHaveLength(0);
    nowMs = 1_000;
    client.update(snapshot);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]?.message.requestId).toBe(2);

    port.respond(createSuccess(2));
    expect(received).toEqual([
      { type: 'error', requestId: 1, message: 'trajectory predictor dispatch failed' },
      createSuccess(2),
    ]);
  });

  it.each([
    ['error', 'trajectory predictor worker error'],
    ['messageerror', 'trajectory predictor message error'],
  ] as const)('recovers from a worker %s event after the debounce', (eventType, message) => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const received: PredictorResponseMessage[] = [];
    const client = createTrajectoryPredictorClient(port, 9, (result) => received.push(result), {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const failedRequestId = port.posted[0]?.message.requestId ?? -1;
    nowMs = 600;
    port.fail(eventType);
    expect(received).toEqual([{ type: 'error', requestId: failedRequestId, message }]);

    nowMs = 1_099;
    client.update(snapshot);
    expect(port.posted).toHaveLength(1);
    nowMs = 1_100;
    client.update(snapshot);
    const recoveredRequestId = port.posted[1]?.message.requestId ?? -1;
    expect(recoveredRequestId).toBeGreaterThan(failedRequestId);

    port.respond(createSuccess(recoveredRequestId));
    expect(received).toEqual([
      { type: 'error', requestId: failedRequestId, message },
      createSuccess(recoveredRequestId),
    ]);
  });

  it('suppresses a worker transport error when its pending job is already stale', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const received: PredictorResponseMessage[] = [];
    const client = createTrajectoryPredictorClient(port, 9, (result) => received.push(result), {
      now: () => nowMs,
    });

    client.invalidate();
    nowMs = 500;
    client.update(createSnapshot());
    nowMs = 600;
    client.invalidate();
    port.fail('error');

    expect(received).toHaveLength(0);
    nowMs = 1_100;
    client.update(createSnapshot());
    expect(port.posted).toHaveLength(2);
  });

  it('supports explicit warp-elapsed invalidation', () => {
    let nowMs = 2_000;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
    });

    client.invalidateForWarpElapsed();
    nowMs = 2_499;
    client.update(createSnapshot());
    expect(port.posted).toHaveLength(0);
    nowMs = 2_500;
    client.update(createSnapshot());
    expect(port.posted).toHaveLength(1);
  });

  it('validates response shape and body indices before notifying the listener', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const received: PredictorResponseMessage[] = [];
    const client = createTrajectoryPredictorClient(port, 5, (result) => received.push(result), {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const requestId = port.posted[0]?.message.requestId ?? -1;
    port.respond({
      type: 'success',
      requestId,
      points: new Float64Array([123, 1, 2, 3]),
      events: new Float64Array(),
    });
    expect(received).toEqual([
      { type: 'error', requestId, message: 'trajectory predictor returned an invalid response' },
    ]);

    nowMs = 1_000;
    client.update(snapshot);
    const recoveredRequestId = port.posted[1]?.message.requestId ?? -1;
    port.respond(createSuccess(recoveredRequestId));
    expect(received).toEqual([
      { type: 'error', requestId, message: 'trajectory predictor returned an invalid response' },
      createSuccess(recoveredRequestId),
    ]);
  });

  it('omits an absent user horizon and preserves a configured horizon', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
      testHorizonSec: 21_600,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const first = port.posted[0]?.message;
    expect(first === undefined ? true : 'userHorizonSec' in first).toBe(false);
    expect(first?.testHorizonSec).toBe(21_600);
    port.respond(createSuccess(first?.requestId ?? -1));

    client.invalidate();
    nowMs = 1_000;
    client.update(snapshot, 10_000_000);
    expect(port.posted[1]?.message.userHorizonSec).toBe(10_000_000);
    expect(port.posted[1]?.message.testHorizonSec).toBe(21_600);
  });

  it('removes its listener and terminates only an owned port on disposal', () => {
    let nowMs = 0;
    const ownedPort = new FakePredictorPort();
    const ownedClient = createTrajectoryPredictorClient(ownedPort, 9, () => {}, {
      now: () => nowMs,
      ownsPort: true,
    });
    const sharedPort = new FakePredictorPort();
    const sharedClient = createTrajectoryPredictorClient(sharedPort, 9, () => {}, {
      now: () => nowMs,
    });

    ownedClient.dispose();
    sharedClient.dispose();
    ownedClient.invalidate();
    nowMs = 500;
    ownedClient.update(createSnapshot());

    expect(ownedPort.terminated).toBe(true);
    expect(sharedPort.terminated).toBe(false);
    expect(ownedPort.posted).toHaveLength(0);
    expect(ownedPort.hasListeners()).toBe(false);
    expect(sharedPort.hasListeners()).toBe(false);
  });

  it('keeps clean update p99 below 0.5 ms', () => {
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {});
    const snapshot = createSnapshot();
    const sampleCount = 20_000;
    const durationsMs = new Float64Array(sampleCount);

    for (let index = 0; index < 5_000; index += 1) client.update(snapshot);
    for (let index = 0; index < sampleCount; index += 1) {
      const startMs = performance.now();
      client.update(snapshot);
      durationsMs[index] = performance.now() - startMs;
    }
    durationsMs.sort();
    const p99Ms = durationsMs[Math.floor(sampleCount * 0.99)] ?? Number.POSITIVE_INFINITY;

    expect(p99Ms).toBeLessThan(0.5);
  });
});
