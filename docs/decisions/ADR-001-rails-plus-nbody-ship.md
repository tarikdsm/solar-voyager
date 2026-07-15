# ADR-001: Celestial bodies on analytic Keplerian rails; full n-body on the ship

**Status:** accepted (2026-07-15)

## Decision

Planets/moons/small bodies follow analytic Keplerian orbits (osculating elements baked from JPL Horizons at epoch J2026), *evaluated* — not integrated — at any sim time. The ship is numerically integrated feeling the gravity of **all** bodies simultaneously. An optional "dynamic bodies" mode (mutual n-body via symplectic leapfrog, 300 s fixed step, warp ≤ 1e5x, worker-hosted) exists behind a settings flag, default OFF.

## Why

- Rails are unconditionally stable at any warp (1e7x+): positions are functions of time, so Mercury cannot drift after years of high-warp play. Mutual n-body integration of moons needs ≤60 s steps for Io-class orbits and *will* secularly drift under any real-time budget at 1e7x.
- The gameplay requirement — "all bodies pull the ship", Lagrange points, gravity assists, third-body perturbations — depends on the field the *ship* feels, which is fully n-body here.
- O(1) per body per frame; saves store only sim time.
- This is the professional pattern (KSP, most trajectory tools) for the environment.

## Consequences

Rails accuracy degrades over sim-years (no mutual perturbations) within the documented bounds (physics-spec §2) — errors produce physically plausible orbits, invisible in gameplay. Dynamic-bodies mode covers purists at a warp cost.
