import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import {
  MAX_THRUST_WARP,
  WARP_LADDER,
  createSimClock,
  tdbSecondsToUtcTimeMs,
  type SimClock,
  type WarpFactor,
} from '../core/time.js';
import { evaluateBarycenterInto } from './analysis/barycenter.js';
import { updateSnapshotDerivedState } from './analysis/snapshotDerived.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
  type Dp54Result,
  type Dp54Tolerance,
  type Dp54Workspace,
} from './propagation/dp54.js';
import { evaluateNBodyAccelerationInto } from './propagation/nbodyForces.js';
import {
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
  type RailsState,
  type RailsWorkspace,
} from './propagation/rails.js';
import {
  createCommandController,
  createSimulationSnapshotBuffer,
  WarpClampReason,
  type Commands,
  type CommandState,
  type SimSnapshot,
  type SimulationSnapshotBuffer,
  type TrajectoryInvalidationListener,
} from './simulationSnapshot.js';
import {
  coordinateVelocityInto,
  createRelativisticDerivative,
  RELATIVISTIC_STATE_DIMENSION,
  relativisticKineticEnergyJ,
  type RelativisticAccelerationEvaluator,
} from './ship/relativity.js';
import {
  evaluateBodyRateQuaternionInto,
  selectMaximumGravityBodyIndex,
  writeAttitudeDirectionInto,
  writeForwardFromQuaternionInto,
  writeQuaternionFromForwardInto,
} from './ship/attitude.js';
import {
  DEFAULT_MAX_PROPER_ACCELERATION_M_S2,
  photonDrivePowerW,
  validateMaxProperAcceleration,
  writeProperAccelerationInto,
  writeThrustForceInto,
} from './ship/thrust.js';
import {
  createBurnLog,
  SIMULATION_STATE_DIMENSION,
  STATE_ENERGY_J,
  STATE_PROPER_DELTA_V_MS,
  STATE_PROPER_DELTA_V_VECTOR_X_MS,
  STATE_PROPER_DELTA_V_VECTOR_Y_MS,
  STATE_PROPER_DELTA_V_VECTOR_Z_MS,
  writeLedgerDerivativeRates,
  type BurnLogRecorder,
  type BurnLogView,
} from './ship/ledger.js';

/** Setup-time inputs owned by one simulation core instance. */
export interface SimulationCoreOptions {
  readonly catalog: CompiledRailsCatalog;
  readonly initialShipState: Float64Array;
  readonly shipMassKg: number;
  readonly maxProperAccelerationMS2?: number;
  readonly onTrajectoryInvalidated?: TrajectoryInvalidationListener;
  readonly initialTimeSec?: number;
  readonly integrationTolerance?: Dp54Tolerance;
}

function createSnapshotRailsState(snapshot: SimulationSnapshotBuffer): RailsState {
  return {
    timeSec: Number.NaN,
    evaluatedCatalog: null,
    positionsKm: snapshot.bodyPositionsKm,
    velocitiesKmS: snapshot.bodyVelocitiesKmS,
  };
}

function validateInitialState(initialShipState: Float64Array): void {
  if (initialShipState.length !== RELATIVISTIC_STATE_DIMENSION) {
    throw new RangeError('initial ship state must contain seven components');
  }
  for (let index = 0; index < initialShipState.length; index += 1) {
    if (!Number.isFinite(initialShipState[index])) {
      throw new RangeError('initial ship state components must be finite');
    }
  }
}

function createSimulationTolerance(source: Dp54Tolerance): Dp54Tolerance {
  if (source.absolute.length !== RELATIVISTIC_STATE_DIMENSION) {
    throw new RangeError('ship integration tolerance must contain seven absolute components');
  }
  const absolute = new Float64Array(SIMULATION_STATE_DIMENSION);
  absolute.set(source.absolute);
  absolute[STATE_ENERGY_J] = 1;
  absolute[STATE_PROPER_DELTA_V_MS] = 1e-6;
  absolute[STATE_PROPER_DELTA_V_VECTOR_X_MS] = 1e-6;
  absolute[STATE_PROPER_DELTA_V_VECTOR_Y_MS] = 1e-6;
  absolute[STATE_PROPER_DELTA_V_VECTOR_Z_MS] = 1e-6;
  return {
    absolute,
    relative: source.relative,
    initialStepSec: source.initialStepSec,
    maxAcceptedSteps: source.maxAcceptedSteps,
  };
}

