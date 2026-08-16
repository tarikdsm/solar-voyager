import type { ReadonlyVec3 } from '../../core/vec3.js';
import type { SimSnapshot } from '../../sim/simulationSnapshot.js';

/**
 * What a photo records about the flight that took it (plan §5 T0125).
 *
 * `positionKm` is the **ship's** heliocentric position, not the camera's: every
 * other field here is a ship fact, the album's "location" means where the flight
 * was, and at cinematic ranges the two points are metres apart.
 *
 * `utcTimeMs` and `sequence` are additions to the plan's five fields, for T0147:
 * the album needs a display timestamp and a stable identity, and both are known
 * only at the moment of capture.
 */
export interface CaptureMeta {
  readonly simTimeSec: number;
  /** Ship proper time τ, seconds. */
  readonly tauSec: number;
  readonly positionKm: ReadonlyVec3;
  readonly dominantBodyId: string | null;
  /** Peak γ observed by this session; see {@link PhotoCaptureController.observe}. */
  readonly gammaMax: number;
  readonly utcTimeMs: number;
  /** 1-based, per session. Makes repeat captures of one paused frame distinct. */
  readonly sequence: number;
}

/**
 * Where a finished photo goes.
 *
 * Frozen by the plan and consumed by T0147, which adds the IndexedDB sink beside
 * this task's download sink — the download sink stays as T0147's own documented
 * private-mode fallback.
 */
export interface CaptureSink {
  capture(blob: Blob, meta: CaptureMeta): Promise<void>;
}

/** Produces one encoded still of the live scene. Implemented in `render/`. */
export interface CaptureFrameSource {
  encodeFrame(): Promise<Blob>;
}

export type CaptureStatus = 'idle' | 'capturing' | 'saved' | 'failed';

export interface PhotoCapturePorts {
  readonly frames: CaptureFrameSource;
  readonly sink: CaptureSink;
  snapshot(): SimSnapshot;
}

/**
 * Photo mode's orchestration: one capture at a time, stamped and handed to a sink.
 *
 * Deliberately not in the frame loop. `observe()` is the only per-tick work and
 * is a scalar comparison; `capture()` is user-initiated, allocates transiently
 * (blob, meta, filename, promises) and is the window `docs/performance-spec.md`
 * §5 excludes from the heap gate by name.
 *
 * Design: `docs/superpowers/specs/2026-08-16-cinematic-photo-mode-design.md` §3.
 */
export class PhotoCaptureController {
  private readonly ports: PhotoCapturePorts;
  private peakGamma = 1;
  private sequence = 0;
  private capturing = false;
  private statusValue: CaptureStatus = 'idle';
  private capturedCount = 0;
  private droppedCount = 0;
  private lastErrorValue: string | null = null;
  private lastMetaValue: CaptureMeta | null = null;

  constructor(ports: PhotoCapturePorts) {
    this.ports = ports;
  }

  get status(): CaptureStatus {
    return this.statusValue;
  }

  /** Photos successfully handed to the sink this session. */
  get captureCount(): number {
    return this.capturedCount;
  }

  /** Requests refused because one was already encoding — a held key, usually. */
  get dropCount(): number {
    return this.droppedCount;
  }

  get gammaMax(): number {
    return this.peakGamma;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get lastMeta(): CaptureMeta | null {
    return this.lastMetaValue;
  }

  /**
   * Tracks peak γ, which `SimSnapshot` does not carry (its γ is instantaneous).
   *
   * Allocation-free and cheap enough for any tick rate; the frame loop calls it
   * on the existing 10 Hz HUD publication. The figure is honestly "peak γ since
   * this session loaded" — T0146 owns real flight statistics and should feed this
   * from its own store when it lands, which improves the field without moving the
   * interface.
   */
  observe(snapshot: SimSnapshot): void {
    if (snapshot.gamma > this.peakGamma) this.peakGamma = snapshot.gamma;
  }

  /** Session replacement (load, restore, new game) starts the statistic over. */
  resetStatistics(): void {
    this.peakGamma = 1;
  }

  /**
   * Captures one photo. Resolves `true` when the sink accepted it.
   *
   * A request arriving while one is still encoding is **dropped, not queued**:
   * holding the key must not enqueue forty encodes, and a dropped request is
   * counted rather than swallowed.
   */
  async capture(): Promise<boolean> {
    if (this.capturing) {
      this.droppedCount += 1;
      return false;
    }
    this.capturing = true;
    this.statusValue = 'capturing';
    try {
      const blob = await this.ports.frames.encodeFrame();
      this.sequence += 1;
      const meta = this.readMeta(this.sequence);
      await this.ports.sink.capture(blob, meta);
      this.capturedCount += 1;
      this.lastMetaValue = meta;
      this.lastErrorValue = null;
      this.statusValue = 'saved';
      return true;
    } catch (cause: unknown) {
      this.lastErrorValue = cause instanceof Error ? cause.message : String(cause);
      this.statusValue = 'failed';
      return false;
    } finally {
      this.capturing = false;
    }
  }

  private readMeta(sequence: number): CaptureMeta {
    const snapshot = this.ports.snapshot();
    const dominantIndex = snapshot.dominantBodyIndex;
    return Object.freeze({
      simTimeSec: snapshot.simTimeSec,
      tauSec: snapshot.shipProperTimeSec,
      // Copied, never aliased: snapshot storage is reused after one step.
      positionKm: Object.freeze({
        x: snapshot.shipState[0] as number,
        y: snapshot.shipState[1] as number,
        z: snapshot.shipState[2] as number,
      }),
      dominantBodyId: dominantIndex < 0 ? null : (snapshot.bodyIds[dominantIndex] ?? null),
      gammaMax: this.peakGamma,
      utcTimeMs: snapshot.utcTimeMs,
      sequence,
    });
  }
}
