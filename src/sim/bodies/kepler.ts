// physics-spec.md §2 — Newton-Raphson Kepler solvers.

const CONVERGENCE_LIMIT_RAD = 1e-12;
const MAX_ITERATIONS = 30;

function sinhMinusArgument(argumentRad: number): number {
  if (Math.abs(argumentRad) >= 1) {
    return Math.sinh(argumentRad) - argumentRad;
  }

  const squared = argumentRad * argumentRad;
  return (
    argumentRad *
    squared *
    (1 / 6 +
      squared *
        (1 / 120 +
          squared *
            (1 / 5_040 +
              squared * (1 / 362_880 + squared * (1 / 39_916_800 + squared / 6_227_020_800)))))
  );
}

function hyperbolicResidual(
  anomalyRad: number,
  meanAnomalyRad: number,
  eccentricity: number,
): number {
  return (
    (eccentricity - 1) * anomalyRad + eccentricity * sinhMinusArgument(anomalyRad) - meanAnomalyRad
  );
}

/** Caller-owned output from a Kepler solve. */
export interface KeplerSolution {
  anomalyRad: number;
  iterations: number;
  converged: boolean;
}

/** Allocates result storage for reuse across anomaly solves. */
export function createKeplerSolution(): KeplerSolution {
  return { anomalyRad: 0, iterations: 0, converged: false };
}

/**
 * Solves `M = E - e·sin(E)` for `0 <= e < 1` into caller-owned storage.
 * Uses the initial guesses and limits specified by physics-spec.md §2.
 */
export function solveKeplerEllipticInto(
  output: KeplerSolution,
  meanAnomalyRad: number,
  eccentricity: number,
): KeplerSolution {
  const fullTurnRad = 2 * Math.PI;
  const completedTurns = Math.floor(meanAnomalyRad / fullTurnRad);
  const reducedMeanAnomalyRad = meanAnomalyRad - completedTurns * fullTurnRad;
  let anomalyRad = eccentricity > 0.8 ? Math.PI : reducedMeanAnomalyRad;

  output.converged = false;
  output.iterations = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const residualRad = anomalyRad - eccentricity * Math.sin(anomalyRad) - reducedMeanAnomalyRad;
    const derivative = 1 - eccentricity * Math.cos(anomalyRad);
    const deltaRad = residualRad / derivative;
    anomalyRad -= deltaRad;

    output.iterations = iteration;
    if (
      Math.abs(deltaRad) < CONVERGENCE_LIMIT_RAD &&
      Math.abs(anomalyRad - eccentricity * Math.sin(anomalyRad) - reducedMeanAnomalyRad) <
        CONVERGENCE_LIMIT_RAD
    ) {
      output.converged = true;
      break;
    }
  }

  output.anomalyRad = anomalyRad + completedTurns * fullTurnRad;
  return output;
}

/** Solves `M = e·sinh(H) - H` for `e > 1` into caller-owned storage. */
export function solveKeplerHyperbolicInto(
  output: KeplerSolution,
  meanAnomalyRad: number,
  eccentricity: number,
): KeplerSolution {
  const absoluteMeanAnomalyRad = Math.abs(meanAnomalyRad);
  let anomalyRad =
    meanAnomalyRad === 0
      ? 0
      : Math.sign(meanAnomalyRad) * Math.log((2 * absoluteMeanAnomalyRad) / eccentricity + 1.8);

  output.converged = false;
  output.iterations = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const residualRad = hyperbolicResidual(anomalyRad, meanAnomalyRad, eccentricity);
    const halfHyperbolicSine = Math.sinh(anomalyRad / 2);
    const derivative =
      eccentricity - 1 + 2 * eccentricity * halfHyperbolicSine * halfHyperbolicSine;
    const deltaRad = residualRad / derivative;
    anomalyRad -= deltaRad;

    output.iterations = iteration;
    if (
      Math.abs(deltaRad) < CONVERGENCE_LIMIT_RAD &&
      Math.abs(hyperbolicResidual(anomalyRad, meanAnomalyRad, eccentricity)) < CONVERGENCE_LIMIT_RAD
    ) {
      output.converged = true;
      break;
    }
  }

  output.anomalyRad = anomalyRad;
  return output;
}