function normalizeInto(output: Float64Array, x: number, y: number, z: number): void {
  const magnitude = Math.hypot(x, y, z);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    output.fill(0);
    return;
  }
  output[0] = x / magnitude;
  output[1] = y / magnitude;
  output[2] = z / magnitude;
}

/** Pure owner of simulation time, rails, ship propagation, ledger, and snapshots. */
export class SimulationCore {
  readonly commands: Commands;
  readonly burnLog: BurnLogView;

  private readonly catalog: CompiledRailsCatalog;
  private readonly shipMassKg: number;
  private readonly maximumProperAccelerationKmS2: number;
  private readonly initialKineticEnergyJ: number;
  private readonly burnLogRecorder: BurnLogRecorder;
  private readonly clock: SimClock;
  private readonly snapshots: readonly [SimulationSnapshotBuffer, SimulationSnapshotBuffer];
  private readonly shipStates: readonly [Float64Array, Float64Array];
  private readonly snapshotRailsStates: readonly [RailsState, RailsState];
  private readonly commandState: CommandState;
  private readonly integrationTolerance: Dp54Tolerance;
  private readonly integrationSegmentTolerance: Dp54Tolerance;
  private readonly integrationWorkspace: Dp54Workspace;
  private readonly integrationResult: Dp54Result;
  private readonly checkpointShipState: Float64Array;
  private readonly railsWorkspace: RailsWorkspace;
  private readonly gravityRailsState: RailsState;
  private readonly attitudeQuaternion: Float64Array;
  private readonly stepStartAttitudeQuaternion: Float64Array;
  private readonly stageAttitudeQuaternion: Float64Array;
  private readonly endpointAttitudeQuaternion: Float64Array;
  private readonly angularVelocityBodyRadS: Float64Array;
  private readonly attitudeDirection: Float64Array;
  private readonly attitudeCoordinateVelocityKmS: Float64Array;
  private readonly endpointProperAccelerationKmS2: Float64Array;
  private readonly burnProgradeBasis: Float64Array;
  private readonly burnNormalBasis: Float64Array;
  private readonly burnRadialBasis: Float64Array;
  private readonly derivative: ReturnType<typeof createRelativisticDerivative>;
  private currentSnapshotIndex = 0;
  private stepStartTimeSec = 0;
  private effectiveWarp: WarpFactor = 1;
  private warpClampReason: WarpClampReason = WarpClampReason.NONE;

