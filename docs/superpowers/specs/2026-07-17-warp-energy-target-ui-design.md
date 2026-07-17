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

