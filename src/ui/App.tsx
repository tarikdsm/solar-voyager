import { useComputed, type ReadonlySignal } from '@preact/signals';
import type { ComponentChildren, ComponentType } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { WARP_LADDER, type WarpFactor } from '../core/time.js';
import { createScaffoldState } from '../game/createScaffoldState.js';
import type { GamePhase, SceneManager } from '../game/sceneManager.js';
import {
  CruiseStatus,
  FlightWarnings,
  HudPresetIndicator,
  Reticle,
  ThrottleSpeedStrip,
} from './FlightStrip.js';
import type { HudPresetStore } from './hudPresetSignals.js';
import { PauseMenu, type PauseMenuActions } from './PauseMenu.js';
import { WorldMarkerLayer } from './WorldMarkers.js';
import type { SystemMapController } from '../game/systemMapController.js';
import type { TutorialController } from '../game/tutorialController.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import './app.css';
import { PerfPanel } from './hud/PerfPanel.js';
import type { PerfPanelStore } from './hud/perfPanelStore.js';
import { hudPresetShows, type HudSurface } from '../game/hud/hudPresets.js';
import type { SessionActionResult } from '../game/sessionController.js';
import type { HudDisplaySignals, HudSignals } from './hudSignals.js';
import { ImpactOverlay, type ImpactOverlayActions } from './ImpactOverlay.js';
import type { ImpactDisplaySignals } from './impactSignals.js';
import { MainMenu } from './MainMenu.js';
import { Navball } from './Navball.js';
import { SessionSettingsPanel, type SessionSettingsPort } from './SessionSettingsPanel.js';
import { StateVectorPanel } from './StateVectorPanel.js';
import type { StateVectorSignalStore } from './stateVectorSignals.js';
import { SystemMapPanel } from './SystemMapPanel.js';
import type { SystemMapSignalStore } from './systemMapSignals.js';
import { TrajectoryImpactWarning } from './TrajectoryImpactWarning.js';
import { TutorialOverlayView } from './TutorialOverlay.js';
import type { TrajectoryPredictionSignalStore } from './trajectoryPredictionSignals.js';
import type { BurnLogSignalStore } from './burnLogSignals.js';

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
  readonly burnLog?: BurnLogSignalStore | null;
  readonly burnLogPanel?: ComponentType<{
    readonly store: BurnLogSignalStore;
    readonly onExpandedChange?: ((expanded: boolean) => void) | null;
  }> | null;
  readonly hardwareWarning?: HardwareAccelerationWarningData | null;
  /** T0112 preset ring; absent renders the full Engineer HUD, as v1 did. */
  readonly hudPreset?: HudPresetStore | null;
  /** T0112 pause menu; absent leaves it unmounted (component harnesses). */
  readonly pause?: PauseUiPort | null;
  /** ADR-036 surface-contact freeze overlay; absent leaves it unmounted. */
  readonly impact?: ImpactUiPort | null;
  readonly initialPhase?: GamePhase;
  readonly onSpacePhaseEntered?: (() => void) | null;
  readonly onBurnLogExpandedChange?: ((expanded: boolean) => void) | null;
  readonly onHardwareWarningAcknowledged?: (() => void) | null;
  readonly onPerfPanelExpandedChange?: ((expanded: boolean) => void) | null;
  readonly onSaveSucceeded?: (() => void) | null;
  readonly perfPanel?: PerfPanelStore | null;
  readonly sceneManager?: SceneManager | null;
  readonly session?: SessionSettingsPort | null;
  readonly stateVectors?: StateVectorSignalStore | null;
  readonly stateVectorViewportRef?: ((element: HTMLDivElement | null) => void) | null;
  readonly systemMap?: SystemMapUiPort | null;
  readonly trajectoryPrediction?: TrajectoryPredictionSignalStore | null;
  readonly tutorial?: TutorialController | null;
}