  constructor(options: SimulationCoreOptions) {
    validateInitialState(options.initialShipState);
    if (!Number.isFinite(options.shipMassKg) || options.shipMassKg <= 0) {
      throw new RangeError('ship mass must be finite and positive');
    }
    const initialTimeSec = options.initialTimeSec ?? 0;
    if (!Number.isFinite(initialTimeSec)) {
      throw new RangeError('initial simulation time must be finite');
    }

    this.catalog = options.catalog;
    this.shipMassKg = options.shipMassKg;
    this.maximumProperAccelerationKmS2 = validateMaxProperAcceleration(
      options.maxProperAccelerationMS2 ?? DEFAULT_MAX_PROPER_ACCELERATION_M_S2,
    );
    this.initialKineticEnergyJ = relativisticKineticEnergyJ(
      options.initialShipState[3] as number,
      options.initialShipState[4] as number,
      options.initialShipState[5] as number,
      this.shipMassKg,
    );
    const burnLogController = createBurnLog();
    this.burnLog = burnLogController.view;
    this.burnLogRecorder = burnLogController.recorder;
    this.clock = createSimClock(initialTimeSec);
    this.stepStartTimeSec = initialTimeSec;
    this.integrationTolerance = createSimulationTolerance(
      options.integrationTolerance ?? createShipDp54Tolerance(),
    );
    this.integrationSegmentTolerance = {
      absolute: this.integrationTolerance.absolute,
      relative: this.integrationTolerance.relative,
      initialStepSec: this.integrationTolerance.initialStepSec,
      maxAcceptedSteps: this.integrationTolerance.maxAcceptedSteps,
    };
    this.integrationWorkspace = createDp54Workspace(SIMULATION_STATE_DIMENSION);
    this.integrationResult = createDp54Result();
    this.checkpointShipState = new Float64Array(SIMULATION_STATE_DIMENSION);
    this.railsWorkspace = createRailsWorkspace();
    this.gravityRailsState = createRailsState(this.catalog);
    this.attitudeQuaternion = new Float64Array([0, 0, 0, 1]);
    this.stepStartAttitudeQuaternion = new Float64Array([0, 0, 0, 1]);
    this.stageAttitudeQuaternion = new Float64Array(4);
    this.endpointAttitudeQuaternion = new Float64Array(4);
    this.angularVelocityBodyRadS = new Float64Array(3);
    this.attitudeDirection = new Float64Array(3);
    this.attitudeCoordinateVelocityKmS = new Float64Array(3);
    this.endpointProperAccelerationKmS2 = new Float64Array(3);
    this.burnProgradeBasis = new Float64Array(3);
    this.burnNormalBasis = new Float64Array(3);
    this.burnRadialBasis = new Float64Array(3);

    const firstSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    const secondSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    this.snapshots = [firstSnapshot, secondSnapshot];
    const firstShipState = new Float64Array(SIMULATION_STATE_DIMENSION);
    const secondShipState = new Float64Array(SIMULATION_STATE_DIMENSION);
    firstShipState.set(options.initialShipState);
    secondShipState.set(options.initialShipState);
    this.shipStates = [firstShipState, secondShipState];
    this.snapshotRailsStates = [
      createSnapshotRailsState(firstSnapshot),
      createSnapshotRailsState(secondSnapshot),
    ];

    const commandController = createCommandController(
      this.catalog.bodyIds,
      options.onTrajectoryInvalidated ?? null,
      (_previousThrottle, nextThrottle) => {
        this.handleThrottleChange(nextThrottle);
      },
    );
    this.commands = commandController.commands;
    this.commandState = commandController.state;

    const gravityEvaluator: RelativisticAccelerationEvaluator = (
      timeSec,
      state,
      outputAcceleration,
    ): void => {
      evaluateRailsInto(this.gravityRailsState, this.catalog, timeSec, this.railsWorkspace);
      evaluateNBodyAccelerationInto(
        outputAcceleration,
        state,
        this.catalog.muKm3S2,
        this.gravityRailsState.positionsKm,
      );
    };
    const properAccelerationEvaluator: RelativisticAccelerationEvaluator = (
      timeSec,
      state,
      outputAcceleration,
    ): void => {
      this.evaluateAttitudeAndAcceleration(
        timeSec,
        state,
        this.stageAttitudeQuaternion,
        outputAcceleration,
      );
    };
    this.derivative = createRelativisticDerivative(
      gravityEvaluator,
      properAccelerationEvaluator,
      (outputDerivative, properAccelerationKmS2, inverseGamma) => {
        writeLedgerDerivativeRates(
          outputDerivative,
          properAccelerationKmS2,
          inverseGamma,
          this.shipMassKg,
        );
      },
    );

    this.evaluateAttitudeAndAcceleration(
      initialTimeSec,
      firstShipState,
      this.endpointAttitudeQuaternion,
      this.endpointProperAccelerationKmS2,
    );
    this.attitudeQuaternion.set(this.endpointAttitudeQuaternion);
    this.initializeSnapshot(firstSnapshot, this.snapshotRailsStates[0], firstShipState);
    this.initializeSnapshot(secondSnapshot, this.snapshotRailsStates[1], secondShipState);
  }

  /** Latest completely published frame. */
  get snapshot(): SimSnapshot {
    return this.currentSnapshotIndex === 0 ? this.snapshots[0] : this.snapshots[1];
  }

