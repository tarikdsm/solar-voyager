# FlightController — per-task design (T0108)

Task: `T0108` (v2 plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2,
§3.1). Spec: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.2.
Depends on T0105 (`InputFrame`), T0107 / ADR-035 (attitude slew, wall-time
authority contract), T0104 / ADR-034 (`VesselConfig`).

## Problem

T0105 landed the input engine and, with it, an explicitly interim
`game/input/inputCommandBridge.ts` that reproduces v1's `InputFrame → Commands`
translation so the deployed game stays playable. It has three gaps that v2's
first pillar — a *visible* ship flown in third person — cannot live with:

1. **No mouse-look.** `InputFrame.lookYawRad` / `lookPitchRad` are produced by
   the engine and dropped on the floor. Pointer-lock steering is the headline
   control scheme of v2 and nothing consumes it.
2. **No wall-time authority.** The bridge writes `axis · 0.6` straight into
   `Commands.rotate`, which takes rad per *simulated* second. At 50× a fixed
   deflection spins the ship fifty times faster in wall time — v1's
   uncontrollable tumble, which ADR-035 fixed in the sim's half (the lockout and
   the constant) and left the game half to this task.
3. **Attitude snaps to the axis.** A rate command that appears and disappears
   with a key edge reads as a massless object. The ship must accelerate into a
   turn and settle out of it.

Plus three capability gaps in the acceptance list: only three of the eight
`AttitudeMode` holds have ever been bound, the manual-regime acceleration
ceiling that ADR-034 persisted (`alphaManualMaxMS2`) has no consumer, and there
is no stability assist.

## Decision summary

1. **Two control channels, deliberately different.** Mouse-look is a *position*
   demand: deltas integrate into a desired attitude that the controller pursues
   with a critically damped law. Keyboard/gamepad axes are a *rate* demand:
   direct, crisp, v1-identical. §2.
2. **The pursuit is a genuine second-order system** — `ω̇ = k_p·θ_err − k_d·ω`
   integrated in wall time, with `k_d = 2√k_p` so ζ = 1 exactly. Final constants
   `k_p = 6.0 s⁻²`, `k_d = 4.898979485566356 s⁻¹`. §3.
3. **The control-law saturation and plan §3.1's normalization are separate
   clamps applied in that order.** Saturating the *wall* rate first is what
   makes a saturating input warp-invariant; physics-spec §3.0.1's formula is
   then applied verbatim on top and is provably a no-op. §4.
4. **The manual regime gates rotation on `requestedWarp`** — the same figure
   `Commands.rotate` keys its lockout on — and normalizes by `effectiveWarp`.
   The two never disagree about *whether* rotation is allowed. §4.
5. **The acceleration ceiling is a regime, not a clamp.** `thrustRegime`
   selects `alphaManualMaxMS2` or `alphaMaxMS2` from the session vessel; T0116
   flips it to `'cruise'` for the full envelope. §5.
6. **`rotate()` stays change-latched.** Not an optimization: it is what lets a
   restored session keep its saved rotation rates, and what keeps the trajectory
   predictor from being invalidated every frame. §6.
7. **`INPUT_ACTIONS` becomes append-safe.** Seven new actions are added and
   `parseInputBindings` backfills actions a stored document predates instead of
   rejecting the document. Without this every existing save becomes unloadable.
   §7.
8. **`ROTATION_RATE_RAD_S` moves, it is not deleted.** §8.

No ADR. Nothing in `SimSnapshot`, `Commands`, `bodies.json` or
`physics-spec.md`'s formulas moves; the sim is not touched at all.

---

## 1. Shape: controller, router, and who calls what

The plan §2 contract takes decomposed setters (`setLookDelta`,
`setRotationAxes`, `setThrottleAxis`, …) rather than an `InputFrame`. That is
load-bearing: T0106 feeds the same setters from a gamepad and T0116's
`CruiseDirector` drives throttle and holds with no device behind it. So the
controller must not know what an `InputFrame` is.

```
InputEngine.poll(dt) ──► FlightInputRouter.apply(frame) ──► FlightController setters
                                    │                                  │
                                    └── warp ladder ──► Commands       ▼
                                                             FlightController.update(dt) ──► Commands
```

