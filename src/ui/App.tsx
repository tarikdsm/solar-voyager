import { useState } from 'preact/hooks';

import { createScaffoldState } from '../game/createScaffoldState.js';
import './app.css';

const scaffoldState = createScaffoldState();

export interface HardwareAccelerationWarningData {
  readonly rendererName: string;
}

export interface AppProps {
  readonly hardwareWarning?: HardwareAccelerationWarningData | null;
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
export function App({ hardwareWarning = null }: AppProps) {
  return (
    <main class="app-overlay">
      {hardwareWarning === null ? null : (
        <HardwareAccelerationWarning rendererName={hardwareWarning.rendererName} />
      )}
      <h1 class="app-title">{scaffoldState.title}</h1>
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