  /** Advances coordinate time and publishes the next immutable-per-frame snapshot. */
  step(wallDeltaSec: number): SimSnapshot {
    if (!Number.isFinite(wallDeltaSec) || wallDeltaSec < 0) {
      throw new RangeError('wall delta must be finite and non-negative');
    }

    const requestedWarp = this.commandState.requestedWarp;
    const requestedTargetTimeSec = this.clock.timeSec + wallDeltaSec * requestedWarp;
    if (!Number.isFinite(requestedTargetTimeSec)) {
      throw new RangeError('simulation endpoint must be finite');
    }

    const nextSnapshotIndex = this.currentSnapshotIndex === 0 ? 1 : 0;
    const nextSnapshot = nextSnapshotIndex === 0 ? this.snapshots[0] : this.snapshots[1];
    const currentShipState =
      this.currentSnapshotIndex === 0 ? this.shipStates[0] : this.shipStates[1];
    const nextShipState = nextSnapshotIndex === 0 ? this.shipStates[0] : this.shipStates[1];
    this.stepStartTimeSec = this.clock.timeSec;
    this.stepStartAttitudeQuaternion.set(this.attitudeQuaternion);
    this.angularVelocityBodyRadS[0] = this.commandState.rotationRatesRadS[2] as number;
    this.angularVelocityBodyRadS[1] = this.commandState.rotationRatesRadS[0] as number;
    this.angularVelocityBodyRadS[2] = this.commandState.rotationRatesRadS[1] as number;
    this.checkpointShipState.set(currentShipState);

    const requestedWarpIndex = WARP_LADDER.indexOf(requestedWarp);
    const frameStartTimeSec = this.clock.timeSec;
    const frameStepBudget = this.integrationTolerance.maxAcceptedSteps;
    let acceptedSteps = 0;
    let segmentStartTimeSec = frameStartTimeSec;
    let suggestedStepSec = this.integrationTolerance.initialStepSec;
    let completedWarp: WarpFactor | null = null;
    let budgetExhausted = false;

    for (let warpIndex = 0; warpIndex <= requestedWarpIndex; warpIndex += 1) {
      const candidateWarp = WARP_LADDER[warpIndex] as WarpFactor;
      const candidateTimeSec = frameStartTimeSec + wallDeltaSec * candidateWarp;
      this.integrationSegmentTolerance.initialStepSec = suggestedStepSec;
      this.integrationSegmentTolerance.maxAcceptedSteps = frameStepBudget - acceptedSteps;
      propagate(
        nextShipState,
        this.checkpointShipState,
        segmentStartTimeSec,
        candidateTimeSec,
        this.derivative,
        this.integrationSegmentTolerance,
        this.integrationWorkspace,
        this.integrationResult,
      );
      acceptedSteps += this.integrationResult.acceptedSteps;

      if (this.integrationResult.reachedEnd) {
        this.checkpointShipState.set(nextShipState);
        segmentStartTimeSec = candidateTimeSec;
        completedWarp = candidateWarp;
        if (this.integrationResult.nextStepSec !== 0) {
          suggestedStepSec = this.integrationResult.nextStepSec;
        }
        continue;
      }
      if (this.integrationResult.budgetExhausted) {
        budgetExhausted = true;
        break;
      }
      if (this.integrationResult.stepUnderflow) {
        throw new Error('ship propagation step underflow');
      }
      throw new Error('ship propagation produced a non-finite state');
    }

    if (completedWarp === null) {
      throw new Error('ship propagation exhausted the integration budget');
    }

    const targetTimeSec = frameStartTimeSec + wallDeltaSec * completedWarp;
    if (budgetExhausted) nextShipState.set(this.checkpointShipState);

    this.evaluateAttitudeAndAcceleration(
      targetTimeSec,
      nextShipState,
      this.endpointAttitudeQuaternion,
      this.endpointProperAccelerationKmS2,
    );
    this.clock.timeSec = targetTimeSec;
    this.attitudeQuaternion.set(this.endpointAttitudeQuaternion);
    if (targetTimeSec > this.stepStartTimeSec && this.commandState.throttle > 0) {
      this.burnLogRecorder.notePeakPower(this.powerForThrottle(this.commandState.throttle));
    }
    this.synchronizeActiveBurn(nextShipState);
    this.effectiveWarp = completedWarp;
    this.warpClampReason = budgetExhausted
      ? WarpClampReason.INTEGRATION_BUDGET
      : requestedWarp > MAX_THRUST_WARP
        ? WarpClampReason.THRUST_LOCKOUT
        : WarpClampReason.NONE;
    const nextRailsState =
      nextSnapshotIndex === 0 ? this.snapshotRailsStates[0] : this.snapshotRailsStates[1];
    this.fillSnapshot(nextSnapshot, nextRailsState, nextShipState);
    this.currentSnapshotIndex = nextSnapshotIndex;
    return nextSnapshot;
  }

