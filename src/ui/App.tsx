import { createScaffoldState } from '../game/createScaffoldState.js';
import './app.css';

const scaffoldState = createScaffoldState();

/** Renders the static scaffold overlay. */
export function App() {
  return (
    <main class="app-overlay">
      <h1 class="app-title">{scaffoldState.title}</h1>
    </main>
  );
}
