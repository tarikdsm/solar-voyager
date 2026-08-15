# ADR-036: Collision and impact semantics

**Status:** accepted (2026-08-15)

## Context

The ship flies through planets. `trajectoryPredictor` already raises an `Impact`
event and the HUD already renders "collision course" — and then nothing happens.
Two consequences make this untenable for v2:

1. ADR-032's scope decision is **no landing, but low flybys are a supported
   experience**. A supported low pass needs a floor; without one there is no
   difference between a 50 km pass and a pass through the core.
2. `evaluateNBodyAccelerationInto` divides by `|r − rᵢ|³`. At a body's exact
   centre that is `0/0`, and the NaN propagates into osculating elements, the
   navball, the HUD and the renderer.

The predictor's detection cannot simply be promoted. It is **thrust-free** by
construction (`predictThrustFreeTrajectory` hardcodes a zero proper-acceleration
evaluator), so a powered descent is invisible to it, and it runs in a worker
against a forecast rather than the state the sim integrated.

Three existing structures constrain the design:

- **Golden trajectories are inviolable** (ADR-017).
- **`SimulationCore.step()` is not a fixed-step integrator.** One frame runs an
  adaptive DP54 through an ascending warp-tier ladder with a rollback path
  (physics-spec §3.2).
- **The dominant-body selector is hysteretic on purpose** (ADR-029), so "the
  body we are near" and "the body published as dominant" routinely differ.

## Decision

### 1. Collision radius, and the giants' cloud decks (data change)

The runtime contract is unchanged:

```
radius_col(body) = meanRadiusKm + (surface.atmosphereTopKm ?? 0)
```

`atmosphereTopKm` is therefore an **altitude above the mean radius**, not an
absolute radius. The v2 plan §3.4 wrote the intent as "Jupiter 71492+5000
style", which reads as an absolute radius and cannot be entered literally:
Jupiter's catalogued `meanRadiusKm` (69,911 km) *is already* the 1-bar volumetric
mean radius, so "+5000" against it would stack a second, undocumented margin on
one the mean radius already encodes. The plan's phrasing is corrected here.

**The rule adopted:** the collision sphere is the *smallest sphere containing the
body's 1-bar oblate spheroid*, which is its **equatorial radius at 1 bar**. For a
sphere that is the only choice that stops the ship at or above the 1-bar level
*everywhere including over the equator*, where the 1-bar level sits above the
volumetric mean. A mean-radius sphere would let an equatorial pass descend
1,581 km below Jupiter's 1-bar level before registering contact.

```
atmosphereTopKm = equatorialRadius(1 bar) − meanRadiusKm
```

| Body | `meanRadiusKm` | Equatorial radius at 1 bar | Source | `atmosphereTopKm` |
| --- | ---: | ---: | --- | ---: |
| Jupiter | 69,911 | 71,492 km | NASA Jupiter Fact Sheet, "Equatorial radius (1 bar level)" | **1,581** |
| Saturn | 58,232 | 60,268 km | NASA Saturn Fact Sheet, "Equatorial radius (1 bar level)" | **2,036** |
| Uranus | 25,362 | 25,559 km | NASA Uranus Fact Sheet, "Equatorial radius (1 bar level)" | **197** |
| Neptune | 24,622 | 24,764 km | NASA Neptune Fact Sheet, "Equatorial radius (1 bar level)" | **142** |

Every other body keeps `atmosphereTopKm: null`. A terrestrial body's catalogued
mean radius is already its solid surface; adding an atmospheric shell would make
"collision" mean "entry interface", which is a different feature with different
UX and belongs to T0140's atmosphere contract.

**Rejected: a 5,000 km cloud-top margin** on top of the equatorial radius. On
Neptune that puts contact at 1.2 body radii, which removes the low pass the
feature exists to support. The margin is also not sourced from anything — 5,000 km
above Neptune's 1 bar is vacuum by any atmospheric measure.

`tools/bake_ephemerides.py` carries the four values in `BODY_DEFINITIONS`, so a
re-bake reproduces them. No other catalog field is touched; `data/bodies.json`
changes by exactly four lines, verified with `git diff`.

> Observed while doing this, **not** fixed here: `visual.polarRadiusRatio` is
> committed in `bodies.json` for the giants (Jupiter 0.93513) but the baker only
> sets it for Earth, so a re-bake would flatten the others to 1.0. ADR-021 says
> "the ephemeris baker owns the value so regeneration cannot erase it", which is
> currently false. Out of scope for T0111 — touching another catalog field is
> exactly what this task was told not to do — but it should be filed.

### 2. Detection runs on accepted DP54 steps, via a non-numeric observer

