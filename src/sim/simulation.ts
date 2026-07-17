import { createSimClock, tdbSecondsToUtcTimeMs, type SimClock } from '../core/time.js';
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
  type RelativisticAccelerationEvaluator,
} from './ship/relativity.js';
import {
  evaluateBodyRateQuaternionInto,
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

/** Pure owner of simulation time, rails, ship propagation, ledger, and snapshots. */
export class SimulationCore {
  readonly commands: Commands;

  private readonly catalog: CompiledRailsCatalog;
  private readonly shipMassKg: number;
  private readonly maximumProperAccelerationKmS2: number;
  private readonly clock: SimClock;
  private readonly snapshots: readonly [SimulationSnapshotBuffer, SimulationSnapshotBuffer];
  private readonly shipStates: readonly [Float64Array, Float64Array];
  private readonly snapshotRailsStates: readonly [RailsState, RailsState];
  private readonly commandState: CommandState;
  private readonly integrationTolerance: Dp54Tolerance;
  private readonly integrationWorkspace: Dp54Workspace;
  private readonly integrationResult: Dp54Result;
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
  private readonly derivative: ReturnType<typeof createRelativisticDerivative>;
  private currentSnapshotIndex = 0;
  private stepStartTimeSec = 0;

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
    this.clock = createSimClock(initialTimeSec);
    this.stepStartTimeSec = initialTimeSec;
    this.integrationTolerance = options.integrationTolerance ?? createShipDp54Tolerance();
    this.integrationWorkspace = createDp54Workspace(RELATIVISTIC_STATE_DIMENSION);
    this.integrationResult = createDp54Result();
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

    const firstSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    const secondSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    this.snapshots = [firstSnapshot, secondSnapshot];
    const firstShipState = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const secondShipState = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
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
    this.derivative = createRelativisticDerivative(gravityEvaluator, properAccelerationEvaluator);

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

    const effectiveWarp = this.commandState.requestedWarp;
    const targetTimeSec = this.clock.timeSec + wallDeltaSec * effectiveWarp;
    if (!Number.isFinite(targetTimeSec)) {
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
    propagate(
      nextShipState,
      currentShipState,
      this.clock.timeSec,
      targetTimeSec,
      this.derivative,
      this.integrationTolerance,
      this.integrationWorkspace,
      this.integrationResult,
    );

    if (!this.integrationResult.reachedEnd) {
      if (this.integrationResult.budgetExhausted) {
        throw new Error('ship propagation exhausted the integration budget');
      }
      if (this.integrationResult.stepUnderflow) {
        throw new Error('ship propagation step underflow');
      }
      throw new Error('ship propagation produced a non-finite state');
    }

    this.evaluateAttitudeAndAcceleration(
      targetTimeSec,
      nextShipState,
      this.endpointAttitudeQuaternion,
      this.endpointProperAccelerationKmS2,
    );
    this.clock.timeSec = targetTimeSec;
    this.attitudeQuaternion.set(this.endpointAttitudeQuaternion);
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
    snapshot.shipState.set(shipState);
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
    snapshot.effectiveWarp = this.commandState.requestedWarp;
    snapshot.warpClampReason = WarpClampReason.NONE;
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
    updateSnapshotDerivedState(snapshot, this.shipMassKg);
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
