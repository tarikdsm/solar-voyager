// Shared driver that flies a solved intercept profile with the production DP54
// integrator (physics-spec.md section 8.6). Gravity is zeroed so the harness tests
// the guidance model on its own terms, which is exactly the model's scope.

import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../../../src/sim/propagation/dp54.js';
import type { InterceptSolution } from '../../../src/sim/guidance/constantAccelIntercept.js';
import {
  createRelativisticDerivative,
  RELATIVISTIC_STATE_DIMENSION,
} from '../../../src/sim/ship/relativity.js';

const MAX_HARNESS_STEPS = 400_000;

function writeZeroAcceleration(_timeSec: number, _state: Float64Array, output: Float64Array): void {
  output[0] = 0;
  output[1] = 0;
  output[2] = 0;
}

/**
 * Integrates `shipState` along `solution`'s boost/flip/brake program for
 * `fractionOfTotal` of its coordinate duration. Returns false if either leg ran
 * out of integration budget.
 */
export function flyInterceptProfile(
  outputState: Float64Array,
  shipState: Float64Array,
  solution: InterceptSolution,
  alphaMS2: number,
  startSimTimeSec: number,
  fractionOfTotal = 1,
): boolean {
  const alphaKmS2 = alphaMS2 / 1_000;
  const workspace = createDp54Workspace(RELATIVISTIC_STATE_DIMENSION);
  const result = createDp54Result();
  const tolerance = createShipDp54Tolerance(1, MAX_HARNESS_STEPS);
  const intermediate = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
  let sign = 1;
  const derivative = createRelativisticDerivative(
    writeZeroAcceleration,
    (_timeSec, _state, output) => {
      output[0] = sign * alphaKmS2 * (solution.aimUnit[0] as number);
      output[1] = sign * alphaKmS2 * (solution.aimUnit[1] as number);
      output[2] = sign * alphaKmS2 * (solution.aimUnit[2] as number);
    },
  );

  const elapsedSec = solution.totalCoordSec * fractionOfTotal;
  const flipSec = solution.flipAtCoordSec;
  if (elapsedSec <= flipSec) {
    propagate(
      outputState,
      shipState,
      startSimTimeSec,
      startSimTimeSec + elapsedSec,
      derivative,
      tolerance,
      workspace,
      result,
    );
    return result.reachedEnd;
  }

  propagate(
    intermediate,
    shipState,
    startSimTimeSec,
    startSimTimeSec + flipSec,
    derivative,
    tolerance,
    workspace,
    result,
  );
  const boostReachedEnd = result.reachedEnd;
  sign = -1;
  propagate(
    outputState,
    intermediate,
    startSimTimeSec + flipSec,
    startSimTimeSec + elapsedSec,
    derivative,
    tolerance,
    workspace,
    result,
  );
  return boostReachedEnd && result.reachedEnd;
}
