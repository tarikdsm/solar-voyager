# T0056 Warp, Energy, and Target UI Design

## Data and latency

Extend the stable T0054 HUD signal graph. Requested/effective warp and clamp
reason are copied on every frame so a newly clamped tier is visible within that
same frame. Numeric energy and target telemetry remains sampled at 10 Hz per the
HUD performance rules. Signal assignments with unchanged values do not notify
DOM observers.

## Warp control

The top-center control exposes every canonical `WARP_LADDER` tier and writes
only through `Commands.setWarp`. Requested and effective tiers are both visible.
`INTEGRATION_BUDGET` renders as “gravity well · integration budget”; the
coast-only safety state renders as “thrust locked above 1000x”. Controls are
native buttons with `aria-pressed` state and keyboard focus.

## Energy panel

The bottom-right panel shows cumulative energy via the shared
`formatEnergyWh`, instantaneous photon-drive power via `formatPowerW`, proper
delta-v, and kinetic-energy change. The shared SI formatter remains the only
source of Wh/W prefix policy. Signed kinetic change has a UI wrapper because the
shared nonnegative formatter intentionally rejects negative values.

The panel also distinguishes the complete session from one burn. Four primitive
snapshot fields expose whether a burn summary exists, whether it is active, and
that burn's energy and proper delta-v. `SimulationCore` selects the active burn
when present, otherwise the latest completed burn. No-burn state renders
explicitly. This `SimSnapshot` extension is governed by ADR-028; UI must not read
`SimulationCore.burnLog` directly.

## Target panel

A native select writes through `Commands.setTarget`. The panel computes current
distance and relative speed directly from the selected target arrays already in
`SimSnapshot`; no physics is recomputed or stored in UI. Next closest approach
is displayed as unavailable until T0070 supplies the n-body predictor. A linear
extrapolation would conflict with the physics spec’s statement that worker
prediction is authoritative.

## Relativistic clock acceptance

The existing dual clock remains driven by coordinate time and ship proper time.
Tests publish a gamma > 1.1 snapshot with deliberately divergent values and
assert both leaf strings and the gamma readout independently.

## Responsive and review invariants

The fixed desktop composition is used only when both viewport dimensions can
hold its panels without collision. Widths at or below 900 px, and heights at or
below 700 px, use one vertically scrollable stack. The overlay accepts pointer
input in that mode so wheel and touch scrolling work from non-control regions.
Regression viewports include 721, 800, and 850 px widths and assert zero panel
intersections plus successful activation of every warp button.

The integration-budget status names the reason explicitly as well as the
effective sustainable tier. Signed kinetic-energy formatting promotes rounded
999.5-unit boundaries to the next SI prefix for both signs.
