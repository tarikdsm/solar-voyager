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
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    expect(type).toBe('message');
    this.listener = listener;
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    expect(type).toBe('message');
    if (this.listener === listener) this.listener = null;
  }

  postMessage(message: PredictorRequestMessage, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.listener?.({ data } as MessageEvent<unknown>);
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
    points: new Float64Array([123, 1, 2, 3]),
    events: new Float64Array(),
  };
}

describe('trajectory predictor client', () => {
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
      events: new Float64Array([2, 123, 5, -1, 10, Number.NaN]),
    });
    expect(received).toHaveLength(0);

    port.respond(createSuccess(requestId));
    expect(received).toEqual([createSuccess(requestId)]);
  });

  it('omits an absent user horizon and preserves a configured horizon', () => {
    let nowMs = 0;
    const port = new FakePredictorPort();
    const client = createTrajectoryPredictorClient(port, 9, () => {}, {
      now: () => nowMs,
    });
    const snapshot = createSnapshot();

    client.invalidate();
    nowMs = 500;
    client.update(snapshot);
    const first = port.posted[0]?.message;
    expect(first === undefined ? true : 'userHorizonSec' in first).toBe(false);
    port.respond(createSuccess(first?.requestId ?? -1));

    client.invalidate();
    nowMs = 1_000;
    client.update(snapshot, 10_000_000);
    expect(port.posted[1]?.message.userHorizonSec).toBe(10_000_000);
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
