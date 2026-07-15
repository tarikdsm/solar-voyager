const RADIANS_PER_MILLISECOND = 0.001;
const FULL_TURN_RADIANS = Math.PI * 2;

export function advanceBaselineAngle(angleRad: number, elapsedMs: number): number {
  return (angleRad + elapsedMs * RADIANS_PER_MILLISECOND) % FULL_TURN_RADIANS;
}