- `src/game/flight/flightController.ts` — the plan §2 class. Owns the desired
  attitude, the pursuit state, the throttle lever, the thrust regime and the
  stability assist. Talks to the sim only through `Commands`.
- `src/game/flight/flightInputRouter.ts` — the *only* module that knows both
  `InputFrame` and `FlightController`. It also owns the warp ladder, which is
  player intent but not flight control and therefore has no place in the §2
  contract.

`main.ts` calls `router.apply(engine.poll(dt))` then `controller.update(dt)`,
replacing the single `bridge.apply(...)` call.

### Deviations from the plan §2 signature

The plan's naming rule allows a documented deviation. Four members are added;
none of the specified ones changed.

| Member | Why it must exist |
|---|---|
| `setThrustRegime(regime)` / `thrustRegime` / `accelerationCapMS2` | The task requires the manual ceiling to be "a mode/parameter rather than a hard clamp". T0116 needs a way to select the full envelope; the §2 constructor has no such port. |
| `setStabilityAssist(enabled)` / `toggleStabilityAssist()` / `stabilityAssist` | Acceptance requires SAS to be *toggleable*. |
| `resetAxes()` / `releaseAxes()` | The restore path. `GameSessionController.onSettingsChanged(_, 'restore')` must be able to say "forget local intent but do not overwrite the rates the save just restored" — see §6. The interim bridge had exactly these two. |
| `setVessel(vessel)` | Simulation replacement. `commands` and `snapshot()` reach the live core through the stable facade `main.ts` already owns, so they never need re-pointing; `vessel` is a value, is per-`SimulationCore` (ADR-034 §4) and is *not* `DEFAULT_VESSEL`, so it does. |
| `adoptCommandedThrottle(commanded01)` | `snapshot.throttle` is `lever × regimeFraction`, so the restore path cannot feed it back in as a lever position without scaling it twice. Returns the lever, so the input engine — which owns the same lever — is seeded from one figure. |
| `throttleAxis` (getter) | Lets callers inspect the lever without a second source of truth. |

There is deliberately **no** `updatePorts` on the controller, unlike the bridge's
`updateCommands`. `GameSessionController` sets `currentSimulation` *before* it
calls `onSimulationReplaced`, so a "release the old session's axes then
re-point" method reached through a stable facade would flush zeroes over the
rates the restore had just applied. `tests/render/sessionSettingsPage.tsx` is
changed to hold the same stable facade `main.ts` does, which removes the need
for the method entirely. `FlightInputRouter` does keep an `updatePorts`, because
its only port use is reading `requestedWarp` and issuing `setWarp` — nothing it
can clobber.

---

## 2. Two channels

`docs/…/v2-free-flight-design.md` §4.2 describes mouse-look as pursued and
keyboard axes as merely "available and rebindable". That distinction is kept,
and it is the right one on the merits:

- A **mouse delta is an angle**. The player has moved a virtual head by 12°; the
  ship's job is to get its nose there. Pursuit with mass is exactly the desired
  reading.
- A **keyboard axis is a rate**. `W` held means "keep yawing". There is no
  target attitude in the gesture, and inventing one by integrating the axis into
  the desired attitude produces a permanent steady-state lag of
  `k_d·r/k_p = 0.49 rad ≈ 28°` between where the nose is and where the model
  thinks it should be — the ship visibly trails its own stick.

So:

> **While any rotation axis is deflected, the desired attitude is re-anchored to
> the ship's current attitude every frame.** The axis contributes a direct
> feed-forward rate; the pursuit sees no error from it. Mouse deltas are
> integrated on top of that anchor in the same frame, so using both at once
> works and neither channel erases the other.

Consequences, all intended:

- Releasing an axis leaves the nose where it is with zero commanded rate
  (v1-identical, and what `tools/tests/sessionSettingsRegression.mjs` and
  `src/ui/BurnLogPanel.test.tsx` pin).
- A single held axis produces exactly `rotate(0.6, 0, 0)` at 1×, bit for bit.
- Mouse-look gets the mass; keyboard stays crisp.

### Sign and axis conventions

ADR-025 §4 / physics-spec §3.0.1: the ship's `+X` is forward, roll is about
`+X`, pitch about `+Y`, yaw about `+Z`, and `Commands.rotate` takes
`(pitch, yaw, roll)` and is *reordered* to `[roll, pitch, yaw]` on entry.
Everything inside the controller is stored in **body-axis order**
`[X = roll, Y = pitch, Z = yaw]` and converted exactly once, at the `rotate()`
call site. Mixing the two orderings in intermediate state is the obvious way to
get this wrong.

