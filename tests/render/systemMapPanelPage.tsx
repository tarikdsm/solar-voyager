import { signal } from '@preact/signals';
import { render } from 'preact';

import { SystemMapController } from '../../src/game/systemMapController.js';
import type { Commands } from '../../src/sim/simulationSnapshot.js';
import '../../src/ui/app.css';
import { SystemMapPanel } from '../../src/ui/SystemMapPanel.js';
import {
  createSystemMapSignalStore,
  formatSystemMapBodyLabel,
} from '../../src/ui/systemMapSignals.js';
import { createTrajectoryPredictionSignalStore } from '../../src/ui/trajectoryPredictionSignals.js';

const BODY_IDS = Object.freeze(['sun', 'earth', 'mars', 'jupiter']);
const root = document.querySelector('#system-map-root');
if (!(root instanceof HTMLElement)) throw new Error('system map regression root is missing');

const map = createSystemMapSignalStore(BODY_IDS, 'sun');
const targetBody = signal('—');
const prediction = createTrajectoryPredictionSignalStore();
prediction.publishPending(-1);
const commands: Commands = {
  rotate: () => undefined,
  setAttitudeMode: () => undefined,
  setTarget: (bodyId) => {
    targetBody.value = bodyId === null ? '—' : formatSystemMapBodyLabel(bodyId);
  },
  setThrottle: () => undefined,
  setWarp: () => undefined,
};
const controller = new SystemMapController({
  bodyIds: BODY_IDS,
  initialFocusId: 'sun',
  onModeChange: (mode) => map.publishMode(mode),
  onFocusChange: (bodyId) => map.publishFocus(bodyId),
});

render(
  <SystemMapPanel
    bodyIds={BODY_IDS}
    commands={commands}
    controller={controller}
    map={map}
    targetBody={targetBody}
    trajectoryPrediction={prediction.display}
  />,
  root,
);
