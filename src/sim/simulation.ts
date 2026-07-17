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
} from './simulationSnapshot.js';
import {
  createRelativisticDerivative,
  RELATIVISTIC_STATE_DIMENSION,
  type RelativisticAccelerationEvaluator,
} from './ship/relativity.js';

/** Setup-time inputs owned by one simulation core instance. */
export interface SimulationCoreOptions {
  readonly catalog: CompiledRailsCatalog;
  readonly initialShipState: Float64Array;
  readonly shipMassKg: number;
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
  private readonly clock: SimClock;
  private readonly snapshots: readonly [SimulationSnapshotBuffer, SimulationSnapshotBuffer];
  private readonly snapshotRailsStates: readonly [RailsState, RailsState];
  private readonly commandState: CommandState;
  private readonly integrationTolerance: Dp54Tolerance;
  private readonly integrationWorkspace: Dp54Workspace;
  private readonly integrationResult: Dp54Result;
  private readonly railsWorkspace: RailsWorkspace;
  private readonly gravityRailsState: RailsState;
  private readonly derivative: ReturnType<typeof createRelativisticDerivative>;
  private currentSnapshotIndex = 0;

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
    this.clock = createSimClock(initialTimeSec);
    this.integrationTolerance = options.integrationTolerance ?? createShipDp54Tolerance();
    this.integrationWorkspace = createDp54Workspace(RELATIVISTIC_STATE_DIMENSION);
    this.integrationResult = createDp54Result();
    this.railsWorkspace = createRailsWorkspace();
    this.gravityRailsState = createRailsState(this.catalog);

    const firstSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    const secondSnapshot = createSimulationSnapshotBuffer(this.catalog.bodyIds);
    this.snapshots = [firstSnapshot, secondSnapshot];
    this.snapshotRailsStates = [
      createSnapshotRailsState(firstSnapshot),
      createSnapshotRailsState(secondSnapshot),
    ];

    const commandController = createCommandController(this.catalog.bodyIds);
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
    const zeroProperAcceleration: RelativisticAccelerationEvaluator = (
      _timeSec,
      _state,
      outputAcceleration,
    ): void => {
      outputAcceleration[0] = 0;
      outputAcceleration[1] = 0;
      outputAcceleration[2] = 0;
    };
    this.derivative = createRelativisticDerivative(gravityEvaluator, zeroProperAcceleration);

    this.initializeSnapshot(firstSnapshot, this.snapshotRailsStates[0], options.initialShipState);
    this.initializeSnapshot(secondSnapshot, this.snapshotRailsStates[1], options.initialShipState);
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
    const currentSnapshot = this.currentSnapshotIndex === 0 ? this.snapshots[0] : this.snapshots[1];
    const nextSnapshot = nextSnapshotIndex === 0 ? this.snapshots[0] : this.snapshots[1];
    propagate(
      nextSnapshot.shipState,
      currentSnapshot.shipState,
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

    this.clock.timeSec = targetTimeSec;
    const nextRailsState =
      nextSnapshotIndex === 0 ? this.snapshotRailsStates[0] : this.snapshotRailsStates[1];
    this.fillSnapshot(nextSnapshot, nextRailsState);
    this.currentSnapshotIndex = nextSnapshotIndex;
    return nextSnapshot;
  }

  private initializeSnapshot(
    snapshot: SimulationSnapshotBuffer,
    railsState: RailsState,
    initialShipState: Float64Array,
  ): void {
    snapshot.shipState.set(initialShipState);
    this.fillSnapshot(snapshot, railsState);
  }

  private fillSnapshot(snapshot: SimulationSnapshotBuffer, railsState: RailsState): void {
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
    updateSnapshotDerivedState(snapshot, this.shipMassKg);
  }
}
