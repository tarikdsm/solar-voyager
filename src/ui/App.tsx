import { useComputed } from '@preact/signals';
import { useCallback, useRef, useState } from 'preact/hooks';

import { WARP_LADDER, type WarpFactor } from '../core/time.js';
import { createScaffoldState } from '../game/createScaffoldState.js';
import type { GamePhase, SceneManager } from '../game/sceneManager.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import './app.css';
import { PerfPanel } from './hud/PerfPanel.js';
import type { PerfPanelStore } from './hud/perfPanelStore.js';
import type { HudDisplaySignals, HudSignals } from './hudSignals.js';
import { MainMenu } from './MainMenu.js';
import { Navball } from './Navball.js';
import { SessionSettingsPanel, type SessionSettingsPort } from './SessionSettingsPanel.js';
import { StateVectorPanel } from './StateVectorPanel.js';
import type { StateVectorSignalStore } from './stateVectorSignals.js';
import { TrajectoryImpactWarning } from './TrajectoryImpactWarning.js';
import type { TrajectoryPredictionSignalStore } from './trajectoryPredictionSignals.js';

const scaffoldState = createScaffoldState();
const WARP_NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export interface HardwareAccelerationWarningData {
  readonly rendererName: string;
}

export interface AppProps {
  readonly hud: HudDisplaySignals;
  readonly hudState: HudSignals;
  readonly commands: Commands;
  readonly bodyIds: readonly string[];
  readonly hardwareWarning?: HardwareAccelerationWarningData | null;
  readonly initialPhase?: GamePhase;
  readonly onSpacePhaseEntered?: (() => void) | null;
  readonly perfPanel?: PerfPanelStore | null;
  readonly sceneManager?: SceneManager | null;
  readonly session?: SessionSettingsPort | null;
  readonly stateVectors?: StateVectorSignalStore | null;
  readonly stateVectorViewportRef?: ((element: HTMLDivElement | null) => void) | null;
  readonly trajectoryPrediction?: TrajectoryPredictionSignalStore | null;
}

interface ReadoutValueProps {
  readonly label: string;
  readonly value: HudDisplaySignals[keyof HudDisplaySignals];
  readonly valueId?: string;
}

function ReadoutValue({ label, value, valueId }: ReadoutValueProps) {
  return (
    <div class="hud-readout-row">
      <dt>{label}</dt>
      <dd id={valueId}>{value}</dd>
    </div>
  );
}

export function OrbitReadout({ hud }: { readonly hud: HudDisplaySignals }) {
  return (
    <section id="orbit-readout" class="hud-panel orbit-readout" aria-labelledby="orbit-title">
      <header>
        <p class="hud-kicker">Osculating orbit</p>
        <h2 id="orbit-title">{hud.dominantBody}</h2>
      </header>
      <dl>
        <ReadoutValue label="Apoapsis" value={hud.apoapsis} />
        <ReadoutValue label="Periapsis" value={hud.periapsis} />
        <ReadoutValue label="Eccentricity" value={hud.eccentricity} />
        <ReadoutValue label="Inclination" value={hud.inclination} />
        <ReadoutValue label="Period" value={hud.period} />
      </dl>
    </section>
  );
}

export function DualClock({ hud }: { readonly hud: HudDisplaySignals }) {
  return (
    <section id="dual-clock" class="hud-panel dual-clock" aria-label="Simulation clocks">
      <div class="clock-block">
        <span class="hud-kicker">Coordinate UTC</span>
        <time id="coordinate-clock">{hud.coordinateUtc}</time>
      </div>
      <span id="relativistic-gamma" class="clock-gamma">
        {hud.gamma}
      </span>
      <div class="clock-block">
        <span class="hud-kicker">Ship MET · proper time τ</span>
        <time id="proper-time-clock">{hud.missionElapsedTime}</time>
      </div>
    </section>
  );
}

