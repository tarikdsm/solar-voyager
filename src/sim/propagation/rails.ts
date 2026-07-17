import {
  createCartesianState,
  createOrbitalConversionScratch,
  createOrbitalElements,
  elementsToStateInto,
  type CartesianState,
  type OrbitalConversionScratch,
  type OrbitalElements,
} from '../bodies/orbitalElements.js';

// physics-spec.md §2 — analytic Keplerian rails in parent-first catalog order.

/** Catalog fields needed to compile one analytic body rail. */
export interface RailsBodyInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly muKm3S2: number;
  readonly soiRadiusKm?: number | null;
  readonly elements: Readonly<OrbitalElements> | null;
}

/** Immutable structure-of-arrays catalog used by the frame-loop evaluator. */
export interface CompiledRailsCatalog {
  readonly bodyCount: number;
  readonly bodyIds: readonly string[];
  readonly parentIndices: Int32Array;
  readonly muKm3S2: Float64Array;
  readonly soiRadiiKm: Float64Array;
  readonly orbitalMuKm3S2: Float64Array;
  readonly meanMotionRadS: Float64Array;
  readonly semiMajorAxisKm: Float64Array;
  readonly eccentricity: Float64Array;
  readonly inclinationRad: Float64Array;
  readonly longitudeAscendingNodeRad: Float64Array;
  readonly argumentPeriapsisRad: Float64Array;
  readonly meanAnomalyAtEpochRad: Float64Array;
}

/** Caller-owned packed heliocentric body states cached for one simulation time. */
export interface RailsState {
  timeSec: number;
  evaluatedCatalog: CompiledRailsCatalog | null;
  readonly positionsKm: Float64Array;
  readonly velocitiesKmS: Float64Array;
}

/** Reusable scratch storage for allocation-free rails evaluation. */
export interface RailsWorkspace {
  readonly elements: OrbitalElements;
  readonly relativeState: CartesianState;
  readonly conversion: OrbitalConversionScratch;
}

function elementsAreFinite(elements: Readonly<OrbitalElements>): boolean {
  return (
    Number.isFinite(elements.semiMajorAxisKm) &&
    Number.isFinite(elements.eccentricity) &&
    Number.isFinite(elements.inclinationRad) &&
    Number.isFinite(elements.longitudeAscendingNodeRad) &&
    Number.isFinite(elements.argumentPeriapsisRad) &&
    Number.isFinite(elements.meanAnomalyRad)
  );
}

function elementsUseValidBranch(elements: Readonly<OrbitalElements>): boolean {
  const aKm = elements.semiMajorAxisKm;
  const eccentricity = elements.eccentricity;
  return (aKm > 0 && eccentricity >= 0 && eccentricity < 1) || (aKm < 0 && eccentricity > 1);
}

/** Validates and compiles setup-time catalog objects into float64 hot-path arrays. */
export function compileRailsCatalog(bodies: ReadonlyArray<RailsBodyInput>): CompiledRailsCatalog {
  const bodyCount = bodies.length;
  if (bodyCount === 0) {
    throw new RangeError('rails catalog must contain at least one body');
  }

  const bodyIds: string[] = [];
  const parentIndices = new Int32Array(bodyCount);
  parentIndices.fill(-1);
  const muKm3S2 = new Float64Array(bodyCount);
  const soiRadiiKm = new Float64Array(bodyCount);
  soiRadiiKm.fill(Number.POSITIVE_INFINITY);
  const orbitalMuKm3S2 = new Float64Array(bodyCount);
  const meanMotionRadS = new Float64Array(bodyCount);
  const semiMajorAxisKm = new Float64Array(bodyCount);
  const eccentricity = new Float64Array(bodyCount);
  const inclinationRad = new Float64Array(bodyCount);
  const longitudeAscendingNodeRad = new Float64Array(bodyCount);
  const argumentPeriapsisRad = new Float64Array(bodyCount);
  const meanAnomalyAtEpochRad = new Float64Array(bodyCount);
  const knownIndices = new Map<string, number>();

  for (let index = 0; index < bodyCount; index += 1) {
    const body = bodies[index];
    if (body === undefined) {
      throw new RangeError(`missing body at index ${index}`);
    }
    if (knownIndices.has(body.id)) {
      throw new Error(`duplicate body id: ${body.id}`);
    }
    if (!Number.isFinite(body.muKm3S2) || body.muKm3S2 <= 0) {
      throw new RangeError(`${body.id} GM must be finite and positive`);
    }
    if (
      body.soiRadiusKm !== undefined &&
      body.soiRadiusKm !== null &&
      (!Number.isFinite(body.soiRadiusKm) || body.soiRadiusKm <= 0)
    ) {
      throw new RangeError(`${body.id} SOI radius must be finite and positive`);
    }

    muKm3S2[index] = body.muKm3S2;
    if (body.soiRadiusKm !== undefined && body.soiRadiusKm !== null) {
      soiRadiiKm[index] = body.soiRadiusKm;
    }

    if (index === 0) {
      if (body.parentId !== null) {
        throw new Error('first body must be the root');
      }
      if (body.elements !== null) {
        throw new Error('root body must not have orbital elements');
      }
    } else {
      if (body.parentId === null) {
        throw new Error('only the first body may be the root');
      }
      const parentIndex = knownIndices.get(body.parentId);
      if (parentIndex === undefined) {
        throw new Error(`parent ${body.parentId} must precede ${body.id}`);
      }
      if (body.elements === null) {
        throw new Error(`${body.id} must have orbital elements`);
      }
      if (!elementsAreFinite(body.elements)) {
        throw new RangeError(`${body.id} orbital elements must be finite`);
      }
      if (!elementsUseValidBranch(body.elements)) {
        throw new RangeError(`${body.id} has an invalid elliptic or hyperbolic branch`);
      }

      const elements = body.elements;
      const parentMu = muKm3S2[parentIndex];
      if (parentMu === undefined) {
        throw new RangeError(`parent index ${parentIndex} is outside the compiled catalog`);
      }
      const absoluteSemiMajorAxisKm = Math.abs(elements.semiMajorAxisKm);
      const orbitalMu = parentMu + body.muKm3S2;
      parentIndices[index] = parentIndex;
      orbitalMuKm3S2[index] = orbitalMu;
      meanMotionRadS[index] = Math.sqrt(
        orbitalMu / (absoluteSemiMajorAxisKm * absoluteSemiMajorAxisKm * absoluteSemiMajorAxisKm),
      );
      semiMajorAxisKm[index] = elements.semiMajorAxisKm;
      eccentricity[index] = elements.eccentricity;
      inclinationRad[index] = elements.inclinationRad;
      longitudeAscendingNodeRad[index] = elements.longitudeAscendingNodeRad;
      argumentPeriapsisRad[index] = elements.argumentPeriapsisRad;
      meanAnomalyAtEpochRad[index] = elements.meanAnomalyRad;
    }

    knownIndices.set(body.id, index);
    bodyIds.push(body.id);
  }

  return {
    bodyCount,
    bodyIds,
    parentIndices,
    muKm3S2,
    soiRadiiKm,
    orbitalMuKm3S2,
    meanMotionRadS,
    semiMajorAxisKm,
    eccentricity,
    inclinationRad,
    longitudeAscendingNodeRad,
    argumentPeriapsisRad,
    meanAnomalyAtEpochRad,
  };
}

