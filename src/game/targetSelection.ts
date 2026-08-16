import type { Commands } from '../sim/simulationSnapshot.js';

/**
 * The single write point for the navigation/cruise target (plan §T0117, spec §7).
 *
 * Before this module the space-view click, the system-map `<select>`, the target
 * panel `<select>` and the camera focus ring each called `Commands.setTarget`
 * themselves. They all happened to reach the same composition-root facade, but
 * nothing said so and each hand-rolled its own catalog check — or forgot to, and
 * relied on `SimulationCore.setTarget` throwing.
 *
 * Now every path calls {@link TargetSelectionController.selectTarget} and
 * `tests/architecture/targetWritePoint.test.ts` asserts, by source scan, that
 * this file and the composition facade are the only places `.setTarget(` appears.
 * Pure `game/`: no DOM, no three.js, no signals.
 */

/**
 * Which surface asked for the selection.
 *
 * Carried so a consumer can tell a deliberate click from a focus-ring side
 * effect — T0150's intro step is literally "click the Moon", which is
 * `'world'`, not `'panel'`.
 */
export type TargetSelectionSource = 'world' | 'map' | 'panel' | 'camera' | 'api';

/** Fired after the simulation write, with the body and the surface that chose it. */
export type TargetSelectionListener = (
  bodyId: string | null,
  source: TargetSelectionSource,
) => void;

/** The narrow surface every UI path depends on; the class is the only implementation. */
export interface TargetSelectionPort {
  selectTarget(bodyId: string | null, source: TargetSelectionSource): boolean;
  readonly selectedBodyId: string | null;
}

export interface TargetSelectionPorts {
  readonly commands: Commands;
  /** Catalog ids in `SimSnapshot.bodyIds` order; the accept/reject list. */
  readonly bodyIds: readonly string[];
}

export class TargetSelectionController implements TargetSelectionPort {
  private readonly commands: Commands;
  private readonly bodyIds: readonly string[];
  private readonly listeners: TargetSelectionListener[] = [];
  private currentBodyId: string | null = null;
  private currentSource: TargetSelectionSource | null = null;
  private selections = 0;

  constructor(ports: TargetSelectionPorts) {
    if (ports.bodyIds.length === 0) throw new Error('Target selection body ids cannot be empty.');
    this.commands = ports.commands;
    this.bodyIds = [...ports.bodyIds];
  }

  /** The body most recently selected, or null. Equals the simulation's target. */
  get selectedBodyId(): string | null {
    return this.currentBodyId;
  }

  /** The surface that made the current selection; null until something selects. */
  get selectionSource(): TargetSelectionSource | null {
    return this.currentSource;
  }

  /** Accepted selections so far — the browser gates' proof that a click landed. */
  get selectionCount(): number {
    return this.selections;
  }

  /**
   * Commits a target. Returns false for an id the catalog does not carry.
   *
   * Deliberately **not** idempotent. Re-selecting the same body still writes,
   * because the composition facade's `setTarget` also re-aims the observatory
   * camera and invalidates the trajectory prediction — "click it again to
   * recentre" is behaviour the map has always had — and because a tutorial step
   * has to see the second click too.
   */
  selectTarget(bodyId: string | null, source: TargetSelectionSource): boolean {
    if (bodyId !== null && !this.hasBody(bodyId)) return false;
    this.commands.setTarget(bodyId);
    this.currentBodyId = bodyId;
    this.currentSource = source;
    this.selections += 1;
    for (let index = 0; index < this.listeners.length; index += 1) {
      this.listeners[index]?.(bodyId, source);
    }
    return true;
  }

  /**
   * Records a target the simulation already carries without writing it back.
   *
   * A loaded save and a restore arrive with a target already set; adopting it
   * keeps `selectedBodyId` honest without counting as a player selection or
   * firing the listeners a tutorial is watching.
   */
  adoptTarget(bodyId: string | null): boolean {
    if (bodyId !== null && !this.hasBody(bodyId)) return false;
    this.currentBodyId = bodyId;
    return true;
  }

  /** Subscribes to accepted selections. Returns the unsubscribe handle. */
  subscribe(listener: TargetSelectionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private hasBody(bodyId: string): boolean {
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      if (this.bodyIds[index] === bodyId) return true;
    }
    return false;
  }
}
