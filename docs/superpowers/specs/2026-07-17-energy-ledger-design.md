# Photon-drive energy ledger and burn log

## Goal

Meter the physical cost of thrust with warp-invariant DP54 quadrature, expose
numeric totals through `SimSnapshot`, retain a bounded allocation-free burn
history, and provide reusable three-significant-digit SI formatters for the HUD.

## Integrated quantities

The private SimulationCore state has twelve components. Indices 0-6 remain
`(r,u,tau)`; indices 7-11 are:

- cumulative energy spent in joules;
- cumulative scalar proper delta-v in metres per second;
- cumulative inertial proper-delta-v vector X/Y/Z in metres per second.

For proper acceleration vector `alpha` in km/s^2 and inverse Lorentz factor
`dTau/dt = 1/gamma`, every DP54 stage evaluates:

```text
dE/dt       = massKg * (1000*|alpha|) * (1000*cKmS)
dDv/dt      = (1000*|alpha|) / gamma
dDvVec/dt   = (1000*alpha) / gamma
```

Power is non-negative for acceleration, braking, and turning. The vector is a
signed integral; the scalar is the experienced path length in velocity space.

## Snapshot behavior

`shipState` remains seven components. The inactive snapshot copies only those
components, then publishes cumulative energy/proper delta-v from the private
augmented state. Kinetic-energy change is recomputed from celerity relative to
the initial kinetic-energy baseline. Current power remains the instantaneous
`F*c` value.

## Burn lifecycle

The command controller notifies SimulationCore after an actual throttle value
changes. A zero-to-positive transition opens an active record at current `t`,
`tau`, cumulative totals, integrated vector, dominant body, and its local
orbital basis. Positive-to-positive updates only raise peak power. A transition
to zero synchronizes and closes the record. Zero-duration/no-energy intervals
are omitted.

The completed log is a 256-entry ring. `get(0)` is the oldest retained burn;
`get(count-1)` is the newest. Entry objects and the active record are allocated
once. Components are projections of the burn's integrated vector on the
start-frame normalized prograde, normal, and radial axes.

## Formatting

`formatEnergyWh(joules)` converts by 3600 and formats `Wh`; `formatPowerW(watts)`
formats `W`. Both select `k, M, G, T, P, E, Z, Y`, clamp at yotta, and show three
significant digits. Formatting allocates strings and is intentionally a UI
cadence operation, never part of `step()`.

## Verification

- A two-burn, high-acceleration impulsive approximation starts in a computed
  circular 300 km LEO, coasts to the computed GEO transfer apogee, and performs
  the circularization burn. Scalar proper delta-v and `c*m*delta-v` energy agree
  with the vis-viva solution and canonical 3.90 km/s within the specified 1%.
- A continuous 90-degree turn of a 30 km/s celerity vector uses a rotating
  perpendicular thrust direction. Energy matches `integral(F*c dt)` within 2%
  and exceeds the impulsive momentum-change lower bound.
- The same nonzero burn at 1x and 100x yields matching totals across genuinely
  different frame partitions (1000 short 1x frames versus 10 long 100x frames).
- Failed propagation publishes neither motion nor ledger progress.
- A multi-frame throttle interval produces one completed burn with signed local
  components and peak power.
- Formatter boundary and prefix cases are deterministic.
