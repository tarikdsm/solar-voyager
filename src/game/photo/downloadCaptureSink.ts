import type { CaptureMeta, CaptureSink } from './photoCapture.js';

/**
 * The three DOM calls a browser download needs, as a port.
 *
 * `game/` stays DOM-free — `bootstrap/composition.ts` supplies the adapter — and
 * the sink is unit-testable without a browser, which matters because T0147
 * inherits it as its private-mode fallback.
 */
export interface DownloadCapturePort {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  saveAs(url: string, filename: string): void;
}

const FILE_PREFIX = 'solar-voyager';
const FILE_EXTENSION = '.png';
/** Shown when the ship is outside every sphere of influence. */
export const DEEP_SPACE_LOCATION = 'deep-space';

/** `2026-08-16T12:15:00.000Z` -> `20260816T121500Z`; sortable and filename-safe. */
function formatCompactUtc(utcTimeMs: number): string {
  if (!Number.isFinite(utcTimeMs)) return 'unknown-time';
  return new Date(utcTimeMs)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
}

/**
 * `solar-voyager-<mission UTC>-<body>-<session sequence>.png`.
 *
 * Mission UTC, not wall-clock time: the files then sort into flight order, and
 * when the voyage happened says nothing about the voyage. The sequence is what
 * makes two shots of one **paused** frame distinct — mission time does not move
 * while paused, and an unmanaged collision is a photo the browser silently
 * renames to `(1)` or, worse, a photo you believe you took.
 */
export function formatCaptureFilename(meta: CaptureMeta): string {
  const location = meta.dominantBodyId ?? DEEP_SPACE_LOCATION;
  const sequence = String(Math.max(0, Math.trunc(meta.sequence))).padStart(3, '0');
  return `${FILE_PREFIX}-${formatCompactUtc(meta.utcTimeMs)}-${location}-${sequence}${FILE_EXTENSION}`;
}

/**
 * Writes each capture straight to the player's downloads, one file per shot.
 *
 * The decision and its reasoning are in the design doc §3.3, because T0147
 * inherits both: a browser download is the only durable channel that exists
 * before the album, so holding blobs in memory to offer later would lose every
 * photo on reload while looking like it saved them.
 */
export class DownloadCaptureSink implements CaptureSink {
  private readonly port: DownloadCapturePort;
  private lastFilenameValue: string | null = null;
  private savedCount = 0;

  constructor(port: DownloadCapturePort) {
    this.port = port;
  }

  get lastFilename(): string | null {
    return this.lastFilenameValue;
  }

  get saveCount(): number {
    return this.savedCount;
  }

  // `async` so a DOM adapter that throws surfaces as a rejection: a
  // Promise-returning method that throws synchronously is invisible to a caller
  // holding only `.catch`.
  async capture(blob: Blob, meta: CaptureMeta): Promise<void> {
    const filename = formatCaptureFilename(meta);
    const url = this.port.createObjectUrl(blob);
    try {
      this.port.saveAs(url, filename);
      this.lastFilenameValue = filename;
      this.savedCount += 1;
    } finally {
      // Always released, including when `saveAs` throws: an object URL the
      // document keeps alive pins the whole blob for the page's lifetime.
      this.port.revokeObjectUrl(url);
    }
  }
}