function warpLabel(warp: WarpFactor): string {
  return `${WARP_NUMBER_FORMAT.format(warp)}×`;
}

function bodyLabel(bodyId: string): string {
  return bodyId.replace(
    /(^|[-_])(\p{L})/gu,
    (_match, separator: string, letter: string) =>
      `${separator.length === 0 ? '' : ' '}${letter.toUpperCase()}`,
  );
}

function WarpButton({
  commands,
  hudState,
  warp,
}: {
  readonly commands: Commands;
  readonly hudState: HudSignals;
  readonly warp: WarpFactor;
}) {
  const selected = useComputed(() => hudState.requestedWarp.value === warp);
  return (
    <button type="button" aria-pressed={selected} onClick={() => commands.setWarp(warp)}>
      {warpLabel(warp)}
    </button>
  );
}

export function WarpControl({
  commands,
  hud,
  hudState,
}: {
  readonly commands: Commands;
  readonly hud: HudDisplaySignals;
  readonly hudState: HudSignals;
}) {
  return (
    <section id="warp-control" class="hud-panel warp-control" aria-label="Time warp control">
      <header>
        <span class="hud-kicker">Time warp</span>
        <strong>
          <span>{hud.effectiveWarp}</span>
          <small> effective</small>
        </strong>
      </header>
      <div class="warp-ladder">
        {WARP_LADDER.map((warp) => (
          <WarpButton key={warp} commands={commands} hudState={hudState} warp={warp} />
        ))}
      </div>
      <p id="warp-clamp-status" class="warp-clamp-status" aria-live="polite">
        {hud.warpClamp}
      </p>
    </section>
  );
}

export function EnergyPanel({ hud }: { readonly hud: HudDisplaySignals }) {
  return (
    <section id="energy-panel" class="hud-panel energy-panel" aria-labelledby="energy-title">
      <header>
        <p class="hud-kicker">Photon-drive ledger</p>
        <h2 id="energy-title">{hud.energySpent}</h2>
      </header>
      <dl>
        <ReadoutValue label="Power" value={hud.powerDraw} />
        <ReadoutValue label="Proper Δv" value={hud.properDeltaV} />
        <ReadoutValue label="ΔE kinetic" value={hud.kineticEnergyChange} />
      </dl>
      <div class="burn-summary" aria-labelledby="burn-summary-title">
        <h3 id="burn-summary-title">{hud.burnSummaryLabel}</h3>
        <dl>
          <ReadoutValue label="Energy" value={hud.burnEnergy} valueId="burn-energy" />
          <ReadoutValue label="Proper Δv" value={hud.burnProperDeltaV} valueId="burn-delta-v" />
        </dl>
      </div>
    </section>
  );
}

export function TargetPanel({
  bodyIds,
  commands,
  hud,
  hudState,
  trajectoryPrediction = null,
}: {
  readonly bodyIds: readonly string[];
  readonly commands: Commands;
  readonly hud: HudDisplaySignals;
  readonly hudState: HudSignals;
  readonly trajectoryPrediction?: TrajectoryPredictionSignalStore | null;
}) {
  const selectedTarget = useComputed(() => hudState.targetBodyId.value ?? '');
  return (
    <section id="target-panel" class="hud-panel target-panel" aria-labelledby="target-title">
      <label class="hud-kicker" for="target-selector">
        Navigation target
      </label>
      <select
        id="target-selector"
        value={selectedTarget}
        onChange={(event) => commands.setTarget(event.currentTarget.value || null)}
      >
        <option value="">None</option>
        {bodyIds.map((bodyId) => (
          <option key={bodyId} value={bodyId}>
            {bodyLabel(bodyId)}
          </option>
        ))}
      </select>
      <h2 id="target-title">{hud.targetBody}</h2>
      <dl>
        <ReadoutValue label="Distance" value={hud.targetDistance} />
        <ReadoutValue label="Relative speed" value={hud.targetRelativeSpeed} />
        <ReadoutValue
          label="Next approach"
          value={trajectoryPrediction?.display.nextClosestApproach ?? hud.nextClosestApproach}
        />
      </dl>
    </section>
  );
}

