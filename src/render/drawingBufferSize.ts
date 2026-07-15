/** Returns the integer drawing-buffer dimension for a CSS dimension and pixel ratio. */
export function calculateDrawingBufferDimension(
  clientDimension: number,
  pixelRatio: number,
): number {
  return Math.floor(clientDimension * pixelRatio);
}
