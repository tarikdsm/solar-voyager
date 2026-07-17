import { useState } from 'preact/hooks';

import { createScaffoldState } from '../game/createScaffoldState.js';
import './app.css';
import type { HudDisplaySignals } from './hudSignals.js';

const scaffoldState = createScaffoldState();

export interface HardwareAccelerationWarningData {
  readonly rendererName: string;
}

export interface AppProps {
  readonly hud: HudDisplaySignals;
  readonly hardwareWarning?: HardwareAccelerationWarningData | null;
}

interface ReadoutValueProps {
  readonly label: string;
  readonly value: HudDisplaySignals[keyof HudDisplaySignals];
}

function ReadoutValue({ label, value }: ReadoutValueProps) {
  return (
    <div class="hud-readout-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
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
export function App({ hud, hardwareWarning = null }: AppProps) {
  return (
    <main class="app-overlay">
      {hardwareWarning === null ? null : (
        <HardwareAccelerationWarning rendererName={hardwareWarning.rendererName} />
      )}
      <h1 class="app-title">{scaffoldState.title}</h1>
      <OrbitReadout hud={hud} />
      <DualClock hud={hud} />
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
