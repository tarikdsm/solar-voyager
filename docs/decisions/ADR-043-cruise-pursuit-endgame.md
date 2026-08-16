# ADR-043: Cruise pursuit endgame — rendezvous form of physics-spec §8.7

**Status:** accepted (2026-08-16)
**Task:** T0116 (CruiseDirector)
**Amends:** physics-spec §8.7 (written by T0114 under ADR-037). ADR-037 §1–§7 stand unchanged.

## Context

ADR-037 delivered a *departure* solver and, in physics-spec §8.7, a pursuit rule for
everything the departure solve cannot cover: the endgame after the brake leg, the fallback
when `ok = false`, and the abort-resume mode. T0116 is the first task to fly it.

As written, the rule is:

```
if d_rel > 1.2 · D_stop :  û = normalize(r_j(t + t_lead) − r(t)),  α = α_max
else                    :  û = −normalize(v_rel),                  α = α_max
settle when |v_rel| < 1e-3 km/s
```

Flown against the real integrator on the canonical routes, it does not arrive.

## Findings

1. **The lead is in the wrong frame.** §8.4's profile ends at rest in the ship's initial
   drift frame, which for an interplanetary route means *co-moving with the target* at up to
   30 km/s heliocentric. `r_j(t + t_lead)` is a heliocentric position, so the aim is offset by
   `v_j · t_lead` — with `t_lead = 2·T_h(d_rel)`, a 200 km approach has `t_lead ≈ 90 s` and an
   offset of ≈ 2,700 km, i.e. the rule points roughly 90° away from the target. Measured on
   LEO→Moon: the ship thrusts away from the Moon, out to 45,708 km at 62 km/s.
2. **The obvious repair oscillates.** Subtracting §8.4's own drift term,
   `Δ = r_j(t + t_lead) − r(t) − v(t)·t_lead`, fixes (1) exactly at rest — but `Δ` changes sign
   the moment `v·t_lead > d_rel`, which is where the brake switch already lives. The two
   branches then aim 180° apart on alternate frames and the 15°/s slew never converges.
   Measured on LEO→Mars: 1,746 branch flips, 39 % of the endgame's frames coasting unpowered
   in `align`, no arrival inside 120,000 frames.
3. **The settle threshold is unreachable under warp.** `|v_rel| < 1e-3 km/s` is smaller than
   the velocity the target's own gravity adds in a single warped step: 0.02 km/s per frame at
   Jupiter's 324,000 km stand-off at 1000×. The absolute threshold is a limit cycle, not a stop.
4. **The model is blind to geometry, not only to gravity.** §8.7 says the solve is thrust-only
   and that gravity is the mid-course loop's problem. It is also *body-blind*: the straight
   line from a 400 km LEO to Mars at J2026 passes through the Earth, and the profile's own axis
   reaches the surface 96 s after engage at 10 g. Nothing in §8 prevents this.

## Decision

Replace §8.7's two aim branches with a single **rendezvous law**, and relax the settle:

```
d_rel  = |r_j(t) − r(t)| − R_arr                            (signed)
v_appr = c·√(1 − 1/γ_a²),   γ_a = 1 + α·|d_rel| / (1.2 c²)  (§8.3 inverted)
v_des  = v_appr · sign(d_rel) · normalize(r_j(t) − r(t))
Δv⃗     = v_des − v_rel
û      = normalize(Δv⃗),   α = min(α_max, |Δv⃗| / Δt)
```

- `v_appr` is the exact §8.3 relation read backwards: the largest speed from which the ship
  can still stop inside `|d_rel| / 1.2`. The spec's 1.2 brake margin is preserved verbatim —
  it becomes a speed limit instead of a switch.
- The two original branches are its limits: at rest `Δv⃗` points at the target; above `v_appr`
  it points along `−v̂_rel`. There is no branch to chatter, and `t_lead` disappears entirely.
- `sign(d_rel)` makes the law correct from *inside* the stand-off sphere, which the original
  is not: its closing branch aims at the target centre, i.e. further in.
- The final step is a partial throttle, `|Δv⃗| / (α Δt)`, so a burn ends exactly rather than
  one warped frame late.
- Insertion settles when `|Δv⃗|` is below 2 % of the local circular speed (finding 3). That
  bounds the eccentricity it contributes at 0.02, inside the acceptance on its own, and the
  trim burn removes it anyway.

Additionally, guidance aims are held at least **15° above the local horizon** while inside
**4 collision radii** of a dominant body that is not the target (finding 4). The bias is a
rotation of the aim within the plane it already lies in, so its cost is exactly the kind of
error the mid-course re-solve exists to absorb, and it is active precisely while that
re-solve is still valid.

## Consequences

- physics-spec §8.7 is rewritten to the rendezvous form, with the superseded two-branch text
  kept alongside it and the reason it fails recorded. §8.1–§8.6 are untouched, so ADR-037's
  solver, its κ guard and its goldens are unaffected.
- The pursuit rule no longer evaluates rails at all: the target's motion enters through
  `v_rel`, which the snapshot already carries. One fewer rails evaluation per frame.
- `2·T_h(d_rel)` survives only as an ETA estimate.
- T0118's approach-brake assist should engage on the same `v_appr` quantity rather than
  re-deriving a `D_stop` comparison; the two are the same statement.
- T0120's cruise goldens should record the *arrival* residual as well as the profile, since
  the residual is now known to depend on when the last mid-course solve was accepted (κ ≤ 0.1
  admits up to 10 % of peak celerity, which on LEO→Mars is 535 km/s, not the 63.5 km/s a
  pure departure solve leaves).

## Alternatives rejected

- **Keep §8.7 verbatim and treat the endgame as out of scope.** The endgame is the acceptance
  criterion; there is nothing else to arrive with.
- **Hysteresis on the two branches (Schmitt trigger at 1.2 engage / 1.5 release).** Tried. It
  removes the chatter but not the frame error: a distance-based release reopens the closing
  branch long before the brake has finished, because `D_stop` falls as `v²`. The ship settles
  into a stable limit cycle ±150 km around the stand-off and never stops.
- **Exact 3-unknown Newton solve on §8.4's displacement identity.** ADR-037 §7 offers it as
  the escalation. It is a *departure* refinement; it does not address a co-moving endgame, and
  the measured open-loop residual it would improve is already 1e-6.
