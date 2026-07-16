// physics-spec.md §3.1 — Dormand-Prince 5(4), Hairer-Nørsett-Wanner tableau.

const C2 = 1 / 5;
const C3 = 3 / 10;
const C4 = 4 / 5;
const C5 = 8 / 9;

const A21 = 1 / 5;
const A31 = 3 / 40;
const A32 = 9 / 40;
const A41 = 44 / 45;
const A42 = -56 / 15;
const A43 = 32 / 9;
const A51 = 19_372 / 6_561;
const A52 = -25_360 / 2_187;
const A53 = 64_448 / 6_561;
const A54 = -212 / 729;
const A61 = 9_017 / 3_168;
const A62 = -355 / 33;
const A63 = 46_732 / 5_247;
const A64 = 49 / 176;
const A65 = -5_103 / 18_656;

const B51 = 35 / 384;
const B53 = 500 / 1_113;
const B54 = 125 / 192;
const B55 = -2_187 / 6_784;
const B56 = 11 / 84;

const B41 = 5_179 / 57_600;
const B43 = 7_571 / 16_695;
const B44 = 393 / 640;
const B45 = -92_097 / 339_200;
const B46 = 187 / 2_100;
const B47 = 1 / 40;

const MIN_STEP_FACTOR = 0.2;
const MAX_STEP_FACTOR = 5;
const STEP_SAFETY_FACTOR = 0.9;

/** Writes dy/dt for a generic float64 state without allocating. */
export type Dp54Derivative = (
  timeSec: number,
  state: Float64Array,
  outputDerivative: Float64Array,
) => void;

/** Component tolerances and accepted-step budget for one propagation call. */
export interface Dp54Tolerance {
  readonly absolute: Float64Array;
  relative: number;
  initialStepSec: number;
  maxAcceptedSteps: number;
}

/** Caller-owned propagation metadata. */
export interface Dp54Result {
  reachedTimeSec: number;
  acceptedSteps: number;
  rejectedSteps: number;
  nextStepSec: number;
  reachedEnd: boolean;
  budgetExhausted: boolean;
  stepUnderflow: boolean;
}

/** Caller-owned stage storage reused by every propagation. */
export interface Dp54Workspace {
  readonly dimension: number;
  readonly stageState: Float64Array;
  readonly fourthOrderState: Float64Array;
  readonly fifthOrderState: Float64Array;
  readonly k1: Float64Array;
  readonly k2: Float64Array;
  readonly k3: Float64Array;
  readonly k4: Float64Array;
  readonly k5: Float64Array;
  readonly k6: Float64Array;
  readonly k7: Float64Array;
}

/** Allocates fixed stage storage once for a state-vector dimension. */
export function createDp54Workspace(dimension: number): Dp54Workspace {
  return {
    dimension,
    stageState: new Float64Array(dimension),
    fourthOrderState: new Float64Array(dimension),
    fifthOrderState: new Float64Array(dimension),
    k1: new Float64Array(dimension),
    k2: new Float64Array(dimension),
    k3: new Float64Array(dimension),
    k4: new Float64Array(dimension),
    k5: new Float64Array(dimension),
    k6: new Float64Array(dimension),
    k7: new Float64Array(dimension),
  };
}

/** Allocates reusable propagation metadata. */
export function createDp54Result(): Dp54Result {
  return {
    reachedTimeSec: 0,
    acceptedSteps: 0,
    rejectedSteps: 0,
    nextStepSec: 0,
    reachedEnd: false,
    budgetExhausted: false,
    stepUnderflow: false,
  };
}

/** Creates the physics-spec.md section 3.1 tolerance profile for (r, u, tau). */
export function createShipDp54Tolerance(
  initialStepSec = 1,
  maxAcceptedSteps = 4_000,
): Dp54Tolerance {
  return {
    absolute: new Float64Array([1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-6]),
    relative: 1e-9,
    initialStepSec,
    maxAcceptedSteps,
  };
}

function controllerFactor(normalizedError: number): number {
  if (normalizedError === 0) {
    return MAX_STEP_FACTOR;
  }

  const proposed = STEP_SAFETY_FACTOR * Math.pow(1 / normalizedError, 1 / 5);
  return Math.min(MAX_STEP_FACTOR, Math.max(MIN_STEP_FACTOR, proposed));
}

/**
 * Propagates a generic float64 state into caller-owned storage without allocating.
 * The returned object is the same `result` instance supplied by the caller.
 */