`propagate` gains a trailing optional parameter:

```ts
export type Dp54AcceptedStepObserver = (timeSec: number, state: Float64Array) => boolean;
```

and `Dp54Result` gains `halted`. **The observer is provably non-numeric.** It is
invoked *after* the accept/reject branch has been taken and after `outputState`
and the FSAL `k1` are written; it takes no part in the error norm, the controller
factor, `stepSec`, or the accept decision, and it adds no derivative evaluation.
When it is absent the added cost is one comparison per accepted step. Every
existing caller omits it, so the golden harness and the predictor are bit-for-bit
unaffected by construction rather than by testing.

`budgetExhausted` gains `&& !halted` so a halt landing on the budget boundary is
not misreported as an integration clamp, and `reachedEnd` gains `&& !halted` so a
contact on the step that reaches the tier end is not mistaken for a completed
tier.

**Rejected: the predictor's `maxAcceptedSteps: 1` loop.** It is numerically
identical (`propagate` resets `hasFirstDerivative`, recomputing `k1` to the same
bits), but it forgoes FSAL and costs a seventh extra derivative evaluation per
step — ≈14% more work in the frame loop, forever, to service an event that fires
approximately never.

### 3. Two stages: a conservative chord, then a confirmed bisection

Stage one solves the same physics-spec §6 quadratic the predictor solves, over
the accepted step's chord in each body's linearly interpolated relative frame,
**reusing `trajectoryImpact.smallestUnitRoot`** — now exported rather than
duplicated. That function is the numerically stable citardauq pairing (`q/a`,
`c/q`) that avoids cancellation when `ac ≪ halfB²`, which is the ordinary case
for a shallow pass; a second copy would eventually disagree with the first.

**Stage one is deliberately a superset and is never authoritative.** The chord of
a gravitating arc sags toward the attractor: over a typical LEO accepted step
(≈17 s, ≈130 km of arc) the sagitta is `L²/(8r) ≈ 0.31 km`, against a contact
tolerance worth 7.7 m of travel. A chord-only test fires on every pass within
~300 m of the surface — including the periapsis = R + 0.1 km graze the acceptance
criteria require *not* to fire.

Stage two therefore re-propagates the sub-interval with the production tolerance
into a **separate preallocated workspace** (the outer `propagate` is mid-flight
and owns `integrationWorkspace`) and bisects the first genuinely penetrating time
to **1 ms**. It reports the **low** bracket endpoint — the last time the ship is
known to be at or outside the sphere — so the true crossing lies within the
tolerance and the ship never comes to rest inside a body. A candidate whose
propagated states never penetrate is discarded and propagation resumes.

The nested propagation is safe against the in-flight one: it runs to completion
synchronously, uses its own workspace and result, and the derivative's rails
cache is keyed on time so the outer loop refreshes it on its next stage.

`surfaceCollision.test.ts` asserts the sag claim directly — that the chord fires
on a 100 m graze over a 20 s step whose true arc is everywhere clear — so the
confirmation pass has an executable reason to exist and cannot be quietly
optimised away. The sim-level graze case uses 20 s frames for the same reason; at
1 s frames the sagitta is 1.2 m and the test would pass without reaching the code
it covers.

### 4. Every body is tested, not just the dominant one

O(43) per accepted step, with an early exit on the common miss. The dominant-body
selector only hands a descendant dominance at `g_C > 1.1·g_D` **and**
`|r−r_C| ≤ 0.9·r_SOI,C` (ADR-029), so descending onto Io while Jupiter is still
published as dominant is the ordinary case, not a corner case. The Sun is
dominant almost nowhere interesting yet is what a lost ship most plausibly falls
into. Testing all bodies also keeps the sim consistent with the predictor, which
already scans all bodies — a divergence there is exactly the "the warning fired
and nothing happened" defect this task exists to remove. Measured cost is in
`docs/bench/T0111-summary.md`; it is not the dominant term.

### 5. A segment that opens inside a body is immediate contact

`findFirstTrajectoryImpactInto` skips a body when `c ≤ 0`, because a forecast
polyline that starts underground has no meaningful entry crossing. For the sim
that skip is a fall-through hole. The new module checks `|r₀| ≤ R` **before** the
root solve and reports contact at the segment's own start time.
`trajectoryImpact`'s behaviour is unchanged; the shared piece is the root solver,
not the loop.

### 6. Freeze

On confirmed contact, within the same `step()`: abandon the tier ladder; adopt
the bisected contact state and time; force `effectiveWarp` and `requestedWarp` to
1; close the active burn against the contact state and force throttle to 0; clear
commanded rotation rates; publish.

