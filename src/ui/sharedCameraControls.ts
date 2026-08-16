import type { SystemMapController } from '../game/systemMapController.js';
import type { TargetSelectionPort } from '../game/targetSelection.js';
import type { CameraControlPort } from './cameraInputController.js';

/**
 * What a camera has to offer to be driven by the shared input port.
 *
 * `OrbitCameraController` (the system map's camera) and `CameraDirector` (the
 * space camera, T0110) both satisfy this. Typing the collaborator structurally
 * rather than as one concrete class is what keeps the mode-aware space camera on
 * the *same* input path as the map camera instead of growing a second one.
 */
export interface SharedCameraTarget {
  readonly focusId: string;
  orbitBy(deltaYawRad: number, deltaPitchRad: number): void;
  zoomByWheel(wheelDelta: number): void;
  focusBody(id: string): boolean;
  cycleFocus(step: number): string;
  /** Only the space camera has modes; see {@link CameraControlPort.cycleCameraMode}. */
  cycle?(): void;
}

/**
 * Adapts one camera, the system-map focus and the simulation target to the
 * single port `CameraInputController` drives.
 *
 * Extracted from `main.ts` by T0109 so its focus routing is unit-testable; the
 * rest of the composition root's split is T0113's.
 */
export class SharedCameraControls implements CameraControlPort {
  /**
   * The camera focus ring contains the ship (T0109), which is not a catalog
   * body: the system map has no icon for it and `SimulationCore.setTarget`
   * throws on an id the simulation does not know. T0117 moved that gate into
   * `TargetSelectionController`, which rejects an unknown id and returns false,
   * so this class no longer carries its own copy of the catalog.
   */
  constructor(
    private readonly camera: SharedCameraTarget,
    private readonly map: SystemMapController,
    private readonly selection: TargetSelectionPort,
  ) {}

  /**
   * Reported from the camera rather than the map so the focus label follows a
   * focus the map cannot represent.
   */
  get focusId(): string {
    return this.camera.focusId;
  }

  orbitBy(deltaYawRad: number, deltaPitchRad: number): void {
    this.camera.orbitBy(deltaYawRad, deltaPitchRad);
  }

  zoomByWheel(wheelDelta: number): void {
    this.camera.zoomByWheel(wheelDelta);
  }

  /**
   * Points this camera at a catalog body.
   *
   * The camera is moved here rather than by relying on the map to relay the
   * change back. `SystemMapController.focusBody` deliberately returns early
   * without firing `onFocusChange` when its focus is already the requested id,
   * which was safe only while camera focus always equalled map focus. Since the
   * ship joined the camera's ring the two can disagree, and a camera parked on
   * the ship would ignore a request for the body the map already shows.
   */
  focusBody(id: string): boolean {
    const cameraChanged = this.camera.focusBody(id);
    const mapChanged = this.map.focusBody(id);
    if (id === this.map.focusId) this.selection.selectTarget(id, 'camera');
    return cameraChanged || mapChanged;
  }

  cycleFocus(step: number): string {
    const id = this.camera.cycleFocus(step);
    if (!this.selection.selectTarget(id, 'camera')) return id;
    this.map.focusBody(id);
    return id;
  }

  /**
   * Steps the camera mode ring, when this camera has one.
   *
   * Deliberately routed nowhere else: a mode change is a *view* change and must
   * not move the navigation target or the map, which is the same separation
   * `CameraDirector.focusObservatoryBody` enforces from the other direction.
   */
  cycleCameraMode(): void {
    this.camera.cycle?.();
  }
}
