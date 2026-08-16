import { describe, expect, it, vi } from 'vitest';

import type { SimSnapshot } from '../../sim/simulationSnapshot.js';
import {
  DownloadCaptureSink,
  formatCaptureFilename,
  type DownloadCapturePort,
} from './downloadCaptureSink.js';
import { PhotoCaptureController, type CaptureMeta, type CaptureSink } from './photoCapture.js';

const UTC_2026_08_16 = Date.UTC(2026, 7, 16, 12, 15, 0);

function createSnapshot(overrides: Partial<SimSnapshot> = {}): SimSnapshot {
  return {
    simTimeSec: 1_234.5,
    shipProperTimeSec: 1_200.25,
    utcTimeMs: UTC_2026_08_16,
    shipState: new Float64Array([149_597_870.7, 1_000, -25, 0, 0, 0, 0]),
    bodyIds: ['sun', 'earth'],
    dominantBodyIndex: 1,
    gamma: 1,
    ...overrides,
  } as unknown as SimSnapshot;
}

function createBlob(): Blob {
  return { size: 42, type: 'image/png' } as unknown as Blob;
}

interface Recorder extends CaptureSink {
  readonly captures: { blob: Blob; meta: CaptureMeta }[];
}

function createRecordingSink(): Recorder {
  const captures: { blob: Blob; meta: CaptureMeta }[] = [];
  return {
    captures,
    capture(blob: Blob, meta: CaptureMeta): Promise<void> {
      captures.push({ blob, meta });
      return Promise.resolve();
    },
  };
}

describe('PhotoCaptureController', () => {
  it('stamps the five contract fields from the snapshot', async () => {
    const sink = createRecordingSink();
    let snapshot = createSnapshot({ gamma: 3.5 } as Partial<SimSnapshot>);
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.resolve(createBlob()) },
      sink,
      snapshot: () => snapshot,
    });

    controller.observe(snapshot);
    snapshot = createSnapshot({ gamma: 1.2 } as Partial<SimSnapshot>);
    controller.observe(snapshot);

    expect(await controller.capture()).toBe(true);
    const meta = sink.captures[0]?.meta as CaptureMeta;
    expect(meta.simTimeSec).toBe(1_234.5);
    expect(meta.tauSec).toBe(1_200.25);
    expect(meta.positionKm).toEqual({ x: 149_597_870.7, y: 1_000, z: -25 });
    expect(meta.dominantBodyId).toBe('earth');
    // The peak, not the instantaneous value the capture frame happened to carry.
    expect(meta.gammaMax).toBe(3.5);
    expect(meta.sequence).toBe(1);
    expect(controller.status).toBe('saved');
    expect(controller.captureCount).toBe(1);
  });

  it('copies the position instead of aliasing reused snapshot storage', async () => {
    const shipState = new Float64Array([1, 2, 3, 0, 0, 0, 0]);
    const sink = createRecordingSink();
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.resolve(createBlob()) },
      sink,
      snapshot: () => createSnapshot({ shipState } as Partial<SimSnapshot>),
    });
    await controller.capture();
    shipState[0] = 999;
    expect(sink.captures[0]?.meta.positionKm.x).toBe(1);
  });

  it('reports deep space when no body dominates', async () => {
    const sink = createRecordingSink();
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.resolve(createBlob()) },
      sink,
      snapshot: () => createSnapshot({ dominantBodyIndex: -1 } as Partial<SimSnapshot>),
    });
    await controller.capture();
    expect(sink.captures[0]?.meta.dominantBodyId).toBeNull();
    expect(formatCaptureFilename(sink.captures[0]?.meta as CaptureMeta)).toContain('deep-space');
  });

  it('drops a request made while one is still encoding, and counts it', async () => {
    const sink = createRecordingSink();
    let release: (() => void) | null = null;
    const controller = new PhotoCaptureController({
      frames: {
        encodeFrame: () =>
          new Promise<Blob>((resolve) => {
            release = () => {
              resolve(createBlob());
            };
          }),
      },
      sink,
      snapshot: createSnapshot,
    });

    const first = controller.capture();
    expect(controller.status).toBe('capturing');
    expect(await controller.capture()).toBe(false);
    expect(controller.dropCount).toBe(1);
    (release as unknown as () => void)();
    expect(await first).toBe(true);
    expect(sink.captures.length).toBe(1);

    // ...and the guard clears, so the next request is served.
    expect(controller.dropCount).toBe(1);
  });

  it('numbers repeat captures of one paused frame distinctly', async () => {
    const sink = createRecordingSink();
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.resolve(createBlob()) },
      sink,
      snapshot: createSnapshot,
    });
    await controller.capture();
    await controller.capture();
    const names = sink.captures.map((entry) => formatCaptureFilename(entry.meta));
    expect(names).toEqual([
      'solar-voyager-20260816T121500Z-earth-001.png',
      'solar-voyager-20260816T121500Z-earth-002.png',
    ]);
    expect(new Set(names).size).toBe(2);
  });

  it('records a failed capture without wedging the controller', async () => {
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.reject(new Error('no image data')) },
      sink: createRecordingSink(),
      snapshot: createSnapshot,
    });
    expect(await controller.capture()).toBe(false);
    expect(controller.status).toBe('failed');
    expect(controller.lastError).toBe('no image data');
    expect(controller.captureCount).toBe(0);
  });

  it('starts the peak-gamma statistic over on session replacement', () => {
    const controller = new PhotoCaptureController({
      frames: { encodeFrame: () => Promise.resolve(createBlob()) },
      sink: createRecordingSink(),
      snapshot: createSnapshot,
    });
    controller.observe(createSnapshot({ gamma: 12 } as Partial<SimSnapshot>));
    expect(controller.gammaMax).toBe(12);
    controller.resetStatistics();
    expect(controller.gammaMax).toBe(1);
  });
});