**`completedWarp === null` is now a reachable, valid outcome.** It previously
threw `'ship propagation exhausted the integration budget'`, and a contact during
tier 0 is the *common* case, so the impact branch is tested before that throw.
Getting this wrong turns every crash into an exception.

Rotation rates are cleared for the reason ADR-035 clears them on a warp increase:
rates that outlive the regime that allowed them reappear on the next core that
reads the state, as an unexplained spin.

`CommandState` gains `impactFrozen`, and `setThrottle` / `rotate` / `setWarp`
clamp to 0 / 0 / 1x while it is set — the same "a regime forces the commanded
quantity, it does not throw" idiom `MAX_THRUST_WARP` and
`MANUAL_ATTITUDE_MAX_WARP` already use, rather than a third idiom. Without it a
UI that keeps sending intent at a frozen ship would open a burn-log entry at a
frozen timestamp.

Subsequent `step()` calls return the published snapshot without touching the
clock, the ledger or the burn log.

### 7. `SimSnapshot` additions

Exactly the four primitives the v2 plan §2 specifies, all double-buffer safe:

```ts
impactOccurred: 0 | 1;     // 1 freezes integration until recovery
impactBodyIndex: number;   // -1 when none
impactSpeedKmS: number;    // |v_ship − v_body|, coordinate velocity
impactSimTimeSec: number;  // bisected to within 1 ms
```

`impactSpeedKmS` excludes the body's **surface rotation**: the catalog has
`siderealRotationPeriodSec` but the sim has no surface-velocity field, and
including it would imply a landing model this task does not have.

`WarningFlag.IMPACT` exists and is still **not** written by anything. It is left
alone deliberately: the plan fixes the snapshot delta at four fields, and
populating a previously-dead flag is a HUD decision that belongs to T0112.

`CompiledRailsCatalog` gains `collisionRadiiKm`, compiled once from
`meanRadiusKm + (atmosphereTopKm ?? 0)`, so the sim and the predictor read one
source instead of two. `RailsBodyInput`'s new fields are optional, so every
existing caller — including the golden harness — compiles unchanged.

### 8. Recovery is a game-layer concern that reuses the save path

`GameSessionController.restoreFromState(state)` and `respawnInOrbit(bodyIndex?)`
both build a `SimulationPersistentState` and hand it to the same
`createSimulation` that `loadLocal` and `importJson` use. That is what "valid by
the same rules a loaded save must satisfy" means operationally: the document
passes `copyAndValidateSimulationPersistentState` or the recovery fails cleanly
and the freeze stays. A failed recovery is a no-op, not a half-restored session.

Respawn places the ship on a circular orbit at **two body radii**, prograde with
the body's motion and radially above where the ship was lost, via
`createCircularOrbitState`. Simulation time, ship proper time, the kinetic-energy
baseline and the completed burn log are preserved — a respawn relocates the ship,
it does not restart the mission. Throttle is 0 and the active burn is dropped,
because the validator requires those two to agree and a burn interrupted by a
planet is over. The radius is clamped above the collision sphere so a future
catalog whose atmosphere top exceeded its mean radius could not respawn the ship
inside the surface it just hit.

### 9. Allocation: the restore ring allocates, deliberately

`RestorePointRing` keeps six slots at a 10 s wall-time cadence, driven by the
frame loop's existing `wallDtSec` (no clock enters `sim/`), and skips capture
while frozen so the ring never fills with unflyable states.

Capture calls `SimulationCore.exportPersistentState()`, which **allocates**. A
parallel non-allocating `captureInto` path through `SimulationCore` and
`ledger.ts` was designed and rejected. The zero-allocation rule binds the
*per-frame* path; this is one capture per ~600 frames, and the CI heap gate
measures *retained* growth across a forced double GC, which collectable garbage
cannot move. Against that, ~150 lines of parallel capture machinery in `src/sim`
means two persistence implementations that must agree forever — the same coupling
class (ledger / burn basis / persistence having to agree) that produced T0104's
one significant defect. Keeping `src/sim` small and single-pathed is worth more
than a few KB of collectable garbage every ten seconds.

Measured rather than asserted (`docs/bench/T0111-summary.md`): **0.91 µs and
≈1,029 transient bytes per capture**, ~6.2 KB held by the full ring, and
**−24,880 B retained** over a 600 s window containing 60 capture cycles. If a
future task moves capture into a hot path, this trade-off is re-decidable from
these numbers.

### 10. An impacted session is savable, and the freeze is not persisted

`SimulationPersistentState` and save envelope v3 are untouched — no migration in
this PR, which matters because this milestone has already spent one.

