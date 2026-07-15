# ADR-007: Special-relativistic ship dynamics + photon-drive energy accounting

**Status:** accepted (2026-07-15)

## Decision

1. The ship's dynamics are **special-relativistic**: state is (r, u, τ) where u = γv is the proper velocity (celerity), integrated as `du/dt = g(r,t) + F/m`. Speed asymptotes to c and can never reach or exceed it — that IS the relativistic physics the game promises. Celestial bodies remain Newtonian on rails (ADR-001); gravity acts on the ship as a Newtonian force on rest mass (no GR).
2. Propulsion is a **pure-energy (propellantless) drive**, physically modeled as a photon drive: thrust F requires power **P = F·c**. The energy ledger meters `E = ∫P dt` in Wh (SI prefixes). Energy reserve is infinite; the *cost display* is the game's score.
3. The player commands **proper acceleration α** (thrust = m·α). Coordinate acceleration parallel to motion falls as 1/γ³ — the "heavy at high speed" feel is emergent, not scripted.

## Why

- The user requirements — up to light speed, real time/space treatment, expensive plane changes, sluggish feel for costly maneuvers — all fall out of ONE consistent model instead of ad-hoc gameplay knobs:
  - Plane changes / leaving the ecliptic need large |Δp|, and E = c·|Δp| makes them genuinely expensive (visiting the Sun's poles costs PWh-scale energy — real).
  - Braking costs exactly like accelerating (photon drives can't regenerate) — no free lunches.
  - Near c, γ³ kills coordinate acceleration and energy diverges as (γ−1)mc² — the asymptote is the gameplay.
- Photon drive is the *only* physically honest propellantless thruster; using its P = F·c bound keeps "realistic energy calculations" defensible.
- Celerity-state integration (u instead of v) is numerically robust: no v > c excursions from integrator overshoot, exact Newtonian limit at low speed.

## Consequences

- SimSnapshot grows: γ, proper time τ, power draw, barycenter state, relativistic momenta (this ADR covers that interface change).
- DP54 integrates a 7-component state (r, u, τ); two-body tests unchanged at low speed (γ≈1).
- Dual clocks on the HUD: coordinate UTC vs ship proper time (MET in τ). At high warp × high γ they diverge dramatically — intended drama, must be tested.
- Energy figures are astronomically large by design; HUD must format Wh with prefixes k…Y.
