import { createScaffoldState } from '../game/createScaffoldState.js';
import './app.css';

const scaffoldState = createScaffoldState();

/** Renders the static scaffold overlay. */
export function App() {
  return (
    <main class="app-overlay">
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
