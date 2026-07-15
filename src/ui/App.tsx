import type { ScaffoldState } from '../sim/scaffoldState';

import './app.css';

interface AppProps {
  state: ScaffoldState;
}

/** Renders the static title overlay above the WebGL canvas. */
export function App({ state }: AppProps) {
  return (
    <div class="title-overlay">
      <h1>{state.title}</h1>
    </div>
  );
}
