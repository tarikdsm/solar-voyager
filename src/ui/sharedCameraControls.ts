import type { OrbitCameraController } from '../game/orbitCameraController.js';
import type { SystemMapController } from '../game/systemMapController.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import type { CameraControlPort } from './cameraInputController.js';

/**
 * Adapts one orbit camera, the system-map focus and the simulation target to the
 * single port `CameraInputController` drives.
 *
 * Extracted from `main.ts` by T0109 so its focus routing is unit-testable; the
 * rest of the composition root's split is T0113's.
 */
export class SharedCameraControls implements CameraControlPort {
  constructor(
    private readonly camera: OrbitCameraController,
    private readonly map: SystemMapController,
    private readonly commands: Commands,
    /**
     * The camera focus ring contains the ship (T0109), which is not a catalog
     * body: the system map has no icon for it and `Commands.setTarget` throws on
     * an id the simulation does not know. Everything routed at the simulation is
     * gated on this list.
     */
    private readonly catalogBodyIds: readonly string[],
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
    if (id === this.map.focusId) this.commands.setTarget(id);
    return cameraChanged || mapChanged;
  }

  cycleFocus(step: number): string {
    const id = this.camera.cycleFocus(step);
    if (!this.catalogBodyIds.includes(id)) return id;
    this.map.focusBody(id);
    this.commands.setTarget(id);
    return id;
  }
}
