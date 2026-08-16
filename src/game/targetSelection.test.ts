import { describe, expect, it, vi } from 'vitest';

import type { Commands } from '../sim/simulationSnapshot.js';
import { TargetSelectionController, type TargetSelectionSource } from './targetSelection.js';

const BODY_IDS = Object.freeze(['sun', 'earth', 'moon', 'mars']);

function createHarness() {
  const writes: (string | null)[] = [];
  const commands: Commands = {
    rotate: () => undefined,
    setAttitudeMode: () => undefined,
    setTarget: (bodyId) => {
      writes.push(bodyId);
    },
    setThrottle: () => undefined,
    setWarp: () => undefined,
  };
  const controller = new TargetSelectionController({ commands, bodyIds: BODY_IDS });
  return { controller, writes };
}

describe('target selection - T0117', () => {
  it('writes an accepted selection through to Commands.setTarget', () => {
    const { controller, writes } = createHarness();

    expect(controller.selectTarget('moon', 'world')).toBe(true);

    expect(writes).toEqual(['moon']);
    expect(controller.selectedBodyId).toBe('moon');
    expect(controller.selectionSource).toBe('world');
    expect(controller.selectionCount).toBe(1);
  });

  /**
   * Re-selecting the same body is deliberately not a no-op: the composition
   * facade's `setTarget` also re-aims the observatory camera and invalidates the
   * trajectory prediction, so "click it again to recentre" has to reach the sim.
   */
  it('re-commits an unchanged selection so a repeat click still recentres', () => {
    const { controller, writes } = createHarness();

    controller.selectTarget('mars', 'map');
    controller.selectTarget('mars', 'panel');

    expect(writes).toEqual(['mars', 'mars']);
    expect(controller.selectionCount).toBe(2);
    expect(controller.selectionSource).toBe('panel');
  });

  it('clears the target when handed null', () => {
    const { controller, writes } = createHarness();
    controller.selectTarget('earth', 'panel');

    expect(controller.selectTarget(null, 'panel')).toBe(true);

    expect(writes).toEqual(['earth', null]);
    expect(controller.selectedBodyId).toBeNull();
  });

  /**
   * The camera focus ring contains `ship`, which is not a catalog body and makes
   * `SimulationCore.setTarget` throw. Every caller used to hand-roll this check;
   * rejecting here is what lets them stop.
   */
  it('rejects an id the catalog does not know without writing or throwing', () => {
    const { controller, writes } = createHarness();

    expect(controller.selectTarget('ship', 'camera')).toBe(false);
    expect(controller.selectTarget('', 'api')).toBe(false);

    expect(writes).toEqual([]);
    expect(controller.selectedBodyId).toBeNull();
    expect(controller.selectionCount).toBe(0);
  });

  it('notifies subscribers with the body and the source that selected it', () => {
    const { controller } = createHarness();
    const seen: [string | null, TargetSelectionSource][] = [];
    const unsubscribe = controller.subscribe((bodyId, source) => {
      seen.push([bodyId, source]);
    });

    controller.selectTarget('moon', 'world');
    controller.selectTarget('moon', 'world');
    controller.selectTarget('ship', 'camera');
    unsubscribe();
    controller.selectTarget('mars', 'map');

    expect(seen).toEqual([
      ['moon', 'world'],
      ['moon', 'world'],
    ]);
  });

  /**
   * A listener that throws is a UI bug, not a reason to lose the selection: the
   * simulation write has already happened by the time listeners run.
   */
  it('keeps the selection when a listener throws', () => {
    const { controller, writes } = createHarness();
    const later = vi.fn();
    controller.subscribe(() => {
      throw new Error('listener exploded');
    });
    controller.subscribe(later);

    expect(() => controller.selectTarget('earth', 'world')).toThrow(/listener exploded/u);

    expect(writes).toEqual(['earth']);
    expect(controller.selectedBodyId).toBe('earth');
    expect(later).not.toHaveBeenCalled();
  });

  it('adopts a target the simulation already carried', () => {
    const { controller } = createHarness();

    controller.adoptTarget('mars');

    expect(controller.selectedBodyId).toBe('mars');
    expect(controller.selectionSource).toBeNull();
    expect(controller.selectionCount).toBe(0);
  });

  it('selects nothing when the catalog is empty', () => {
    const commands: Commands = {
      rotate: () => undefined,
      setAttitudeMode: () => undefined,
      setTarget: () => undefined,
      setThrottle: () => undefined,
      setWarp: () => undefined,
    };
    const controller = new TargetSelectionController({ commands, bodyIds: [] });
    expect(controller.selectTarget('earth', 'panel')).toBe(false);
    expect(controller.selectTarget(null, 'panel')).toBe(true);
  });
});
