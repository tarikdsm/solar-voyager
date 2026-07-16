# ADR-012: Account for accumulated relativistic phase in the Newtonian-limit regression

**Status:** accepted (2026-07-16)

## Context

Physics-spec section 3 and ADR-007 define the ship state as celerity `u` with
`dr/dt = u/gamma` and `du/dt = g`. The original section 7.9 regression required
a relativistic and Newtonian circular LEO coast to agree within `1e-9` relative
position after ten Newtonian periods because the instantaneous value of
`gamma - 1` is only about `3e-10` at LEO speed.

That bound ignores accumulated orbital phase. For a circular orbit under the
specified celerity equations,

```text
u * omega = mu/r^2
omega = u/(gamma*r)
u^2/gamma = mu/r
```

Writing `s = mu/(r*c^2)`, the circular solution has
`gamma - 1/gamma = s` and therefore
`omega_rel/omega_Newton = 1/sqrt(gamma)`. At `r = 6778.137 km` around Earth,
the unavoidable relative position separation after ten periods is about
`1.03e-8` even when each model starts in its own exact circular state.

The required test starts both propagators from the same coordinate position and
velocity so it also captures the tiny radial response to the relativistic
model's non-circular initial state. With the section 7.2 verification profile,
the stable measured final separation is `4.111e-8`; tightening tolerances by
100 times and allowing 20,000 steps changes it by less than `1e-12` relative.

## Decision

Keep the section 3 dynamics and ADR-007 unchanged. Define the section 7.9
Newtonian-limit regression precisely as the final position separation after ten
circular LEO periods from the same coordinate initial state, with a relative
bound of `5e-8`.

The test continues to use the stricter section 7.2 verification tolerance
profile and the normal 4,000 accepted-step budget. The new bound leaves a small
platform margin above the predicted physical result without hiding a material
integration error.

## Consequences

- The regression measures the implemented physics honestly instead of requiring
  two intentionally different equations to remain closer than their analytic
  phase drift permits.
- The difference remains negligible for gameplay and confirms the expected
  Newtonian limit at LEO speed.
- A future change that needs identical Newtonian coordinate acceleration would
  require different celerity force transformation equations and a replacement
  ADR; it must not be introduced merely to satisfy this regression.

## Alternatives considered

- **Keep the `1e-9` bound and compare orbital radii only.** Rejected because it
  hides phase divergence while claiming full trajectories agree.
- **Transform Newtonian gravity so coordinate acceleration is exactly `g`.**
  Rejected because it changes the ADR-007 dynamics and is outside T0017.
- **Start each model in its own circular state.** Rejected because it weakens the
  same-state Newtonian-limit comparison and still cannot meet `1e-9` after ten
  periods.
