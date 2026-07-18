export const STATE_VECTOR_VIEWPORT_COMPONENT_COUNT = 4;

export interface ViewportRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Writes a clipped `[x, y, width, height]` drawing-buffer viewport without allocating. */
export function writeStateVectorViewportPixelsInto(
  output: Float64Array,
  canvasRect: ViewportRect,
  panelRect: ViewportRect,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
): void {
  if (output.length < STATE_VECTOR_VIEWPORT_COMPONENT_COUNT) {
    throw new RangeError('State-vector viewport output requires four components.');
  }
  if (
    !Number.isFinite(canvasRect.width) ||
    !Number.isFinite(canvasRect.height) ||
    canvasRect.width <= 0 ||
    canvasRect.height <= 0 ||
    !Number.isFinite(drawingBufferWidth) ||
    !Number.isFinite(drawingBufferHeight) ||
    drawingBufferWidth < 0 ||
    drawingBufferHeight < 0
  ) {
    throw new RangeError('State-vector viewport requires usable canvas geometry.');
  }
  const scaleX = drawingBufferWidth / canvasRect.width;
  const scaleY = drawingBufferHeight / canvasRect.height;
  const rawLeft = (panelRect.left - canvasRect.left) * scaleX;
  const rawBottom = (canvasRect.bottom - panelRect.bottom) * scaleY;
  const rawRight = rawLeft + panelRect.width * scaleX;
  const rawTop = rawBottom + panelRect.height * scaleY;
  const clippedLeft = Math.min(drawingBufferWidth, Math.max(0, rawLeft));
  const clippedBottom = Math.min(drawingBufferHeight, Math.max(0, rawBottom));
  const clippedRight = Math.min(drawingBufferWidth, Math.max(0, rawRight));
  const clippedTop = Math.min(drawingBufferHeight, Math.max(0, rawTop));
  output[0] = clippedLeft;
  output[1] = clippedBottom;
  output[2] = Math.max(0, clippedRight - clippedLeft);
  output[3] = Math.max(0, clippedTop - clippedBottom);
}