export interface SystemMapUiPort {
  readonly controller: SystemMapController;
  readonly signals: SystemMapSignalStore;
}

/**
 * What the pause dialog can do to the session.
 *
 * `openSettings` is deliberately absent: expanding the existing settings panel is
 * a pure view concern and `App` owns it, so `main.ts` never has to reach into the
 * HUD's DOM to satisfy a menu button.
 */
export interface PauseUiPort {
  resume(): void;
  save(): SessionActionResult;
  exitToMenu(): void;
}

export interface ImpactUiPort {
  readonly actions: ImpactOverlayActions;
  readonly display: ImpactDisplaySignals;
}

export function SpaceHudSurfaces({
  children,
  mapOpen,
}: {
  readonly children: ComponentChildren;
  readonly mapOpen: boolean | ReadonlySignal<boolean>;
}) {
  return (
    <div class="space-hud-surfaces" hidden={mapOpen} aria-hidden={mapOpen}>
      {children}
    </div>
  );
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
    <section
      id="dual-clock"
      class="hud-panel dual-clock"
      aria-label="Mission UTC and ship proper-time clocks"
    >
      <div class="clock-block">
        <span class="hud-kicker">Mission UTC · TDB display mapping</span>
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

export function HardwareAccelerationWarning({
  rendererName,
  onAcknowledged = null,
}: HardwareAccelerationWarningData & { readonly onAcknowledged?: (() => void) | null }) {
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
      <button
        type="button"
        onClick={() => {
          setAcknowledged(true);
          onAcknowledged?.();
        }}
      >
        I understand
      </button>
    </aside>
  );
}

