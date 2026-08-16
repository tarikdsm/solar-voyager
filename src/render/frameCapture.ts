import type { CaptureFrameSource } from '../game/photo/photoCapture.js';

export const CAPTURE_MIME_TYPE = 'image/png';

/** The only part of `HTMLCanvasElement` this module needs, so tests need no DOM. */
export interface FrameCaptureCanvas {
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface CanvasFrameEncoderOptions {
  readonly canvas: FrameCaptureCanvas;
  /**
   * Renders the live scene through the post pipeline, synchronously.
   *
   * Supplied by `bootstrap/composition.ts` as the same `postPipeline.render()`
   * call the frame loop makes, so a photo carries bloom, relativistic aberration
   * and ACES tone mapping exactly as the screen does.
   */
  readonly renderFrame: () => void;
  readonly mimeType?: string;
}

/**
 * Canvas → PNG blob without `preserveDrawingBuffer` (plan §5 T0125).
 *
 * The renderer is created with `preserveDrawingBuffer: false`
 * (`createRenderer.ts`, asserted by the renderer-policy gate), so the drawing
 * buffer is valid only until the browser composites it — which happens after the
 * current task ends. This encoder therefore **re-renders the scene and calls
 * `toBlob` in that same task**: the `Promise` executor runs synchronously, so
 * nothing yields between the draw and the read, and the capture is correct
 * wherever it is triggered from rather than only from inside an animation frame.
 *
 * Rejected alternative: an offscreen `WebGLRenderTarget` plus
 * `readRenderTargetPixels`. It creates a GPU resource during gameplay
 * (`performance-spec.md` §5 forbids exactly that), the composer's buffers are
 * half-float so the readback is a manual decode, and the post chain's last pass
 * writes to the screen — an offscreen target would either bypass tone mapping or
 * need a duplicate chain.
 */
export class CanvasFrameEncoder implements CaptureFrameSource {
  private readonly canvas: FrameCaptureCanvas;
  private readonly renderFrame: () => void;
  private readonly mimeType: string;

  constructor(options: CanvasFrameEncoderOptions) {
    this.canvas = options.canvas;
    this.renderFrame = options.renderFrame;
    this.mimeType = options.mimeType ?? CAPTURE_MIME_TYPE;
  }

  encodeFrame(): Promise<Blob> {
    this.renderFrame();
    return new Promise<Blob>((resolve, reject) => {
      // Synchronous with the render above — do not add an `await` before this.
      this.canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error('The renderer produced no image data for this capture.'));
          return;
        }
        resolve(blob);
      }, this.mimeType);
    });
  }
}
