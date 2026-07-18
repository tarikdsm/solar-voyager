import bodiesDocument from '../../data/bodies.json';

import { describe, expect, it } from 'vitest';

import type { ThrustFreeTrajectoryOptions } from '../sim/analysis/trajectoryPredictor.js';
import type { PredictorRequestMessage, PredictorResponseMessage } from './predictorProtocol.js';
import {
  PREDICTOR_INVALID_REQUEST_ID_FALLBACK,
  createPredictorWorkerRuntime,
  type PredictorExecutor,
  type PredictorWorkerPort,
} from './predictorWorkerRuntime.js';

interface PostedResponse {
  readonly message: PredictorResponseMessage;
  readonly transfer: readonly Transferable[];
}

class FakeWorkerPort implements PredictorWorkerPort {
  readonly posted: PostedResponse[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    expect(type).toBe('message');
    this.listener = listener;
  }

  postMessage(message: PredictorResponseMessage, options?: StructuredSerializeOptions): void {
    this.posted.push({ message, transfer: options?.transfer ?? [] });
  }

  dispatch(data: unknown): void {
    if (this.listener === null) throw new Error('worker runtime is not bound');
    this.listener({ data } as MessageEvent<unknown>);
  }
}

function createRequest(requestId: number): PredictorRequestMessage {
  return {
    type: 'predict',
    requestId,
    startTimeSec: 123,
    shipState: new Float64Array([7_000, 0, 0, 0, 7.5, 0, 0]),
    osculatingPeriodSec: 5_000_000,
    userHorizonSec: 12_000_000,
    dominantBodyIndex: 3,
    targetBodyIndex: 4,
  };
}

describe('predictor worker runtime', () => {
  it('compiles the canonical catalog and collision radii once per runtime setup', () => {
    const port = new FakeWorkerPort();
    const received: ThrustFreeTrajectoryOptions[] = [];
    const execute: PredictorExecutor = (options) => {
      received.push(options);
      return {
        points: new Float64Array([options.startTimeSec, 1, 2, 3]),
        events: new Float64Array(),
      };
    };
    createPredictorWorkerRuntime(port, execute);

    const firstRequest = { ...createRequest(1), testHorizonSec: 21_600 };
    const secondRequest = createRequest(2);
    port.dispatch(firstRequest);
    port.dispatch(secondRequest);

    expect(received).toHaveLength(2);
    expect(received[0]?.catalog).toBe(received[1]?.catalog);
    expect(received[0]?.collisionRadiiKm).toBe(received[1]?.collisionRadiiKm);
    expect(received[0]?.catalog.bodyCount).toBe(bodiesDocument.bodies.length);
    expect(received[0]?.horizonSec).toBe(21_600);
    expect(received[1]?.horizonSec).toBe(12_000_000);
    expect(received[0]?.outputPointCount).toBe(2_000);
    expect(received[0]?.startTimeSec).toBe(123);
    expect(received[0]?.shipState).toBe(firstRequest.shipState);
    expect(received[1]?.shipState).toBe(secondRequest.shipState);
    expect(received[0]?.dominantBodyIndex).toBe(3);
    expect(received[0]?.targetBodyIndex).toBe(4);

    const radii = received[0]?.collisionRadiiKm;
    expect(radii).toHaveLength(bodiesDocument.bodies.length);
    for (let index = 0; index < bodiesDocument.bodies.length; index += 1) {
      const body = bodiesDocument.bodies[index];
      expect(radii?.[index]).toBe((body?.meanRadiusKm ?? 0) + (body?.surface.atmosphereTopKm ?? 0));
    }
  });

  it('posts successful result buffers with transferable ownership', () => {
    const port = new FakeWorkerPort();
    const points = new Float64Array([123, 1, 2, 3]);
    const events = new Float64Array();
    createPredictorWorkerRuntime(port, () => ({ points, events }));

    port.dispatch(createRequest(7));

    expect(port.posted).toEqual([
      {
        message: { type: 'success', requestId: 7, points, events },
        transfer: [points.buffer, events.buffer],
      },
    ]);
  });

  it('rejects malformed requests deterministically and preserves a safe request id', () => {
    const port = new FakeWorkerPort();
    let executions = 0;
    createPredictorWorkerRuntime(port, () => {
      executions += 1;
      return { points: new Float64Array(4), events: new Float64Array() };
    });

    port.dispatch({ ...createRequest(11), shipState: new Float64Array(6) });
    port.dispatch({ type: 'predict' });

    expect(executions).toBe(0);
    expect(port.posted).toEqual([
      {
        message: { type: 'error', requestId: 11, message: 'invalid predictor request' },
        transfer: [],
      },
      {
        message: {
          type: 'error',
          requestId: PREDICTOR_INVALID_REQUEST_ID_FALLBACK,
          message: 'invalid predictor request',
        },
        transfer: [],
      },
    ]);
  });

  it('continues processing after one prediction failure', () => {
    const port = new FakeWorkerPort();
    let executions = 0;
    createPredictorWorkerRuntime(port, () => {
      executions += 1;
      if (executions === 1) throw new Error('host-dependent detail');
      return {
        points: new Float64Array([123, 1, 2, 3]),
        events: new Float64Array(),
      };
    });

    port.dispatch(createRequest(20));
    port.dispatch(createRequest(21));

    expect(port.posted[0]).toEqual({
      message: { type: 'error', requestId: 20, message: 'trajectory prediction failed' },
      transfer: [],
    });
    expect(port.posted[1]?.message).toMatchObject({ type: 'success', requestId: 21 });
    expect(executions).toBe(2);
  });
});