describe('DownloadCaptureSink', () => {
  function createPort(): DownloadCapturePort & {
    readonly saved: { url: string; filename: string }[];
    readonly revoked: string[];
  } {
    const saved: { url: string; filename: string }[] = [];
    const revoked: string[] = [];
    return {
      saved,
      revoked,
      createObjectUrl: () => 'blob:solar-voyager/1',
      revokeObjectUrl: (url: string) => {
        revoked.push(url);
      },
      saveAs: (url: string, filename: string) => {
        saved.push({ url, filename });
      },
    };
  }

  const meta: CaptureMeta = Object.freeze({
    simTimeSec: 0,
    tauSec: 0,
    positionKm: Object.freeze({ x: 0, y: 0, z: 0 }),
    dominantBodyId: 'earth',
    gammaMax: 1,
    utcTimeMs: UTC_2026_08_16,
    sequence: 7,
  });

  it('writes one file per capture and always releases the object URL', async () => {
    const port = createPort();
    const sink = new DownloadCaptureSink(port);
    await sink.capture(createBlob(), meta);
    expect(port.saved).toEqual([
      { url: 'blob:solar-voyager/1', filename: 'solar-voyager-20260816T121500Z-earth-007.png' },
    ]);
    expect(port.revoked).toEqual(['blob:solar-voyager/1']);
    expect(sink.lastFilename).toBe('solar-voyager-20260816T121500Z-earth-007.png');
    expect(sink.saveCount).toBe(1);
  });

  it('releases the object URL even when the download itself throws', async () => {
    const port = createPort();
    const failing: DownloadCapturePort = {
      ...port,
      saveAs: vi.fn(() => {
        throw new Error('download blocked');
      }),
    };
    const sink = new DownloadCaptureSink(failing);
    await expect(sink.capture(createBlob(), meta)).rejects.toThrow('download blocked');
    expect(port.revoked).toEqual(['blob:solar-voyager/1']);
    expect(sink.saveCount).toBe(0);
  });
});