export function propagate(
  outputState: Float64Array,
  initialState: Float64Array,
  startTimeSec: number,
  endTimeSec: number,
  derivative: Dp54Derivative,
  tolerance: Dp54Tolerance,
  workspace: Dp54Workspace,
  result: Dp54Result,
): Dp54Result {
  const dimension = workspace.dimension;
  for (let index = 0; index < dimension; index += 1) {
    outputState[index] = initialState[index] as number;
  }

  result.reachedTimeSec = startTimeSec;
  result.acceptedSteps = 0;
  result.rejectedSteps = 0;
  result.nextStepSec = 0;
  result.reachedEnd = startTimeSec === endTimeSec;
  result.budgetExhausted = false;
  result.stepUnderflow = false;

  if (result.reachedEnd) {
    return result;
  }

  if (tolerance.maxAcceptedSteps <= 0) {
    result.budgetExhausted = true;
    return result;
  }

  const direction = endTimeSec > startTimeSec ? 1 : -1;
  const intervalSec = Math.abs(endTimeSec - startTimeSec);
  let stepSec = direction * Math.min(Math.abs(tolerance.initialStepSec), intervalSec);
  let timeSec = startTimeSec;
  let hasFirstDerivative = false;

  while (timeSec !== endTimeSec && result.acceptedSteps < tolerance.maxAcceptedSteps) {
    if (direction * (timeSec + stepSec - endTimeSec) > 0) {
      stepSec = endTimeSec - timeSec;
    }

    if (timeSec + stepSec === timeSec) {
      result.stepUnderflow = true;
      break;
    }

    if (!hasFirstDerivative) {
      derivative(timeSec, outputState, workspace.k1);
      hasFirstDerivative = true;
    }

    for (let index = 0; index < dimension; index += 1) {
      workspace.stageState[index] =
        (outputState[index] as number) + stepSec * A21 * (workspace.k1[index] as number);
    }
    derivative(timeSec + C2 * stepSec, workspace.stageState, workspace.k2);

    for (let index = 0; index < dimension; index += 1) {
      workspace.stageState[index] =
        (outputState[index] as number) +
        stepSec * (A31 * (workspace.k1[index] as number) + A32 * (workspace.k2[index] as number));
    }
    derivative(timeSec + C3 * stepSec, workspace.stageState, workspace.k3);

    for (let index = 0; index < dimension; index += 1) {
      workspace.stageState[index] =
        (outputState[index] as number) +
        stepSec *
          (A41 * (workspace.k1[index] as number) +
            A42 * (workspace.k2[index] as number) +
            A43 * (workspace.k3[index] as number));
    }
    derivative(timeSec + C4 * stepSec, workspace.stageState, workspace.k4);

    for (let index = 0; index < dimension; index += 1) {
      workspace.stageState[index] =
        (outputState[index] as number) +
        stepSec *
          (A51 * (workspace.k1[index] as number) +
            A52 * (workspace.k2[index] as number) +
            A53 * (workspace.k3[index] as number) +
            A54 * (workspace.k4[index] as number));
    }
    derivative(timeSec + C5 * stepSec, workspace.stageState, workspace.k5);

    for (let index = 0; index < dimension; index += 1) {
      workspace.stageState[index] =
        (outputState[index] as number) +
        stepSec *
          (A61 * (workspace.k1[index] as number) +
            A62 * (workspace.k2[index] as number) +
            A63 * (workspace.k3[index] as number) +
            A64 * (workspace.k4[index] as number) +
            A65 * (workspace.k5[index] as number));
    }
    derivative(timeSec + stepSec, workspace.stageState, workspace.k6);

    for (let index = 0; index < dimension; index += 1) {
      workspace.fifthOrderState[index] =
        (outputState[index] as number) +
        stepSec *
          (B51 * (workspace.k1[index] as number) +
            B53 * (workspace.k3[index] as number) +
            B54 * (workspace.k4[index] as number) +
            B55 * (workspace.k5[index] as number) +
            B56 * (workspace.k6[index] as number));
    }
    derivative(timeSec + stepSec, workspace.fifthOrderState, workspace.k7);

    let normalizedError = 0;
    for (let index = 0; index < dimension; index += 1) {
      const fourthOrderValue =
        (outputState[index] as number) +
        stepSec *
          (B41 * (workspace.k1[index] as number) +
            B43 * (workspace.k3[index] as number) +
            B44 * (workspace.k4[index] as number) +
            B45 * (workspace.k5[index] as number) +
            B46 * (workspace.k6[index] as number) +
            B47 * (workspace.k7[index] as number));
      workspace.fourthOrderState[index] = fourthOrderValue;

      const currentMagnitude = Math.abs(outputState[index] as number);
      const candidateMagnitude = Math.abs(workspace.fifthOrderState[index] as number);
      const errorScale =
        (tolerance.absolute[index] as number) +
        tolerance.relative * Math.max(currentMagnitude, candidateMagnitude);
      const componentError =
        Math.abs((workspace.fifthOrderState[index] as number) - fourthOrderValue) / errorScale;
      normalizedError = Math.max(normalizedError, componentError);
    }

    const factor = controllerFactor(normalizedError);
    if (normalizedError <= 1) {
      timeSec += stepSec;
      if (direction * (endTimeSec - timeSec) <= 0) {
        timeSec = endTimeSec;
      }

      for (let index = 0; index < dimension; index += 1) {
        outputState[index] = workspace.fifthOrderState[index] as number;
        workspace.k1[index] = workspace.k7[index] as number;
      }
      result.acceptedSteps += 1;
      hasFirstDerivative = true;
    } else {
      result.rejectedSteps += 1;
    }

    stepSec *= factor;
  }

  result.reachedTimeSec = timeSec;
  result.nextStepSec = stepSec;
  result.reachedEnd = timeSec === endTimeSec;
  result.budgetExhausted =
    !result.reachedEnd &&
    !result.stepUnderflow &&
    result.acceptedSteps >= tolerance.maxAcceptedSteps;
  return result;
}
