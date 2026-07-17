import { render } from 'preact';

import '../../src/style.css';
import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from '../../src/game/createNewGameSimulation.js';
import { KeyboardCommandMapper, type KeyboardInputTarget } from '../../src/game/inputMapping.js';
import { SAVE_STORAGE_KEY, SaveRepository } from '../../src/game/saveLoad.js';
import { GameSessionController } from '../../src/game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from '../../src/game/settings.js';
import { SessionSettingsPanel, type SessionFilePort } from '../../src/ui/SessionSettingsPanel.js';

const SHIP_MASS_KG = 10_000;

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
let mapper: KeyboardCommandMapper | null = null;
const controller = new GameSessionController({
  initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
  saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
  settingsRepository: new SettingsRepository(storage),
  createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
  onSimulationReplaced: (simulation) => {
    mapper?.updateCommands(simulation.commands, currentSnapshot);
  },
  onSettingsChanged: (settings, origin) => {
    if (origin === 'restore') mapper?.restoreBindings(settings.inputBindings);
    else mapper?.updateBindings(settings.inputBindings);
  },
});

function currentSnapshot() {
  return controller.simulation.snapshot;
}

mapper = new KeyboardCommandMapper(
  window as unknown as KeyboardInputTarget,
  controller.simulation.commands,
  currentSnapshot,
  controller.settings.inputBindings,
);

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
    mapper?.update();
    return {
      pitchRateRadS: controller.simulation.exportPersistentState().rotationRatesRadS[0] ?? 0,
    };
  },
};
