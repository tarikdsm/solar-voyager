import { STATE_RX, STATE_RY, STATE_RZ } from '../ship/relativity.js';
import type { CompiledRailsCatalog } from '../propagation/rails.js';

const ENTRY_FACTOR = 0.9;
const EXIT_FACTOR = 1.1;
const SCORE_LEAD_FACTOR = 1.1;

function squaredDistanceToBody(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyIndex: number,
): number {
  const offset = bodyIndex * 3;
  const dxKm = (shipState[STATE_RX] as number) - (bodyPositionsKm[offset] as number);
  const dyKm = (shipState[STATE_RY] as number) - (bodyPositionsKm[offset + 1] as number);
  const dzKm = (shipState[STATE_RZ] as number) - (bodyPositionsKm[offset + 2] as number);
  return dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
}

function gravityScore(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  catalog: CompiledRailsCatalog,
  bodyIndex: number,
): number {
  return (
    (catalog.muKm3S2[bodyIndex] as number) /
    squaredDistanceToBody(shipState, bodyPositionsKm, bodyIndex)
  );
}

function isAncestor(
  possibleAncestorIndex: number,
  bodyIndex: number,
  parentIndices: Int32Array,
): boolean {
  let parentIndex = parentIndices[bodyIndex] as number;
  while (parentIndex >= 0) {
    if (parentIndex === possibleAncestorIndex) return true;
    parentIndex = parentIndices[parentIndex] as number;
  }
  return false;
}

function hasTenPercentLead(candidateScore: number, currentScore: number): boolean {
  if (candidateScore === Number.POSITIVE_INFINITY) {
    return currentScore !== Number.POSITIVE_INFINITY;
  }
  return candidateScore > currentScore * SCORE_LEAD_FACTOR;
}

/** Selects physics-spec.md §6 dominance with the catalogued 10% SOI band. */
export function selectDominantBodyIndexWithHysteresis(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  catalog: CompiledRailsCatalog,
  previousIndex: number,
): number {
  let selectedIndex = -1;
  let selectedScore = -1;
  for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
    const score = gravityScore(shipState, bodyPositionsKm, catalog, bodyIndex);
    if (score > selectedScore) {
      selectedScore = score;
      selectedIndex = bodyIndex;
    }
  }

  if (
    selectedIndex < 0 ||
    previousIndex < 0 ||
    previousIndex >= catalog.bodyCount ||
    selectedIndex === previousIndex
  ) {
    return selectedIndex;
  }

  const previousScore = gravityScore(shipState, bodyPositionsKm, catalog, previousIndex);
  if (!hasTenPercentLead(selectedScore, previousScore)) return previousIndex;

  if (isAncestor(previousIndex, selectedIndex, catalog.parentIndices)) {
    const entryRadiusKm = (catalog.soiRadiiKm[selectedIndex] as number) * ENTRY_FACTOR;
    const candidateDistanceSquaredKm2 = squaredDistanceToBody(
      shipState,
      bodyPositionsKm,
      selectedIndex,
    );
    return candidateDistanceSquaredKm2 <= entryRadiusKm * entryRadiusKm
      ? selectedIndex
      : previousIndex;
  }

  if (isAncestor(selectedIndex, previousIndex, catalog.parentIndices)) {
    const exitRadiusKm = (catalog.soiRadiiKm[previousIndex] as number) * EXIT_FACTOR;
    const previousDistanceSquaredKm2 = squaredDistanceToBody(
      shipState,
      bodyPositionsKm,
      previousIndex,
    );
    return previousDistanceSquaredKm2 > exitRadiusKm * exitRadiusKm ? selectedIndex : previousIndex;
  }

  return selectedIndex;
}
