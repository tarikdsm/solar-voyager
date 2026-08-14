import { render } from 'preact';

import '../../src/style.css';
import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from '../../src/game/createNewGameSimulation.js';
import { InputCommandBridge } from '../../src/game/input/inputCommandBridge.js';
import { InputEngine, type InputKeyboardTarget } from '../../src/game/input/inputEngine.js';
import { SAVE_STORAGE_KEY, SaveRepository } from '../../src/game/saveLoad.js';
import { GameSessionController } from '../../src/game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from '../../src/game/settings.js';
import { DEFAULT_VESSEL } from '../../src/sim/ship/vessel.js';
import { SessionSettingsPanel, type SessionFilePort } from '../../src/ui/SessionSettingsPanel.js';

const VESSEL = DEFAULT_VESSEL;

interface SessionHarnessSnapshot {
  readonly exportedJson: string;
  readonly pitchUp: string;
  readonly qualityLock: string;
  readonly savePresent: boolean;
  readonly simTimeSec: number;
  readonly status: string;
}

interface SessionHarness {
  advance(wallDeltaSec: number): SessionHarnessSnapshot;
  snapshot(): SessionHarnessSnapshot;
  updateInput(): { readonly pitchRateRadS: number };
}

declare global {
  interface Window {
    __sessionHarness: SessionHarness;
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const root = document.querySelector('#session-root');
if (!(root instanceof HTMLElement)) throw new Error('session regression root is missing');

const storage = new MemoryStorage();
let engine: InputEngine | null = null;
let bridge: InputCommandBridge | null = null;
const controller = new GameSessionController({
  initialSimulation: createNewGameSimulation(VESSEL),
  createNewSimulation: () => createNewGameSimulation(VESSEL),
  saveRepository: new SaveRepository(storage, VESSEL),
  settingsRepository: new SettingsRepository(storage),
  createSimulation: (state) => createGameSimulationFromPersistentState(VESSEL, state),
  onSimulationReplaced: (simulation) => {
    engine?.setThrottleAxis(simulation.snapshot.throttle);
    bridge?.updateCommands(simulation.commands, currentSnapshot);
  },
  onSettingsChanged: (settings, origin) => {
    engine?.applyBindings(settings.inputBindings);
    engine?.releaseHeldKeys();
    if (origin === 'restore') bridge?.resetAxes();
    else bridge?.releaseAxes();
  },
});

function currentSnapshot() {
  return controller.simulation.snapshot;
}

engine = new InputEngine({
  bindings: controller.settings.inputBindings,
  keyboardTarget: window as unknown as InputKeyboardTarget,
});
bridge = new InputCommandBridge(controller.simulation.commands, currentSnapshot);

let exportedJson = '';
const files: SessionFilePort = {
  readText: async (file) => file.text(),
  saveJson: (_filename, json) => {
    exportedJson = json;
  },
};

render(<SessionSettingsPanel session={controller} files={files} />, root);

function snapshot(): SessionHarnessSnapshot {
  return {
    exportedJson,
    pitchUp: controller.settings.inputBindings.pitchUp,
    qualityLock: controller.settings.qualityLock,
    savePresent: storage.values.has(SAVE_STORAGE_KEY),
    simTimeSec: controller.simulation.snapshot.simTimeSec,
    status: document.querySelector('#session-status')?.textContent ?? '',
  };
}

window.__sessionHarness = {
  advance: (wallDeltaSec) => {
    controller.simulation.step(wallDeltaSec);
    return snapshot();
  },
  snapshot,
  updateInput: () => {
    if (engine !== null && bridge !== null) bridge.apply(engine.poll(1 / 60));
    return {
      pitchRateRadS: controller.simulation.exportPersistentState().rotationRatesRadS[0] ?? 0,
    };
  },
};