/** Renders the Solar Voyager overlay and setup warnings. */
export function App({
  bodyIds,
  burnLog = null,
  burnLogPanel: BurnLogPanelComponent = null,
  commands,
  hud,
  hudState,
  hardwareWarning = null,
  hudPreset = null,
  impact = null,
  initialPhase,
  pause = null,
  onBurnLogExpandedChange = null,
  onHardwareWarningAcknowledged = null,
  onPerfPanelExpandedChange = null,
  onSaveSucceeded = null,
  onSpacePhaseEntered = null,
  perfPanel = null,
  sceneManager = null,
  session = null,
  stateVectors = null,
  stateVectorViewportRef = null,
  systemMap = null,
  trajectoryPrediction = null,
  tutorial = null,
}: AppProps) {
  const startingPhase = initialPhase ?? sceneManager?.phase ?? 'space';
  const [phase, setPhase] = useState<GamePhase>(startingPhase);
  const [paused, setPaused] = useState(sceneManager?.paused ?? false);
  const settingsHostRef = useRef<HTMLDivElement | null>(null);
  const [tutorialProgress, setTutorialProgress] = useState(tutorial?.progress ?? null);
  const [, setTutorialRevision] = useState(0);
  const enteredSpace = useRef(startingPhase === 'space');
  const tutorialHeading = useRef<HTMLHeadingElement | null>(null);
  const enterSpace = useCallback(() => {
    if (enteredSpace.current) return;
    enteredSpace.current = true;
    setPhase('space');
    onSpacePhaseEntered?.();
  }, [onSpacePhaseEntered]);

  // T0112 — the menu return is real now, so the phase is no longer write-once:
  // `SceneManager` owns it and this is the only place that mirrors it into state.
  useEffect(() => {
    if (sceneManager === null) return undefined;
    return sceneManager.subscribe((state) => {
      setPaused(state === 'paused');
      if (state === 'main-menu') {
        setPhase('main-menu');
        return;
      }
      // Through `enterSpace`, never around it. Setting `enteredSpace` here
      // directly would make this listener — which fires *inside*
      // `SceneManager.startNewGame()`, before `MainMenu` gets its result — trip
      // the guard that `enterSpace` uses to decide whether to activate the space
      // phase at all, and the world would never start.
      enterSpace();
      setPhase('space');
    });
  }, [enterSpace, sceneManager]);

  useEffect(() => {
    setTutorialProgress(tutorial?.progress ?? null);
    if (tutorial === null) return;
    return tutorial.subscribe((progress) => {
      setTutorialProgress(progress);
      setTutorialRevision((revision) => revision + 1);
    });
  }, [tutorial]);

  useEffect(() => {
    if (tutorialProgress?.status === 'active') tutorialHeading.current?.focus();
  }, [tutorialProgress?.status, tutorialProgress?.stepId]);

  useEffect(() => {
    if (enteredSpace.current) onSpacePhaseEntered?.();
  }, [onSpacePhaseEntered]);

  const pauseActions: PauseMenuActions | null =
    pause === null
      ? null
      : {
          resume: () => pause.resume(),
          save: () => pause.save(),
          exitToMenu: () => pause.exitToMenu(),
          openSettings: () => {
            // The panel is an uncontrolled `<details>` owned by
            // `SessionSettingsPanel`; the pause menu opens it through the host
            // element rather than duplicating the whole settings UI inside the
            // dialog (two `id="session-settings"` nodes would be worse than this).
            const host = settingsHostRef.current;
            const details = host?.querySelector('details');
            if (details instanceof HTMLDetailsElement) {
              details.open = true;
              details.querySelector('summary')?.focus();
            }
          },
        };

  const activePreset = hudPreset?.signals.preset.value ?? 'engineer';
  // Reading the preset signal inside the render subscribes `App` to it, so a
  // preset change re-renders exactly once and the Engineer panels are genuinely
  // unmounted in Clean rather than merely hidden — which is the point of a preset
  // whose job is to not be there.
  const shows = (surface: HudSurface): boolean =>
    hudPreset === null || hudPresetShows(activePreset, surface);

  if (phase === 'main-menu' && sceneManager !== null) {
    return (
      <main class="app-overlay app-overlay-menu">
        {hardwareWarning === null ? null : (
          <HardwareAccelerationWarning
            rendererName={hardwareWarning.rendererName}
            onAcknowledged={onHardwareWarningAcknowledged}
          />
        )}
        <MainMenu
          key={tutorialProgress?.status}
          scene={sceneManager}
          session={session}
          onSpacePhaseEntered={enterSpace}
          tutorial={tutorial}
        />
      </main>
    );
  }

  return (
    <main class="app-overlay" data-hud-preset={activePreset} data-paused={String(paused)}>
      {hardwareWarning === null ? null : (
        <HardwareAccelerationWarning
          rendererName={hardwareWarning.rendererName}
          onAcknowledged={onHardwareWarningAcknowledged}
        />
      )}
      {perfPanel === null ? null : (
        <PerfPanel store={perfPanel} onExpandedChange={onPerfPanelExpandedChange} />
      )}
      {systemMap === null || trajectoryPrediction === null ? null : (
        <SystemMapPanel
          bodyIds={bodyIds}
          commands={commands}
          controller={systemMap.controller}
          map={systemMap.signals}
          targetBody={hud.targetBody}
          trajectoryPrediction={trajectoryPrediction.display}
        />
      )}
      <SpaceHudSurfaces mapOpen={systemMap?.signals.display.open ?? false}>
        <WorldMarkerLayer
          hud={hud}
          markers={hudState.worldMarkers}
          showTarget={shows('targetMarker')}
          showLabels={hudPreset?.signals.bodyLabels ?? true}
        />
        <div class="hud-grid">
          {trajectoryPrediction === null || !shows('warnings') ? null : (
            <TrajectoryImpactWarning display={trajectoryPrediction.display} />
          )}
          <h1 class="app-title">{scaffoldState.title}</h1>
          <Reticle show={shows('reticle')} />
          <div class="hud-area hud-area-left">
            {shows('orbitReadout') ? <OrbitReadout hud={hud} /> : null}
            {shows('dualClock') ? <DualClock hud={hud} /> : null}
            {shows('warpIndicator') ? (
              <WarpControl commands={commands} hud={hud} hudState={hudState} />
            ) : null}
          </div>
          <div class="hud-area hud-area-right">
            {/*
              The settings panel is keyed on tutorial status, so it remounts every
              time the tutorial advances. That key must not be a direct sibling of
              the other panels: a keyed child among unkeyed ones makes Preact
              recreate the nodes after it, and `BurnLogPanel` keeps its expanded
              flag in a per-instance signal — so finishing the tutorial silently
              collapsed a burn log the player had open. One wrapper contains the
              churn.
            */}
            <div class="hud-rail-head" ref={settingsHostRef}>
              {session === null ? null : (
                <SessionSettingsPanel
                  key={tutorialProgress?.status}
                  session={session}
                  onSaveSucceeded={onSaveSucceeded}
                  tutorial={tutorial}
                />
              )}
              {hudPreset === null ? null : (
                <HudPresetIndicator label={hudPreset.display.presetLabel} />
              )}
            </div>
            {shows('energyPanel') ? <EnergyPanel hud={hud} /> : null}
            {burnLog === null || BurnLogPanelComponent === null || !shows('burnLog') ? null : (
              <BurnLogPanelComponent store={burnLog} onExpandedChange={onBurnLogExpandedChange} />
            )}
            {shows('targetPanel') ? (
              <TargetPanel
                bodyIds={bodyIds}
                commands={commands}
                hud={hud}
                hudState={hudState}
                trajectoryPrediction={trajectoryPrediction}
              />
            ) : null}
            {stateVectors === null ||
            stateVectorViewportRef === null ||
            !shows('stateVectors') ? null : (
              <StateVectorPanel
                display={stateVectors.display}
                pinnedToEcliptic={stateVectors.signals.pinnedToEcliptic}
                setPinnedToEcliptic={stateVectors.setPinnedToEcliptic.bind(stateVectors)}
                viewportRef={stateVectorViewportRef}
              />
            )}
          </div>
          <div class="hud-area hud-area-bottom-center">
            <FlightWarnings hud={hud} show={shows('warnings')} />
            <CruiseStatus show={shows('cruiseStatus')} />
            {shows('navball') ? <Navball hud={hud} hudState={hudState} /> : null}
            <ThrottleSpeedStrip
              hud={hud}
              hudState={hudState}
              showAltitude={shows('radarAltitude')}
              showWarp={shows('warpIndicator')}
            />
            {/*
              Always mounted, never conditionally: `main.ts` throws at space-phase
              activation if `#camera-focus-label` is missing, and three browser
              gates read its `textContent`. Clean hides the section with `hidden`,
              which leaves the text readable to the harnesses and to assistive
              technology that queries it directly.
            */}
            <section class="camera-help" aria-label="Camera controls" hidden={!shows('cameraHelp')}>
              <p id="camera-focus-label" class="camera-focus" aria-live="polite">
                Focus: Earth
              </p>
              <p class="camera-instructions">
                O chase/observatory · Drag to orbit · Scroll to zoom · Shift + Arrows/Page Up/Page
                Down · [ / ] change target · E Earth · J Jupiter · H cycle HUD · L body labels
              </p>
            </section>
          </div>
        </div>
      </SpaceHudSurfaces>
      {pauseActions === null ? null : <PauseMenu actions={pauseActions} open={paused} />}
      {impact === null ? null : <ImpactOverlay actions={impact.actions} display={impact.display} />}
      {tutorial !== null &&
      tutorialProgress !== null &&
      (tutorialProgress.status === 'unoffered' || tutorialProgress.status === 'active') ? (
        <TutorialOverlayView
          controller={tutorial}
          focusHeading={(heading) => {
            tutorialHeading.current = heading;
          }}
          progress={tutorialProgress}
          readoutsReady={tutorial.canAcknowledgeReadouts}
        />
      ) : null}
    </main>
  );
}
