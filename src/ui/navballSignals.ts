import { signal, type Signal } from '@preact/signals';

import type { AttitudeMode, SimSnapshot } from '../sim/simulationSnapshot.js';
import {
  NAVBALL_MARKER_COMPONENTS,
  type NavballProjectionBuffer,
  writeNavballProjectionInto,
} from './navballProjection.js';

export interface NavballMarkerSignals {
  readonly x: Signal<number>;
  readonly y: Signal<number>;
  readonly visible: Signal<boolean>;
}

export interface NavballSignals {
  readonly valid: Signal<boolean>;
  readonly attitudeMode: Signal<AttitudeMode>;
  readonly markers: readonly NavballMarkerSignals[];
  readonly horizonAngleDeg: Signal<number>;
  readonly horizonOffset: Signal<number>;
  readonly horizonScaleY: Signal<number>;
  readonly thrustX: Signal<number>;
  readonly thrustY: Signal<number>;
  readonly thrustVisible: Signal<boolean>;
}

function createMarkerSignals(): NavballMarkerSignals {
  return {
    x: signal(0),
    y: signal(0),
    visible: signal(false),
  };
}

/** Creates the stable leaf-signal graph consumed by the static navball SVG. */
export function createNavballSignals(): NavballSignals {
  return {
    valid: signal(false),
    attitudeMode: signal<AttitudeMode>('manual'),
    markers: Object.freeze([
      createMarkerSignals(),
      createMarkerSignals(),
      createMarkerSignals(),
      createMarkerSignals(),
      createMarkerSignals(),
      createMarkerSignals(),
    ]),
    horizonAngleDeg: signal(0),
    horizonOffset: signal(0),
    horizonScaleY: signal(0),
    thrustX: signal(0),
    thrustY: signal(0),
    thrustVisible: signal(false),
  };
}

/** Copies one preallocated projection into leaf signals at the sampled HUD cadence. */
export function commitNavballSignals(
  signals: NavballSignals,
  projection: NavballProjectionBuffer,
  snapshot: SimSnapshot,
): void {
  writeNavballProjectionInto(projection, snapshot);
  signals.valid.value = projection.valid;
  signals.attitudeMode.value = snapshot.attitudeMode;
  signals.horizonAngleDeg.value = projection.horizonAngleDeg;
  signals.horizonOffset.value = projection.horizonOffset;
  signals.horizonScaleY.value = projection.horizonScaleY;
  signals.thrustX.value = projection.thrustX;
  signals.thrustY.value = projection.thrustY;
  signals.thrustVisible.value = projection.thrustVisible !== 0;
  for (let markerIndex = 0; markerIndex < signals.markers.length; markerIndex += 1) {
    const marker = signals.markers[markerIndex];
    if (marker === undefined) continue;
    const projectionOffset = markerIndex * NAVBALL_MARKER_COMPONENTS;
    marker.x.value = projection.markers[projectionOffset] as number;
    marker.y.value = projection.markers[projectionOffset + 1] as number;
    marker.visible.value = (projection.markers[projectionOffset + 2] as number) !== 0;
  }
}

export function formatAttitudeMode(mode: AttitudeMode): string {
  switch (mode) {
    case 'prograde':
      return 'Prograde hold';
    case 'retrograde':
      return 'Retrograde hold';
    case 'normal':
      return 'Normal hold';
    case 'antinormal':
      return 'Antinormal hold';
    case 'radialOut':
      return 'Radial out hold';
    case 'radialIn':
      return 'Radial in hold';
    case 'target':
      return 'Target hold';
    default:
      return 'Manual attitude';
  }
}