`writeQuaternionFromForwardInto`'s zero-roll convention keeps body `+Z` aligned
with the inertial `+Z`, so body `+Z` is the ship's up and body `+Y` is its left.
A right-hand rotation about `+Z` therefore swings the nose **left** and one
about `+Y` swings it **down**. `InputFrame` reports look deltas as `+right` and
`+up`. Hence the desired attitude is rotated by the body-frame vector

```
[0, −lookPitchRad, −lookYawRad]        # [roll, pitch, yaw] body axes
```

applied as `qDesired ← qDesired ⊗ Δq`, i.e. in the desired frame, so a
continuous sweep composes without drift. (v1's `pitchUp` action already
produces a positive `+Y` rate, which by this convention is nose-down. That is a
pre-existing binding-label question, not a controller one; the axis path is
byte-identical to v1 and is deliberately not changed here.)

---

## 3. The pursuit law and its constants

```
ω̇ = k_p · θ_err − k_d · ω          per body axis, integrated in WALL time
ω  ← clamp(ω + ω̇·Δt_wall, ±RATE_MAX)
```

Semi-implicit: `ω` is advanced first and the attitude error closes with the new
`ω`. This is a true second-order system, `θ̈ + k_d θ̇ + k_p θ = 0`, so
`k_d = 2√k_p` is critical damping and the step response
`θ(t) = θ₀(1 + ω_n t)e^{−ω_n t}` never crosses zero — **overshoot is
identically 0**, not merely under the 2° acceptance bound.

The plan's `handoff_notes` suggested `k_p = 2.5`, `k_d = 0.9` and asked for them
to be tuned. `k_d = 0.9` is ζ = 0.28 under this reading — 40% overshoot, not
critically damped — and `k_p = 2.5` is too soft to meet the 2 s convergence
budget. Both were retuned.

**Final: `k_p = 6.0 s⁻²`, `k_d = 2√6 = 4.898979485566356 s⁻¹` (ζ = 1 exactly).**

`k_d` is written as `2·Math.sqrt(k_p)` in source rather than as a decimal
literal, so the two constants cannot drift apart into an accidental ζ ≠ 1.

Measured (60 Hz, rate cap 0.6 rad/s):

| Step | Settles ≤ 2° | Settles ≤ 2° and ≤ 2°/s | Peak rate | Overshoot |
|---|---|---|---|---|
| 10° | 1.28 s | 1.57 s | 0.158 rad/s | 0.000° |
| 20° | 1.58 s | 1.95 s | 0.317 rad/s | 0.000° |
| 30° | 1.75 s | 2.17 s | 0.475 rad/s | 0.000° |
| 45° | 2.20 s | 2.47 s | 0.600 rad/s (saturated) | 0.000° |
| 180° | 6.13 s | 6.33 s | 0.600 rad/s (saturated) | 0.000° |

The 2 s acceptance is asserted against the ≤ 2° column, which is the yardstick
the acceptance criterion itself uses ("no overshoot > 2°"). The stricter
"settled" column is reported because it is the honest answer to "when does it
*look* stopped", and it still fits 2 s for a 20° flick.

Why 6.0 and not more or less:

- **Lower** (the suggested 2.5, ω_n = 1.58 rad/s) misses the 2 s budget for any
  deflection past ~12° and reads as mushy.
- **Higher** (8+) saturates the 0.6 rad/s authority at a 30° flick, which throws
  away the shaped response for ordinary inputs — the ship stops feeling like it
  has a rate envelope and starts feeling like it has a rate *setting*.
- 6.0 puts the saturation knee at ≈ 45°, so ordinary aiming corrections ride the
  smooth curve and only a deliberate large slew hits the wall. Peak rate for a
  30° flick is 79% of authority.

Robustness: the explicit integration is stable for `k_d·Δt < 2`, i.e. Δt up to
0.41 s, and **the production path cannot reach even a quarter of that**.
`render/telemetry.ts` clamps the game delta to `MAX_GAME_DELTA_SEC = 0.1 s`
before `main.ts` ever calls `update()`; `MAX_UPDATE_DT_SEC` repeats the same
0.1 s so the controller is safe when driven directly (tests, T0116). At the real
worst case, Δt = 0.1 s, the response is still monotone — overshoot exactly 0 —
and a 20° step settles in 2.00 s.

