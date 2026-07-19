import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import type { SystemMapController } from '../game/systemMapController.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import type { TrajectoryPredictionDisplaySignals } from './trajectoryPredictionSignals.js';
import { formatSystemMapBodyLabel, type SystemMapSignalStore } from './systemMapSignals.js';

interface FocusableElement {
  focus(): void;
}

export interface SystemMapKeyboardEvent {
  readonly code: string;
  readonly repeat?: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export interface SystemMapKeyboardTarget {
  addEventListener(type: 'keydown', listener: (event: SystemMapKeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: SystemMapKeyboardEvent) => void): void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const candidate = target as EventTarget & { matches?: (selectors: string) => boolean };
  return (
    typeof candidate.matches === 'function' &&
    candidate.matches('input, select, textarea, button, [contenteditable="true"]')
  );
}

export class SystemMapPanelModel {
  private readonly bodyIds: readonly string[];
  private readonly commands: Commands;
  private readonly controller: SystemMapController;
  private toggleElement: FocusableElement | null = null;
  private bodySelectElement: FocusableElement | null = null;

  constructor(bodyIds: readonly string[], commands: Commands, controller: SystemMapController) {
    this.bodyIds = [...bodyIds];
    this.commands = commands;
    this.controller = controller;
  }

  readonly setToggleElement = (element: FocusableElement | null): void => {
    this.toggleElement = element;
  };

  readonly setBodySelectElement = (element: FocusableElement | null): void => {
    this.bodySelectElement = element;
  };

  readonly toggle = (): void => {
    const mode = this.controller.toggle();
    if (mode === 'system-map') this.bodySelectElement?.focus();
    else this.toggleElement?.focus();
  };

  readonly close = (): boolean => {
    if (!this.controller.close()) return false;
    this.toggleElement?.focus();
    return true;
  };

  readonly selectBody = (bodyId: string): boolean => {
    if (!this.hasBody(bodyId)) return false;
    this.controller.focusBody(bodyId);
    this.commands.setTarget(bodyId);
    return true;
  };

  readonly handleKeyDown = (event: SystemMapKeyboardEvent): void => {
    if (event.repeat === true) return;
    if (event.code === 'KeyM') {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      this.toggle();
      return;
    }
    if (event.code === 'Escape' && this.controller.mode === 'system-map') {
      event.preventDefault();
      this.close();
    }
  };

  private hasBody(bodyId: string): boolean {
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      if (this.bodyIds[index] === bodyId) return true;
    }
    return false;
  }
}

/** Owns the panel's one setup-time keyboard listener. */
export class SystemMapKeyboardBinding {
  private readonly handleKeyDown: (event: SystemMapKeyboardEvent) => void;
  private target: SystemMapKeyboardTarget | null = null;

  constructor(model: SystemMapPanelModel) {
    this.handleKeyDown = model.handleKeyDown;
  }

  attach(target: SystemMapKeyboardTarget): boolean {
    if (this.target === target) return false;
    if (this.target !== null) {
      throw new Error('System map keyboard binding is already attached.');
    }
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown);
    return true;
  }

  dispose(): boolean {
    if (this.target === null) return false;
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target = null;
    return true;
  }
}

export interface SystemMapPanelViewProps {
  readonly bodyIds: readonly string[];
  readonly map: SystemMapSignalStore;
  readonly model: SystemMapPanelModel;
  readonly targetBody: ReadonlySignal<string>;
  readonly trajectoryPrediction: TrajectoryPredictionDisplaySignals;
}

/** Semantic always-mounted view used by the interactive system map. */
export function SystemMapPanelView({
  bodyIds,
  map,
  model,
  targetBody,
  trajectoryPrediction,
}: SystemMapPanelViewProps) {
  return (
    <>
      <button
        ref={model.setToggleElement}
        id="system-map-toggle"
        class="system-map-toggle"
        type="button"
        aria-controls="system-map-panel"
        aria-expanded={map.display.open}
        title="Toggle system map (M)"
        onClick={model.toggle}
      >
        {map.display.toggleLabel}
      </button>
      <aside
        id="system-map-panel"
        class="hud-panel system-map-panel"
        aria-labelledby="system-map-title"
        hidden={map.display.closed}
      >
        <header>
          <p class="hud-kicker">Live navigation</p>
          <h2 id="system-map-title">System map</h2>
        </header>
        <label class="hud-kicker" for="system-map-body-selector">
          Focus body
        </label>
        <select
          ref={model.setBodySelectElement}
          id="system-map-body-selector"
          value={map.signals.focusBodyId}
          onChange={(event) => model.selectBody(event.currentTarget.value)}
        >
          {bodyIds.map((bodyId) => (
            <option key={bodyId} value={bodyId}>
              {formatSystemMapBodyLabel(bodyId)}
            </option>
          ))}
        </select>
        <dl class="system-map-status">
          <div>
            <dt>Map focus</dt>
            <dd id="system-map-focus" aria-live="polite">
              {map.display.focusBodyLabel}
            </dd>
          </div>
          <div>
            <dt>Navigation target</dt>
            <dd id="system-map-target" aria-live="polite">
              {targetBody}
            </dd>
          </div>
          <div>
            <dt>Next approach</dt>
            <dd id="system-map-next-approach">{trajectoryPrediction.nextClosestApproach}</dd>
          </div>
        </dl>
        <p
          id="system-map-impact"
          class="system-map-impact"
          data-visible={trajectoryPrediction.impactVisible}
          aria-live="assertive"
        >
          {trajectoryPrediction.impactMessage}
        </p>
        <p class="system-map-instructions">Drag to orbit · Scroll to zoom · Esc to return</p>
      </aside>
    </>
  );
}

export interface SystemMapPanelProps {
  readonly bodyIds: readonly string[];
  readonly commands: Commands;
  readonly controller: SystemMapController;
  readonly map: SystemMapSignalStore;
  readonly targetBody: ReadonlySignal<string>;
  readonly trajectoryPrediction: TrajectoryPredictionDisplaySignals;
}

/** Connects the setup-owned map state to its accessible controls. */
export function SystemMapPanel(props: SystemMapPanelProps) {
  const modelRef = useRef<SystemMapPanelModel | null>(null);
  const bindingRef = useRef<SystemMapKeyboardBinding | null>(null);
  if (modelRef.current === null) {
    modelRef.current = createSystemMapPanelModel(props.bodyIds, props.commands, props.controller);
    bindingRef.current = new SystemMapKeyboardBinding(modelRef.current);
  }
  const model = modelRef.current;
  const binding = bindingRef.current;
  if (binding === null) throw new Error('System map keyboard binding was not created.');

  useEffect(() => {
    binding.attach(window as unknown as SystemMapKeyboardTarget);
    return () => binding.dispose();
  }, [binding]);

  return (
    <SystemMapPanelView
      bodyIds={props.bodyIds}
      map={props.map}
      model={model}
      targetBody={props.targetBody}
      trajectoryPrediction={props.trajectoryPrediction}
    />
  );
}

/** Creates the panel's setup-owned interaction model. */
export function createSystemMapPanelModel(
  bodyIds: readonly string[],
  commands: Commands,
  controller: SystemMapController,
): SystemMapPanelModel {
  return new SystemMapPanelModel(bodyIds, commands, controller);
}
