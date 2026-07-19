export type SystemMapMode = 'space' | 'system-map';

export interface SystemMapControllerOptions {
  readonly bodyIds: readonly string[];
  readonly initialFocusId: string;
  readonly onModeChange?: (mode: SystemMapMode) => void;
  readonly onFocusChange?: (bodyId: string) => void;
}

/** Owns pure system-map view mode and validated camera focus state. */
export class SystemMapController {
  private readonly bodyIds: readonly string[];
  private readonly onModeChange: ((mode: SystemMapMode) => void) | undefined;
  private readonly onFocusChange: ((bodyId: string) => void) | undefined;
  private currentMode: SystemMapMode = 'space';
  private currentFocusId: string;

  constructor(options: SystemMapControllerOptions) {
    if (options.bodyIds.length === 0) throw new Error('System map body ids cannot be empty.');

    this.bodyIds = [...options.bodyIds];
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      const bodyId = this.bodyIds[index];
      if (bodyId === undefined) throw new Error('System map body id array is sparse.');
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        if (this.bodyIds[previousIndex] === bodyId) {
          throw new Error(`Duplicate system map body id "${bodyId}".`);
        }
      }
    }

    if (!this.hasBody(options.initialFocusId)) {
      throw new Error(`Unknown initial system map focus "${options.initialFocusId}".`);
    }
    this.currentFocusId = options.initialFocusId;
    this.onModeChange = options.onModeChange;
    this.onFocusChange = options.onFocusChange;
  }

  get mode(): SystemMapMode {
    return this.currentMode;
  }

  get focusId(): string {
    return this.currentFocusId;
  }

  open(): boolean {
    return this.changeMode('system-map');
  }

  close(): boolean {
    return this.changeMode('space');
  }

  toggle(): SystemMapMode {
    this.changeMode(this.currentMode === 'space' ? 'system-map' : 'space');
    return this.currentMode;
  }

  focusBody(bodyId: string): boolean {
    if (bodyId === this.currentFocusId || !this.hasBody(bodyId)) return false;
    this.currentFocusId = bodyId;
    this.onFocusChange?.(bodyId);
    return true;
  }

  private changeMode(mode: SystemMapMode): boolean {
    if (mode === this.currentMode) return false;
    this.currentMode = mode;
    this.onModeChange?.(mode);
    return true;
  }

  private hasBody(bodyId: string): boolean {
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      if (this.bodyIds[index] === bodyId) return true;
    }
    return false;
  }
}