Beyond that clamp the controller degrades rather than tracks, and the
distinction matters when reading the tests. A caller that passes `update(2.5)`
gets 0.1 s of integration against 2.5 s of elapsed attitude, a mismatch
production cannot create; the response then overshoots (15.4° measured at 30°).
The test that drives 2.5 s frames therefore asserts only boundedness and
finiteness — graceful degradation — while tracking quality is asserted at
0.1 s. 15° of overshoot is not an accepted property of this controller; it is
what a synthetic frame mismatch produces.

### Settle deadband

Exponential decay never reaches zero, so without a deadband `rotate()` would be
called every frame forever with ever-smaller values. That is not merely untidy:
`SimulationCommands.rotate` fires `onTrajectoryInvalidated` on any change while
thrusting in manual mode, so an asymptote would re-invalidate the predictor
every frame of powered flight.

When `|θ_err| ≤ 1e-4 rad` and `|ω| ≤ 1e-4 rad/s` on all three axes and no axis
is deflected, the pursuit state is zeroed and the desired attitude is re-anchored
to the current attitude. 1e-4 rad is 0.0057° — three orders below anything
renderable.

### Anti-windup

The clamp is applied to the pursuit *state*, not only to the output, and after
the feed-forward is added the state is back-solved from the clamped total:

```
total = clamp(ω_pursuit + ω_axis, ±RATE_MAX)
ω_pursuit ← clamp(total − ω_axis, ±RATE_MAX)
```

so the controller's belief about the rate always equals the rate the ship is
actually turning at. Without this the state winds past the authority limit
during a large slew and the response overshoots on the way out — the one way
this law *can* overshoot.

---

## 4. Warp: two figures, two jobs, no fight

ADR-035's handoff note is explicit that `Commands.rotate`'s lockout keys on
`requestedWarp` (command validation must not depend on an integrator outcome),
while plan §3.1's normalization divides by `effectiveWarp`. The governor only
ever clamps *down*, so `effectiveWarp ≤ requestedWarp`; the disagreement is real
and one-directional.

The controller assigns each figure exactly one job:

| Concern | Figure | Why |
|---|---|---|
| *May* the player rotate manually? | `requestedWarp > MANUAL_ATTITUDE_MAX_WARP` | Identical predicate to the one the sim enforces. If the controller used `effectiveWarp` it would happily command rates that `rotate()` silently discards, and its rate model would be wrong for as long as the disagreement lasted. |
| *How fast*, in sim units? | `effectiveWarp` | The wall-clock apparent rate is `simRate × effectiveWarp`, because `effectiveWarp` is what advances the clock. Dividing by `requestedWarp` would make a governed-down ship rotate slower than commanded. |

Tested directly at `requestedWarp = 1000, effectiveWarp = 10`: manual rotation is
refused, holds still reach the sim.

When the lock engages, the controller drops pending look deltas, zeroes the
pursuit state, and re-anchors the desired attitude — otherwise the error would
accumulate silently for the whole locked interval and the ship would lurch when
warp came back down.

### Clamp ordering

physics-spec §3.0.1 stated

```
rateSimRadS = clamp(inputRateWallRadS / effectiveWarp, −RATE_MAX, RATE_MAX)
```

without saying which frame `RATE_MAX` bounds. Applied to a raw PD output with
`RATE_MAX` read as a *sim*-frame bound, this is not warp-invariant: the law
peaks at **2.85 rad/s** for a 180° error (measured at 60 Hz; the analytic
critically damped peak is `θ₀·ω_n/e = 2.83 rad/s`), which clamps to 0.6 at 1×
but would pass 0.6 sim rad/s = **30 rad/s of wall rotation** at 50×. The fix is
not to change the formula. `RATE_MAX` is the vehicle's **wall-frame** rotational
authority, so the control law saturates against it before it produces
`inputRateWallRadS` at all:

```
inputRateWallRadS = clamp(k_p·θ_err − k_d·ω integrated, ±RATE_MAX)       # control law, wall frame
rateSimRadS       = clamp(inputRateWallRadS / effectiveWarp, ±RATE_MAX)  # physics-spec §3.0.1, verbatim
```

