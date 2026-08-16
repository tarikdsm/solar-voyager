import { describe, expect, it } from 'vitest';

import { CanvasFrameEncoder, type FrameCaptureCanvas } from './frameCapture.js';

function createCanvas(blob: Blob | null, order: string[]): FrameCaptureCanvas {
  return {
    toBlob(callback: (value: Blob | null) => void, type?: string): void {
      order.push(`toBlob:${type ?? 'default'}`);
      callback(blob);
    },
  };
}

describe('CanvasFrameEncoder', () => {
  it('re-renders the scene before reading the drawing buffer, in one task', async () => {
    const order: string[] = [];
    const blob = { size: 1, type: 'image/png' } as unknown as Blob;
    const encoder = new CanvasFrameEncoder({
      canvas: createCanvas(blob, order),
      renderFrame: () => {
        order.push('render');
      },
    });

    const pending = encoder.encodeFrame();
    // Both already happened when `encodeFrame` returned: nothing may yield
    // between the draw and the read, because `preserveDrawingBuffer` is false.
    expect(order).toEqual(['render', 'toBlob:image/png']);
    await expect(pending).resolves.toBe(blob);
  });

  it('rejects rather than resolving an empty capture', async () => {
    const encoder = new CanvasFrameEncoder({
      canvas: createCanvas(null, []),
      renderFrame: () => undefined,
    });
    await expect(encoder.encodeFrame()).rejects.toThrow(/no image data/u);
  });
});