The freeze is *derived geometry*, not physical state. On load the ship sits at
`R + ε` with its full impact velocity still in the state vector, pointed inward,
so the first `step()` re-detects the same contact against the same body and
re-freezes. Round-tripping is automatic rather than serialized, and decision 5's
start-inside guard closes the one hole — `ε` rounding to zero or negative — that
would otherwise let a reloaded crash fall through.

## The NaN path is closed for the ship

After this change the central singularity in `evaluateNBodyAccelerationInto` is
unreachable for the ship:

- contact is taken at the low bracket endpoint, strictly outside the sphere;
- every catalogued body has `meanRadiusKm > 0` (schema `exclusiveMinimum: 0`), so
  every collision sphere has positive radius and strictly contains its centre;
- a segment that opens inside is caught by decision 5 and frozen at its start;
- while frozen, no propagation runs at all.

One precondition: the *initial* state handed to `SimulationCore` must not be at a
body centre. That is a construction-time input, not a reachable dynamic state,
and the first step surfaces it as an immediate contact rather than as a NaN.

The guard in `nbodyForces` stays. It still protects the **predictor**, which
propagates a forecast with no freeze, and removing it would trade a cheap
defensive branch for a class of crash.

## Consequences

- `bench:sim` `averageStepMs` 0.0779 → 0.0914 (+17.3%), which is 4.6% of the 2 ms
  step budget. The delta is dominated by one extra 43-body rails evaluation per
  accepted step, not by the collision arithmetic; the summary records the
  cache-sharing optimisation that was declined and why.
- **Total bundle gzip 559,645 → 563,689 B against a 570,000 B golden**, leaving
  1.1% headroom. This PR does not change a budget and does not need to, but the
  next UI-bearing task on this milestone will likely need a §6 re-baseline or a
  code-splitting pass. Flagged, not absorbed.
- Goldens are byte-identical, verified with `git diff -- tests/golden/`.
  Structurally unreachable: the harness drives `propagate` directly with a
  seven-component state, never constructs `SimulationCore`, and omits the new
  optional observer argument.
- `data/bodies.json` changes by exactly four lines.
- A new Playwright harness, `npm run test:impact-overlay`, is wired into CI. It
  caught two defects that unit tests could not: the overlay's buttons were inert
  because `.app-overlay` is `pointer-events: none` and the panel had not opted
  back in, and the harness page itself was measuring unstyled layout until it
  imported `app.css`.

### Handoff notes

- **Restore does not make the "no published body rates" gap worse, and does not
  fix it.** T0108 recorded that `SimSnapshot` publishes no body rates, so a
  restored spin is invisible to `FlightController`. This ADR touches that seam
  twice, in opposite directions and on balance neutrally-to-better. A **respawn**
  writes zero rotation rates, and the **freeze** clears them, so neither recovery
  path can hand the next core a spin the controller cannot see — those two cases
  are strictly better than a save/load restore. A **restore from a ring slot**
  reinstates whatever rates were captured, exactly as loading a save already
  does, so it is neither better nor worse than the existing gap. Nothing here
  narrows the underlying contract hole: the rates still are not published, so a
  restored spinning ship still surprises the controller. That remains T0112's,
  and it needs its own ADR.
- `writeSlewLimitedQuaternionInto` does not short-circuit a zero slew budget: it
  composes an identity rotation and then renormalizes, so a core rebuilt from a
  persisted document publishes an attitude quaternion ~1 ULP per component off
  the persisted one. ADR-035's "a non-positive budget holds the current attitude"
  is true only up to that renormalization. It does not accumulate — restoring the
  same document twice is bit-identical — and `collisionRecovery.test.ts` documents
  it. Left for a separate change because it is ADR-035 surface.

## Alternatives considered

- **Chord test only, no confirmation pass.** Cheapest, and wrong by ~300 m in the
  unsafe direction: every low pass becomes a crash and the graze acceptance
  criterion fails.
- **Test only the dominant body.** Cheaper still, and wrong whenever the
  hysteretic selector lags — which is the normal state of affairs on approach to
  a moon.
- **Bisect on the chord instead of on propagated states.** The quadratic root
  already *is* the exact crossing of the chord, so this refines the wrong curve;
  it would converge quickly to an answer that is 0.31 km off.
- **Zero the ship's velocity at contact.** Rejected: the impact speed is what the
  overlay reports, and a zeroed state would make the reloaded-save re-detection
  in decision 10 impossible.
- **Persist the impact fields in the save envelope.** Rejected: it is derived
  geometry, and it would cost a v4 migration to store something the first step
  recomputes.
- **A non-allocating `captureInto` path** (decision 9). Rejected on the
  maintainer's call after measurement; the numbers are recorded so it can be
  revisited.