  private initializeSnapshot(
    snapshot: SimulationSnapshotBuffer,
    railsState: RailsState,
    shipState: Float64Array,
  ): void {
    this.fillSnapshot(snapshot, railsState, shipState);
  }

  private fillSnapshot(
    snapshot: SimulationSnapshotBuffer,
    railsState: RailsState,
    shipState: Float64Array,
  ): void {
    for (let index = 0; index < RELATIVISTIC_STATE_DIMENSION; index += 1) {
      snapshot.shipState[index] = shipState[index] as number;
    }
    evaluateRailsInto(railsState, this.catalog, this.clock.timeSec, this.railsWorkspace);
    evaluateBarycenterInto(
      snapshot.barycenterPositionKm,
      snapshot.barycenterVelocityKmS,
      this.catalog.muKm3S2,
      snapshot.bodyPositionsKm,
      snapshot.bodyVelocitiesKmS,
    );

    snapshot.simTimeSec = this.clock.timeSec;
    snapshot.utcTimeMs = tdbSecondsToUtcTimeMs(this.clock.timeSec);
    snapshot.requestedWarp = this.commandState.requestedWarp;
    snapshot.effectiveWarp = this.effectiveWarp;
    snapshot.warpClampReason = this.warpClampReason;
    snapshot.throttle = this.commandState.throttle;
    snapshot.attitudeMode = this.commandState.attitudeMode;
    snapshot.targetBodyIndex = this.commandState.targetBodyIndex;
    snapshot.targetBodyId = this.commandState.targetBodyId;
    snapshot.attitudeQuaternion.set(this.attitudeQuaternion);
    snapshot.shipProperAccelerationKmS2.set(this.endpointProperAccelerationKmS2);
    writeThrustForceInto(
      snapshot.shipThrustVectorN,
      this.endpointProperAccelerationKmS2,
      this.shipMassKg,
    );
    snapshot.powerDrawW = photonDrivePowerW(this.endpointProperAccelerationKmS2, this.shipMassKg);
    snapshot.energySpentJ = shipState[STATE_ENERGY_J] as number;
    snapshot.properDeltaVMS = shipState[STATE_PROPER_DELTA_V_MS] as number;
    snapshot.kineticEnergyChangeJ =
      relativisticKineticEnergyJ(
        shipState[3] as number,
        shipState[4] as number,
        shipState[5] as number,
        this.shipMassKg,
      ) - this.initialKineticEnergyJ;
    updateSnapshotDerivedState(snapshot, this.shipMassKg);
  }

  private currentPrivateShipState(): Float64Array {
    return this.currentSnapshotIndex === 0 ? this.shipStates[0] : this.shipStates[1];
  }

  private powerForThrottle(throttle: number): number {
    return (
      this.shipMassKg *
      throttle *
      this.maximumProperAccelerationKmS2 *
      1_000 *
      SPEED_OF_LIGHT_KM_S *
      1_000
    );
  }

  private handleThrottleChange(nextThrottle: number): void {
    const state = this.currentPrivateShipState();
    if (nextThrottle <= 0) {
      this.synchronizeActiveBurn(state);
      this.burnLogRecorder.end();
      return;
    }
    if (this.burnLog.activeBurn !== null) {
      return;
    }
    evaluateRailsInto(
      this.gravityRailsState,
      this.catalog,
      this.clock.timeSec,
      this.railsWorkspace,
    );
    coordinateVelocityInto(
      this.attitudeCoordinateVelocityKmS,
      state[3] as number,
      state[4] as number,
      state[5] as number,
    );
    const dominantBodyIndex = selectMaximumGravityBodyIndex(
      state,
      this.catalog.muKm3S2,
      this.gravityRailsState.positionsKm,
    );
    this.writeBurnBasis(state, dominantBodyIndex);
    this.burnLogRecorder.begin(
      this.clock.timeSec,
      state[6] as number,
      state[STATE_ENERGY_J] as number,
      state[STATE_PROPER_DELTA_V_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_X_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_Y_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_Z_MS] as number,
      dominantBodyIndex < 0 ? null : (this.catalog.bodyIds[dominantBodyIndex] ?? null),
      this.burnProgradeBasis,
      this.burnNormalBasis,
      this.burnRadialBasis,
      0,
    );
  }

