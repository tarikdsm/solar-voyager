import { useComputed } from '@preact/signals';

import type { HudDisplaySignals, HudSignals } from './hudSignals.js';
import { NavballMarkerIndex, type NavballMarkerIndex as MarkerIndex } from './navballProjection.js';
import type { NavballMarkerSignals } from './navballSignals.js';

type MarkerKind = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn';

interface MarkerDefinition {
  readonly id: string;
  readonly index: MarkerIndex;
  readonly kind: MarkerKind;
  readonly label: string;
}

const MARKER_RADIUS = 82;
const MARKER_DEFINITIONS = Object.freeze([
  {
    id: 'navball-prograde',
    index: NavballMarkerIndex.PROGRADE,
    kind: 'prograde',
    label: 'Prograde',
  },
  {
    id: 'navball-retrograde',
    index: NavballMarkerIndex.RETROGRADE,
    kind: 'retrograde',
    label: 'Retrograde',
  },
  { id: 'navball-normal', index: NavballMarkerIndex.NORMAL, kind: 'normal', label: 'Normal' },
  {
    id: 'navball-antinormal',
    index: NavballMarkerIndex.ANTINORMAL,
    kind: 'antinormal',
    label: 'Antinormal',
  },
  {
    id: 'navball-radial-out',
    index: NavballMarkerIndex.RADIAL_OUT,
    kind: 'radialOut',
    label: 'Radial out',
  },
  {
    id: 'navball-radial-in',
    index: NavballMarkerIndex.RADIAL_IN,
    kind: 'radialIn',
    label: 'Radial in',
  },
] satisfies readonly MarkerDefinition[]);

function MarkerGlyph({ kind }: { readonly kind: MarkerKind }) {
  if (kind === 'prograde') {
    return (
      <>
        <circle r="8" />
        <circle r="2.2" class="navball-marker-fill" />
      </>
    );
  }
  if (kind === 'retrograde') {
    return (
      <>
        <circle r="8" />
        <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" />
      </>
    );
  }
  const label =
    kind === 'normal' ? 'N' : kind === 'antinormal' ? 'A' : kind === 'radialOut' ? 'R+' : 'R−';
  return (
    <>
      <circle r="9" />
      <text text-anchor="middle" dominant-baseline="central">
        {label}
      </text>
    </>
  );
}

function NavballMarker({
  definition,
  marker,
}: {
  readonly definition: MarkerDefinition;
  readonly marker: NavballMarkerSignals;
}) {
  const transform = useComputed(
    () =>
      `translate(${(marker.x.value * MARKER_RADIUS).toFixed(3)} ${(marker.y.value * MARKER_RADIUS).toFixed(3)})`,
  );
  const opacity = useComputed(() => (marker.visible.value ? 1 : 0));
  return (
    <g
      id={definition.id}
      class={`navball-marker navball-marker-${definition.kind}`}
      transform={transform}
      opacity={opacity}
      data-visible={marker.visible}
    >
      <title>{definition.label}</title>
      <MarkerGlyph kind={definition.kind} />
    </g>
  );
}

/** Static SVG attitude instrument driven by sampled leaf signals. */
export function Navball({
  hud,
  hudState,
}: {
  readonly hud: HudDisplaySignals;
  readonly hudState: HudSignals;
}) {
  const navball = hudState.navball;
  const horizonFillTransform = useComputed(
    () =>
      `rotate(${navball.horizonAngleDeg.value.toFixed(3)}) translate(0 ${navball.horizonOffset.value.toFixed(3)})`,
  );
  const horizonOutlineTransform = useComputed(
    () =>
      `rotate(${navball.horizonAngleDeg.value.toFixed(3)}) scale(1 ${navball.horizonScaleY.value.toFixed(6)})`,
  );
  const thrustTransform = useComputed(
    () =>
      `translate(${(navball.thrustX.value * MARKER_RADIUS).toFixed(3)} ${(navball.thrustY.value * MARKER_RADIUS).toFixed(3)})`,
  );
  const thrustOpacity = useComputed(() => (navball.thrustVisible.value ? 1 : 0));
  const validOpacity = useComputed(() => (navball.valid.value ? 1 : 0));
  const invalidOpacity = useComputed(() => (navball.valid.value ? 0 : 1));

  return (
    <section id="navball" class="hud-panel navball" aria-labelledby="navball-title">
      <header>
        <span>
          <span class="hud-kicker">Dominant-body frame</span>
          <strong id="navball-title">{hud.dominantBody}</strong>
        </span>
        <small id="navball-mode">{hud.attitudeMode}</small>
      </header>
      <svg
        class="navball-sphere"
        viewBox="-105 -105 210 210"
        role="img"
        aria-label="Ship attitude navball"
      >
        <defs>
          <clipPath id="navball-sphere-clip">
            <circle r="99" />
          </clipPath>
        </defs>
        <circle r="100" class="navball-sky" />
        <g opacity={validOpacity}>
          <g clip-path="url(#navball-sphere-clip)" transform={horizonFillTransform}>
            <rect x="-150" y="0" width="300" height="150" class="navball-ground" />
            <path d="M -150 28 H 150 M -150 56 H 150 M -150 84 H 150" class="navball-grid" />
          </g>
          <circle r="98" class="navball-horizon" transform={horizonOutlineTransform} />
          {MARKER_DEFINITIONS.map((definition) => {
            const marker = navball.markers[definition.index];
            return marker === undefined ? null : (
              <NavballMarker key={definition.id} definition={definition} marker={marker} />
            );
          })}
          <g
            id="navball-thrust"
            class="navball-thrust"
            transform={thrustTransform}
            opacity={thrustOpacity}
          >
            <path d="M -13 -5 H -6 V -13 M 13 -5 H 6 V -13 M -13 5 H -6 V 13 M 13 5 H 6 V 13" />
          </g>
        </g>
        <g class="navball-fixed-reticle">
          <path d="M -18 0 H -5 M 5 0 H 18 M 0 -18 V -5 M 0 5 V 18" />
          <circle r="2" />
        </g>
        <text y="4" class="navball-invalid" opacity={invalidOpacity}>
          NO ORBITAL FRAME
        </text>
        <circle r="100" class="navball-rim" />
      </svg>
      <p class="navball-legend" aria-label="Navball marker legend">
        <span>P/R · prograde</span>
        <span>N/A · normal</span>
        <span>R± · radial</span>
      </p>
    </section>
  );
}