The spec's clamp is then provably a no-op (`effectiveWarp ≥ 1` on the whole
ladder) and is kept in the code anyway, because it is the bound the sim is
entitled to assume and because a future ladder entry below 1× would need it. The
sim-frame envelope this actually yields is `RATE_MAX / effectiveWarp`.

**physics-spec §3.0.1 and `docs/architecture.md` were updated to say which frame
each bound applies to** — otherwise the documented envelope (0.6 sim rad/s at
50×) and the shipped one (0.012) differ by a factor of `effectiveWarp`, and
T0116 reads the spec, not this file. No formula changed and no symbol was
redefined, only pinned to a frame, so no ADR (confirmed with the maintainer and
in review).

A test asserts both that the composition is warp-invariant at saturation and
that the outer clamp never binds.

---

## 5. Throttle and the manual regime

The lever is `[0, 1]` and is the controller's state (`setThrottleAxis` absolute,
`stepThrottle` relative). What reaches the sim is scaled by the regime:

```
regimeFraction = alphaCapMS2 / vessel.alphaMaxMS2
commands.setThrottle(lever · regimeFraction)
```

`thrustRegime = 'manual'` (default) → `alphaCapMS2 = vessel.alphaManualMaxMS2`;
`'cruise'` → `vessel.alphaMaxMS2` (fraction 1, the full envelope, which is what
T0116 engages). The vessel is the one in force for the session —
`SimulationCore.vessel`, i.e. the *persisted* vessel after a restore, never
`DEFAULT_VESSEL`. It is re-read by `setVessel()`, which `main.ts` calls from
`onSimulationReplaced` (there is no `updatePorts` on the controller — see §1).

With the ADR-034 defaults the manual fraction is
`19.6133 / 98.0665 = 0.19999999999999998`, and `0.19999999999999998 × 98.0665`
is exactly `19.6133` in float64 — the round trip is bit-exact both through
m/s² and through the sim's internal km/s², so "full manual throttle yields
exactly `alphaManualMaxMS2`" is testable as an equality, not a tolerance.

The commanded value is compared against `snapshot.throttle`, not against a local
latch — the reason the interim bridge did the same: `setThrottle` silently
forces 0 above `MAX_THRUST_WARP`, and a latch would leave the lever and the sim
permanently disagreed instead of resuming when warp drops back.

---

## 6. Flush discipline, holds, and the restore path

**`rotate()` is change-latched.** The controller issues it only when the
computed sim-rate triple differs from the last one it issued. Three things
depend on this:

1. A restored session carries its saved rotation rates in the sim. After
   `resetAxes()` the latch is `[0,0,0]` and an idle frame computes `[0,0,0]`, so
   nothing is issued and the restored rates survive — exactly the property
   `src/game/sessionController.test.ts` pins.
2. The predictor is not invalidated on frames where nothing changed.
3. An idle frame issues no commands at all.