  private synchronizeActiveBurn(state: Float64Array): void {
    this.burnLogRecorder.synchronize(
      this.clock.timeSec,
      state[6] as number,
      state[STATE_ENERGY_J] as number,
      state[STATE_PROPER_DELTA_V_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_X_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_Y_MS] as number,
      state[STATE_PROPER_DELTA_V_VECTOR_Z_MS] as number,
    );
  }

  private writeBurnBasis(state: Float64Array, bodyIndex: number): void {
    if (bodyIndex < 0) {
      this.burnProgradeBasis.fill(0);
      this.burnNormalBasis.fill(0);
      this.burnRadialBasis.fill(0);
      return;
    }
    const offset = bodyIndex * 3;
    const rx = (state[0] as number) - (this.gravityRailsState.positionsKm[offset] as number);
    const ry = (state[1] as number) - (this.gravityRailsState.positionsKm[offset + 1] as number);
    const rz = (state[2] as number) - (this.gravityRailsState.positionsKm[offset + 2] as number);
    const vx =
      (this.attitudeCoordinateVelocityKmS[0] as number) -
      (this.gravityRailsState.velocitiesKmS[offset] as number);
    const vy =
      (this.attitudeCoordinateVelocityKmS[1] as number) -
      (this.gravityRailsState.velocitiesKmS[offset + 1] as number);
    const vz =
      (this.attitudeCoordinateVelocityKmS[2] as number) -
      (this.gravityRailsState.velocitiesKmS[offset + 2] as number);
    normalizeInto(this.burnProgradeBasis, vx, vy, vz);
    normalizeInto(this.burnRadialBasis, rx, ry, rz);
    normalizeInto(this.burnNormalBasis, ry * vz - rz * vy, rz * vx - rx * vz, rx * vy - ry * vx);
  }

  private evaluateAttitudeAndAcceleration(
    timeSec: number,
    shipState: Float64Array,
    outputAttitudeQuaternion: Float64Array,
    outputProperAccelerationKmS2: Float64Array,
  ): void {
    if (this.commandState.attitudeMode === 'manual') {
      evaluateBodyRateQuaternionInto(
        outputAttitudeQuaternion,
        this.stepStartAttitudeQuaternion,
        this.angularVelocityBodyRadS,
        timeSec - this.stepStartTimeSec,
      );
      writeForwardFromQuaternionInto(this.attitudeDirection, outputAttitudeQuaternion);
    } else {
      evaluateRailsInto(this.gravityRailsState, this.catalog, timeSec, this.railsWorkspace);
      coordinateVelocityInto(
        this.attitudeCoordinateVelocityKmS,
        shipState[3] as number,
        shipState[4] as number,
        shipState[5] as number,
      );
      writeAttitudeDirectionInto(
        this.attitudeDirection,
        this.commandState.attitudeMode,
        shipState,
        this.attitudeCoordinateVelocityKmS,
        this.catalog.muKm3S2,
        this.gravityRailsState.positionsKm,
        this.gravityRailsState.velocitiesKmS,
        this.commandState.targetBodyIndex,
        this.stepStartAttitudeQuaternion,
      );
      writeQuaternionFromForwardInto(
        outputAttitudeQuaternion,
        this.attitudeDirection[0] as number,
        this.attitudeDirection[1] as number,
        this.attitudeDirection[2] as number,
      );
    }
    writeProperAccelerationInto(
      outputProperAccelerationKmS2,
      this.attitudeDirection,
      this.commandState.throttle,
      this.maximumProperAccelerationKmS2,
    );
  }
}