function HardwareAccelerationWarning({ rendererName }: HardwareAccelerationWarningData) {
  const [acknowledged, setAcknowledged] = useState(false);
  if (acknowledged) return null;
  return (
    <aside id="hardware-acceleration-warning" class="hardware-warning" role="alert">
      <h2>Hardware acceleration is disabled</h2>
      <p>The game will be slow while your browser uses {rendererName}.</p>
      <ul>
        <li>
          Chrome: Settings → System → enable <strong>Use graphics acceleration</strong>.
        </li>
        <li>
          Firefox: open <strong>about:preferences</strong> and enable recommended performance
          settings and hardware acceleration.
        </li>
      </ul>
      <button type="button" onClick={() => setAcknowledged(true)}>
        I understand
      </button>
    </aside>
  );
}

/** Renders the Solar Voyager overlay and setup warnings. */
export function App({
  bodyIds,
  commands,
  hud,
  hudState,
  hardwareWarning = null,
  initialPhase,
  onSpacePhaseEntered = null,
  perfPanel = null,
  sceneManager = null,
  session = null,
  stateVectors = null,
  stateVectorViewportRef = null,
  trajectoryPrediction = null,
}: AppProps) {
  const startingPhase = initialPhase ?? sceneManager?.phase ?? 'space';
  const [phase, setPhase] = useState<GamePhase>(startingPhase);
  const enteredSpace = useRef(startingPhase === 'space');
  const enterSpace = useCallback(() => {
    if (enteredSpace.current) return;
    enteredSpace.current = true;
    setPhase('space');
    onSpacePhaseEntered?.();
  }, [onSpacePhaseEntered]);

  if (phase === 'main-menu' && sceneManager !== null) {
    return (
      <main class="app-overlay app-overlay-menu">
        {hardwareWarning === null ? null : (
          <HardwareAccelerationWarning rendererName={hardwareWarning.rendererName} />
        )}
        <MainMenu scene={sceneManager} session={session} onSpacePhaseEntered={enterSpace} />
      </main>
    );
  }

  return (
    <main class="app-overlay">
      {hardwareWarning === null ? null : (
        <HardwareAccelerationWarning rendererName={hardwareWarning.rendererName} />
      )}
      {trajectoryPrediction === null ? null : (
        <TrajectoryImpactWarning display={trajectoryPrediction.display} />
      )}
      <h1 class="app-title">{scaffoldState.title}</h1>
      {perfPanel === null ? null : <PerfPanel store={perfPanel} />}
      {session === null ? null : <SessionSettingsPanel session={session} />}
      <OrbitReadout hud={hud} />
      <DualClock hud={hud} />
      <WarpControl commands={commands} hud={hud} hudState={hudState} />
      <EnergyPanel hud={hud} />
      <TargetPanel
        bodyIds={bodyIds}
        commands={commands}
        hud={hud}
        hudState={hudState}
        trajectoryPrediction={trajectoryPrediction}
      />
      {stateVectors === null || stateVectorViewportRef === null ? null : (
        <StateVectorPanel
          display={stateVectors.display}
          pinnedToEcliptic={stateVectors.signals.pinnedToEcliptic}
          setPinnedToEcliptic={stateVectors.setPinnedToEcliptic.bind(stateVectors)}
          viewportRef={stateVectorViewportRef}
        />
      )}
      <Navball hud={hud} hudState={hudState} />
      <section class="camera-help" aria-label="Camera controls">
        <p id="camera-focus-label" class="camera-focus" aria-live="polite">
          Focus: Earth
        </p>
        <p class="camera-instructions">
          Drag to orbit · Scroll to zoom · [ / ] change target · E Earth · J Jupiter
        </p>
      </section>
    </main>
  );
}