**Holds.** `requestHold(mode)` accepts all eight `AttitudeMode` values,
including `'manual'` (which is how the player takes back control). Any hold
resets the pursuit state, re-anchors the desired attitude to the current
attitude, and flushes `rotate(0,0,0)` so a stale body rate cannot survive into
the hold or out the other side. While a hold is engaged the sim owns the
attitude (ADR-035's slew), so the controller re-anchors every frame and issues
nothing.

**Touching the controls breaks a hold.** A look delta or an axis deflection while
a hold is engaged calls `setAttitudeMode('manual')` and the manual path runs in
the same frame. Pointer-lock deltas are exactly zero when the mouse is still and
keyboard axes are exactly 0 or ±1, so no deadzone is needed and no jitter can
break a hold spuriously.

**Convergence predicates.** ADR-035's handoff note warns that a quaternion
separation predicate can hang near inertial `−X̂`, where the zero-roll target
map's roll rate diverges as `2ω/ε`. This controller writes no "aligned?"
predicate at all — it does not wait for a hold to converge, and its own manual
pursuit error is measured against `qDesired`, which the controller itself
produced and which has no singularity. T0116, which does need such a predicate,
must gate on `dot(forward, targetDirection)` per that note. The controller's
one exposure is the re-anchor while a hold is active, which copies the published
quaternion and so simply inherits whatever the hold is doing, roll lag included.

**Stability assist.** Default on.

- **On**: the pursuit runs whether or not there is input, so releasing
  everything damps the residual rate and holds the attitude the player last
  pointed at. This *is* the "kill rotation on idle" behavior — a rate-only
  damper would stop the spin but let the nose sit wherever the spin left it.
- **Off**: with no input the controller does nothing at all — no pursuit, no
  flush — so the last commanded rate persists and the ship coasts in rotation
  like an unassisted spacecraft. Input frames behave identically to SAS-on, so
  releasing a sweep mid-flick leaves the ship rotating at the sweep rate.

`killRotation()` is an explicit one-shot in both states: zero the pursuit state,
re-anchor, flush `rotate(0,0,0)`.

### The unassisted coast is not warp-normalized, and that is the decision

With the assist off the controller issues nothing while idle, so the rate that
persists is the sim-frame body rate the simulation is holding. Warping up
therefore multiplies the *apparent* rotation: a ship coasting at the full
0.6 rad/s and warped to 50× visibly rotates at 30 rad/s. This is one keystroke
away from the v1 tumble in appearance, so it needs an explicit ruling rather
than silence.

**Ruled: keep it. Only *commanded input* is normalized; a rate already in the
state is angular momentum.** Plan §3.1 exists to stop a fixed *deflection* from
being multiplied by warp, and it does. A ship already spinning is a physical
fact, and time compression showing it faster is the same thing time compression
does to orbits, rotations and everything else in the game — normalizing it would
mean the ship's angular momentum silently changes when the player presses `=`,
which is worse than the appearance it fixes. This is written into
physics-spec §3.0.1 so the next reader finds it where the rule lives, and into
`docs/controls.md` so the player is told.

Three things keep it from being a trap, all tested:

- it requires deliberately turning the assist off (`T`), and turning it back on
  damps the coast immediately;
- `killRotation()` (`X`) stops it at any tier, and works even for a rate the
  controller never commanded;
- ADR-035 §6's `setWarp` clearing bounds the worst case: crossing
  `MANUAL_ATTITUDE_MAX_WARP` zeroes commanded rates, so the coast cannot survive
  into the tiers where it would be unrecoverable. The exposure is 100× at most.

What the coast branch *must* do, and originally did not, is keep the
controller's model honest across the tier change. `commandedRateRadS` is a
wall-frame quantity; a coast begun at 1× and warped to 50× left it stale by the
warp ratio, so the pursuit would have damped against a rate fifty times off when
the player took the controls back. `adoptCoastingRate` re-derives it every coast
frame as `lastIssuedSimRate × effectiveWarp`, clamped to `RATE_MAX` — the clamp
is correct rather than lossy, because a coast faster than the vehicle's
authority cannot be re-commanded at all, so the model saturates and the pursuit
spends full authority against it on re-engagement.

---

## 7. Bindings and settings compatibility

Seven actions are appended to `INPUT_ACTIONS`:

| Action | Default | |
|---|---|---|
| `attitudeNormal` | `Digit4` | hold normal |
| `attitudeAntinormal` | `Digit5` | hold anti-normal |
| `attitudeRadialOut` | `Digit6` | hold radial out |
| `attitudeRadialIn` | `Digit7` | hold radial in |
| `attitudeTarget` | `Digit8` | hold target |
| `killRotation` | `KeyX` | stop rotation now |
| `stabilityAssistToggle` | `KeyT` | toggle SAS |

That completes the eight holds (`attitudeManual`/`Prograde`/`Retrograde` already
existed on `Digit1`–`Digit3`) and gives SAS its toggle. None of the new codes
collides with the camera, focus or panel keys documented in `docs/controls.md`.

**This is a persisted-schema change and it must not break existing documents.**
`parseInputBindings` previously threw when an action was absent, and it is on the
critical path of `parseGameSettings`, which every `SaveEnvelope` v1/v2/v3 load
runs. Appending an action would therefore have made **every existing save
unloadable** and reset every player's key map.

The parser is changed to treat the registry as append-only:

- Unknown action keys still throw (a typo or a hand-edited document is still an
  error).
- Duplicate and reserved codes still throw.
- An action *missing* from the document is backfilled from the default table.
- If that default code is already taken by an explicit binding in the same
  document, the action is bound to the per-action sentinel `unbound.<action>`
  instead of throwing. Sentinels cannot equal any `KeyboardEvent.code` (which
  never contains a dot) and are rendered as "Unbound" by the settings panel; the
  player rebinds from there. The alternative — throwing — would make an
  unlucky-but-legal key map destroy a save.
- **The sentinel is checked for collisions like any other code.** A sentinel is
  a legal *explicit* binding, because a document a previous backfill wrote has
  to round-trip; so an untrusted document (save import, hand-edited JSON) can
  carry `unbound.<action>` on some other action. Emitting the bare sentinel
  regardless would produce two actions sharing one code — a document this parser
  accepts and the *next* load rejects, which is exactly the unloadable profile
  the backfill exists to prevent. `unboundCodeFor` probes `.1`, `.2`, … until
  free, bounded by `INPUT_ACTIONS.length`.

`src/game/settings.test.ts`'s "rejects duplicate, reserved, missing, and extra
bindings" case is the one existing expectation that changes: the *missing* arm
now asserts the backfill (and the collision arm asserts the sentinel). Duplicate,
reserved and extra are untouched. `tools/perf/browserSettings.mjs` still writes
the 13-action document and is deliberately left that way: it now exercises the
backfill in CI, and if the backfill ever regressed, the perf gate's pinned
`qualityLock: 'high'` would silently fall back to `'auto'` and the golden would
move — a loud failure in the right direction.

---

## 8. Files

| File | Change |
|---|---|
| `src/game/flight/flightController.ts` | new — plan §2 class; exports `ROTATION_RATE_RAD_S` |
| `src/game/flight/flightController.test.ts` | new |
| `src/game/flight/flightInputRouter.ts` | new — `InputFrame` → controller, plus the warp ladder |
| `src/game/flight/flightInputRouter.test.ts` | new |
| `src/game/input/inputCommandBridge.ts` | **deleted** |
| `src/game/input/inputCommandBridge.test.ts` | **deleted** (its behaviors are re-asserted against the router) |
| `src/game/settings.ts` | 7 new actions, defaults, append-safe `parseInputBindings` |
| `src/game/settings.test.ts` | backfill + sentinel cases |
| `src/ui/SessionSettingsPanel.tsx` | labels for the 7 actions; renders sentinels as "Unbound" |
| `src/ui/BurnLogPanel.test.tsx` | imports move; same assertion |
| `src/game/sessionController.test.ts` | imports move; same assertions |
| `tests/render/sessionSettingsPage.tsx` | harness drives the controller |
| `src/main.ts` | constructs the controller + router; restore hooks |
| `src/game/saveLoad.test.ts` | the v2-fixture migration now asserts the backfill |
| `tools/bench/simulationCoreBench.mjs` | three arms: sim-only, controller-only, full frame loop |
| `docs/controls.md`, `docs/architecture.md` | new bindings, new module map entry |
| `docs/bench/T0108-summary.md` (+ before/after JSON) | frame-loop evidence |

`ROTATION_RATE_RAD_S` **moves** to `flightController.ts` unchanged at `0.6`.
Three modules import it (`inputCommandBridge.test.ts`, `BurnLogPanel.test.tsx`,
and the bridge itself); the first is deleted, the second is repointed. It keeps
its repo name rather than the plan's `RATE_MAX` spelling so the move is a pure
relocation.

Layering: `game/flight/` imports `core/time.ts` (`WARP_LADDER`,
`MANUAL_ATTITUDE_MAX_WARP`) and `sim/` (`Commands`, `SimSnapshot`,
`AttitudeMode`, `VesselConfig`, `evaluateBodyRateQuaternionInto`). Nothing from
`render/` or `ui/`. No sim file is modified.

## 9. Allocation discipline

`update()` runs every frame and is covered by the CI heap gate. All controller
state is allocated in the constructor: four `Float64Array`s of length 4 or 3
(desired attitude, pursuit rate, axis rate, scratch) and scalars. `update()`
uses only indexed reads/writes, `TypedArray.set`, `fill(0)` and scalar math —
no `new`, no literals, no closures, no array helpers. The one sim function it
calls, `evaluateBodyRateQuaternionInto`, is allocation-free by contract and is
aliasing-safe (it reads its inputs into locals before writing), so
`qDesired ← qDesired ⊗ Δq` is done in place.

`bench:sim` grows from one arm to three: `SimulationCore.step` alone (the
historical `averageStepMs`, unchanged in shape), the router+controller alone
against a fixed snapshot (`averageControllerMs`), and the full frame loop
(`averageFlightStepMs`, which the retained-heap assertion covers).

The controller arm is measured on its own rather than by differencing two
`core.step` arms: the controller *steers*, so two arms that steer differently
fly different trajectories, and DP54's adaptive step count follows the
trajectory. Differencing reported a spurious 0.020 ms/frame before the arms were
separated — twenty times the real figure, and entirely orbital mechanics.

Measured: **0.55 µs per frame**, retained heap growth negative on every run. See
`docs/bench/T0108-summary.md`.

## 10. Verification

Unit (`flightController.test.ts`, `flightInputRouter.test.ts`):

- pursuit converges within 2 s at 1× for a 20° and a 30° look step, with the
  error monotone (overshoot exactly 0) up to a 180° step;
- the same look delta produces the same wall-frame apparent rate at 1× and 50×
  to 1e-12, including a saturating 180° step where the naive formula fails;
- manual rotation refused for `requestedWarp > 100` while `requestHold` still
  reaches `Commands`, including the governed `requested 1000 / effective 10`
  disagreement;
- full manual throttle commands exactly `alphaManualMaxMS2` of proper
  acceleration; `'cruise'` commands exactly `alphaMaxMS2`; the cap follows the
  session vessel, not `DEFAULT_VESSEL`;
- all eight holds reachable; input breaks a hold; SAS on damps to rest, SAS off
  coasts; `killRotation` stops both;
- flush discipline: idle frames issue nothing, a restored session keeps its
  rates, an axis release commands exactly zero;
- warp ladder walking and press-count semantics (inherited from the bridge's
  suite);
- an integration test against a real `SimulationCore` covering mouse-look at 1×
  and 50× end to end.

Repo gates: `lint`, `typecheck`, `format:check`, `test`, plus the browser
harnesses this can touch (`smoke`, `camera-controls`, `session-settings`,
`burn-log`, `tutorial`) and `test:perf-gates` for the heap gate.
`docs/bench/T0108-summary.md` carries the before/after evidence required for a
frame-loop change.

## 11. Corrections and findings after implementation

- **The controller cannot see `effectiveWarp` for the frame it is commanding.**
  It runs before `step()`, so it can only read the *published* tier. A warp-tier
  change is therefore one frame stale: the frame after `setWarp` is normalized by
  the old divisor. Measured on a real core over a 3 s route, the whole artefact
  is a 1.85e-5 rad (0.001°) difference in total angle flown between 1× and 50×.
  The steady-state claim is exact; the transition is not, and cannot be without
  giving the game layer a prediction of the governor's decision. The integration
  test settles the tier before measuring, and asserts steady state.
- **`averageFlightStepMs` is lower than `averageStepMs`**, which looks like a
  free lunch and is not: arm A holds prograde (a rails solve at every DP54
  stage) while the flight loop is in manual attitude (one body-rate quaternion).
  Different sim work, not different controller work.
- **A restored spin is invisible to the controller.** `SimSnapshot` carries no
  body rates, so after `resetAxes()` the controller believes the ship is at rest
  and the change-latch is what keeps it from writing that belief into the sim.
  The stability assist therefore does *not* damp a restored spin until the
  player touches something — `killRotation()` covers it explicitly, and a test
  pins that. Publishing body rates would be a `SimSnapshot` change and needs its
  own ADR; T0112 should decide, since a HUD rate readout would want the same
  field.
- **The v2-fixture save-migration test changed with the binding backfill**
  (`saveLoad.test.ts`, "migrates the committed v2 fixture to v3"). It asserted
  `migrated.settings` equalled the fixture's settings verbatim; it now asserts
  the fixture's 13 bindings survive and the 7 appended ones are backfilled to
  their defaults. That is the strongest available evidence that a real pre-T0108
  save still loads, which is why the case was updated rather than removed.
- `tools/perf/browserSettings.mjs` still writes a 13-action document and is
  deliberately left that way: it exercises the backfill on every perf-gate run,
  and a backfill regression would drop its pinned `qualityLock: 'high'` to
  `'auto'` and move the golden — a loud failure in the right direction.