/** Allocates packed output arrays once for a compiled body catalog. */
export function createRailsState(catalog: CompiledRailsCatalog): RailsState {
  const componentCount = catalog.bodyCount * 3;
  return {
    timeSec: Number.NaN,
    evaluatedCatalog: null,
    positionsKm: new Float64Array(componentCount),
    velocitiesKmS: new Float64Array(componentCount),
  };
}

/** Allocates the single scratch set reused by every body and frame evaluation. */
export function createRailsWorkspace(): RailsWorkspace {
  return {
    elements: createOrbitalElements(),
    relativeState: createCartesianState(),
    conversion: createOrbitalConversionScratch(),
  };
}

/**
 * Evaluates all heliocentric body states at J2026-relative `timeSec` without allocating.
 * Parent-relative rails are accumulated in one parent-first pass (physics-spec.md §2).
 */
export function evaluateRailsInto(
  state: RailsState,
  catalog: CompiledRailsCatalog,
  timeSec: number,
  workspace: RailsWorkspace,
): RailsState {
  const expectedComponentCount = catalog.bodyCount * 3;
  if (
    state.positionsKm.length !== expectedComponentCount ||
    state.velocitiesKmS.length !== expectedComponentCount
  ) {
    throw new RangeError(`rails state arrays must contain ${expectedComponentCount} components`);
  }
  if (!Number.isFinite(timeSec)) {
    throw new RangeError('rails evaluation time must be finite');
  }
  if (state.timeSec === timeSec && state.evaluatedCatalog === catalog) {
    return state;
  }

  for (let index = 0; index < catalog.bodyCount; index += 1) {
    const componentIndex = index * 3;
    const parentIndex = catalog.parentIndices[index] as number;
    if (parentIndex < 0) {
      state.positionsKm[componentIndex] = 0;
      state.positionsKm[componentIndex + 1] = 0;
      state.positionsKm[componentIndex + 2] = 0;
      state.velocitiesKmS[componentIndex] = 0;
      state.velocitiesKmS[componentIndex + 1] = 0;
      state.velocitiesKmS[componentIndex + 2] = 0;
      continue;
    }

    workspace.elements.semiMajorAxisKm = catalog.semiMajorAxisKm[index] as number;
    workspace.elements.eccentricity = catalog.eccentricity[index] as number;
    workspace.elements.inclinationRad = catalog.inclinationRad[index] as number;
    workspace.elements.longitudeAscendingNodeRad = catalog.longitudeAscendingNodeRad[
      index
    ] as number;
    workspace.elements.argumentPeriapsisRad = catalog.argumentPeriapsisRad[index] as number;
    workspace.elements.meanAnomalyRad =
      (catalog.meanAnomalyAtEpochRad[index] as number) +
      (catalog.meanMotionRadS[index] as number) * timeSec;
    elementsToStateInto(
      workspace.relativeState,
      workspace.elements,
      catalog.orbitalMuKm3S2[index] as number,
      workspace.conversion,
    );

    const parentComponentIndex = parentIndex * 3;
    state.positionsKm[componentIndex] =
      workspace.relativeState.positionKm.x + (state.positionsKm[parentComponentIndex] as number);
    state.positionsKm[componentIndex + 1] =
      workspace.relativeState.positionKm.y +
      (state.positionsKm[parentComponentIndex + 1] as number);
    state.positionsKm[componentIndex + 2] =
      workspace.relativeState.positionKm.z +
      (state.positionsKm[parentComponentIndex + 2] as number);
    state.velocitiesKmS[componentIndex] =
      workspace.relativeState.velocityKmS.x + (state.velocitiesKmS[parentComponentIndex] as number);
    state.velocitiesKmS[componentIndex + 1] =
      workspace.relativeState.velocityKmS.y +
      (state.velocitiesKmS[parentComponentIndex + 1] as number);
    state.velocitiesKmS[componentIndex + 2] =
      workspace.relativeState.velocityKmS.z +
      (state.velocitiesKmS[parentComponentIndex + 2] as number);
  }

  state.timeSec = timeSec;
  state.evaluatedCatalog = catalog;
  return state;
}
