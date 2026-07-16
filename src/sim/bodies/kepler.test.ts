import { describe, expect, it } from 'vitest';

import {
  createKeplerSolution,
  solveKeplerEllipticInto,
  solveKeplerHyperbolicInto,
} from './kepler.js';

const RESIDUAL_LIMIT_RAD = 1e-12;

describe('Kepler solvers — physics-spec.md §2 / §7.1', () => {
  it('keeps elliptic residuals below the specified limit across e=[0, 0.99]', () => {
    const solution = createKeplerSolution();
    const eccentricities = [0, 0.2, 0.8, 0.81, 0.99];
    const meanAnomalies = [-Math.PI, -2, -0.1, 0, 0.1, 2, Math.PI];

    for (const eccentricity of eccentricities) {
      for (const meanAnomalyRad of meanAnomalies) {
        solveKeplerEllipticInto(solution, meanAnomalyRad, eccentricity);
        const residualRad =
          solution.anomalyRad - eccentricity * Math.sin(solution.anomalyRad) - meanAnomalyRad;

        expect(solution.converged).toBe(true);
        expect(solution.iterations).toBeLessThanOrEqual(30);
        expect(Math.abs(residualRad)).toBeLessThan(RESIDUAL_LIMIT_RAD);
      }
    }
  });

  it('keeps hyperbolic residuals below the specified limit across e=(1, 5]', () => {
    const solution = createKeplerSolution();
    const eccentricities = [1.01, 1.5, 3, 5];
    const meanAnomalies = [-5, -1, -0.01, 0, 0.01, 1, 5];

    for (const eccentricity of eccentricities) {
      for (const meanAnomalyRad of meanAnomalies) {
        solveKeplerHyperbolicInto(solution, meanAnomalyRad, eccentricity);
        const residualRad =
          eccentricity * Math.sinh(solution.anomalyRad) - solution.anomalyRad - meanAnomalyRad;

        expect(solution.converged).toBe(true);
        expect(solution.iterations).toBeLessThanOrEqual(30);
        expect(Math.abs(residualRad)).toBeLessThan(RESIDUAL_LIMIT_RAD);
      }
    }
  });

  it('reuses caller-owned result storage', () => {
    const solution = createKeplerSolution();

    expect(solveKeplerEllipticInto(solution, 0.5, 0.4)).toBe(solution);
    expect(solveKeplerHyperbolicInto(solution, 0.5, 1.4)).toBe(solution);
  });
});
