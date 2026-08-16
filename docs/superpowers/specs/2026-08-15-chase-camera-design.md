# T0110 — Chase camera and `CameraDirector` v0 (design)

Task: `T0110` (plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §T0110,
spec `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §5).
Branch `task/T0110-chase-camera`. Written before implementation, per the task
brief.

## 0. What this task is for

v1's camera could only orbit a **celestial body**. T0109 put the ship on screen
and added it to the focus ring; T0108 made it fly. Both left the camera bolted to
a planet, so coasting away from Earth looked like watching the ship leave, not
like flying it. This task puts the camera behind the ship and makes that the
default view — the last piece of "you are flying a spacecraft" in V2M1.

## 1. Decisions that shape everything else

### 1.1 Chase is the **default** camera mode

The alternative — observatory by default, chase behind a key press — would keep
every existing browser gate green with no golden movement, and was rejected.
The task exists to make the game third-person; a third-person camera you have to
opt into every session is not that. T0109's own bench summary already wrote the
consequence down as this task's job:

> "a visible ship costs 24 draw calls and 5,538 triangles. That is the number
> T0110 will have to re-baseline the golden against, because a chase camera keeps
> the ship resolved every frame (10 + 24 = 34 draw calls…)"

Consequences accepted and handled in §7: the perf-gate workload golden moves in
its own commit, and the two production harness phases that assumed "camera starts
on Earth, ship is sub-pixel" are rewritten to assert the new arrangement without
losing the coverage they had.

### 1.2 `game/` stays pure; three.js lives in a thin adapter

`OrbitCameraController` is float64, allocation-free and knows nothing about
three.js; `main.ts` and `createEpochWorld.ts` apply its output to the
`PerspectiveCamera`. The brief requires the same shape here, and ESLint enforces
it (`src/game` may not import `src/render`).

So:

| Module                              | Layer    | Responsibility                                              |
| ----------------------------------- | -------- | ----------------------------------------------------------- |
| `game/cameraTransition.ts`          | `game`   | shared blend primitives (smootherstep, log distance, slerp)  |
| `game/chaseCameraController.ts`     | `game`   | the spring arm, FOV widening, shake — pure numeric           |
| `game/cameraDirector.ts`            | `game`   | modes, cross-fade, focus routing — pure numeric              |
| `render/cameraRig.ts`               | `render` | the whole three.js adapter: pose → `PerspectiveCamera`       |

`SHIP_LENGTH_M` and `SHIP_ASSET_ID` live in `render/shipVisual.ts`, so they are
**injected** into the `game/` controllers by `createEpochWorld` rather than
imported. This is the same reason `VesselConfig` is injected into
`FlightController`.

### 1.3 One pose object, one camera owner

The director owns a single mutable `CameraPose`:

```ts
interface CameraPose {
  readonly positionKm: ReadonlyVec3;    // heliocentric ecliptic, float64
  readonly lookDirection: ReadonlyVec3; // unit, camera → subject
  readonly upDirection: ReadonlyVec3;   // unit, sets roll
  readonly fovDeg: number;              // includes the throttle widening
}
```

`EpochWorld.cameraPositionKm` becomes `director.pose.positionKm`, so every
existing consumer (`spaceScene.updateCameraRelative`, `visualSystem.update`,
`shipVisual.update`, the trajectory overlay) keeps working unchanged and there
is still exactly one float64 → render-space boundary.

`upDirection` is new. v1 only had a look direction, because an orbit camera has
no roll worth expressing. A chase camera does: the whole point is that rolling
the ship rolls the world.

## 2. `ChaseCameraController` — the spring arm

### 2.1 Frames

ADR-025 §4: the body frame is `+X` nose, `+Z` up, `+Y` lateral (left, for a
right-handed frame with `X` forward and `Z` up). `writeForwardFromQuaternionInto`
already extracts `+X`; this task adds `writeUpFromQuaternionInto` alongside it in
`sim/ship/attitude.ts` (a pure column-extract of the same rotation matrix — no
snapshot or formula change, so no ADR).

### 2.2 Attitude follow (120 ms lag)

A first-order lag on the **quaternion**, not on the basis vectors, so the arm
frame stays orthonormal by construction:

```
q_arm ← slerp(q_arm, q_ship, 1 − exp(−dt / τ_att)),  τ_att = 0.120 s
```

A first-order lag with time constant τ trails a constant-rate rotation by exactly
τ seconds in steady state, which is the plain reading of "attitude-follow with
120 ms lag". `slerp` is done longhand into preallocated scratch, shortest-arc
(sign-corrected), with an `nlerp` fallback inside 1e-6 of parallel.

### 2.3 Desired arm offset

Literal spec formula at zero player offset:

```
offset_desired = (−F + 0.35·U) · d        |offset| = d·√(1 + 0.35²) = 1.0595 d
```

`d ∈ [2, 50] ship lengths` on the wheel, default **6** (156.7 m; the 26.12 m hull
then subtends ≈ 91 px at 720 p / 75° — comfortably resolved, not filling the
frame). Wheel law reuses the orbit camera's `exp(delta · 0.0015)` so zoom feels
the same in both modes.

Pointer drag in chase mode is **not** dead: it applies a persistent azimuth /
elevation offset to the arm *within the ship frame*, so you can look around your
own ship and the view still follows the attitude. Zero offset reproduces the spec
formula exactly (asserted in a unit test). Elevation clamps to ±85°, and both
offsets reset when the mode changes.

### 2.4 The spring: why the offset and not the position

Springing the **world position** toward "where the camera should be" is wrong: a
critically damped tracker following a ramp has steady-state error `2v/ω`, and at
LEO orbital speed (7.67 km/s) with ω = 8 that is 1.9 km of lag on a 157 m arm.
The ship would leave the frame permanently.

So the spring runs on the **arm offset** (camera − ship). Ship translation is
followed rigidly and exactly; only re-aiming and zooming are damped. This is the
standard spring-arm construction and it is what makes the "zero overshoot"
criterion meaningful.

Integration is the **exact** critically damped solution over the frame, not an
Euler step, so there is no discretisation overshoot at any `dt`:

```
Δ0 = x − target,  B = v + ω·Δ0,  e = exp(−ω·dt)
x ← target + (Δ0 + B·dt)·e
v ← (B − ω·(Δ0 + B·dt))·e
```

`(Δ0 + B·dt)` changes sign only at `t = −Δ0/B`, which is negative whenever `Δ0`
and `B` share a sign — always true from rest (`B = ω·Δ0`). Hence **zero overshoot
from rest, analytically**, and the unit test asserts it componentwise over a
1.2 s step plus a settle-time bound.

`ω = 8 rad/s`. Chosen from the settling requirement, not by feel: for a
critically damped step, `|Δ|/|Δ0| = (1 + ωt)e^{−ωt}`, so 2 % settling is at
`ωt ≈ 5.834` ⇒ `t = 0.729 s < 0.8 s`, with ~9 % margin. Time constant 125 ms,
which sits just behind the 120 ms attitude lag — the arm reacts about as fast as
the frame it is attached to, which is what keeps the two from beating against
each other.

### 2.5 FOV widening

```
fovOffsetTarget = 8° · throttle01      (0 when the setting is off)
fovOffset ← fovOffset + (target − fovOffset)·(1 − exp(−dt/τ_fov))
τ_fov = 0.5 / ln(50) = 0.12783 s
```

"Smoothed over 0.5 s" is read as *the transition takes half a second*: τ is set
so a step reaches 98 % in exactly 0.5 s. Tested at both ends (≥ 98 % at 0.5 s,
< 60 % at 0.1 s).

### 2.6 Shake

```
A = 0.15° · clamp(|α| / (5 g), 0, 1)
pitch = A·sin(2π·8.5·t)·cos(2π·5.3·t)
yaw   = A·sin(2π·8.5·t)·sin(2π·5.3·t)
```

The product form makes `hypot(pitch, yaw) = A·|sin(2π·8.5·t)| ≤ A` **exactly**, so
the bound is on the true angular deviation rather than on each axis separately
(two independent ±A sinusoids would peak at A√2 = 0.21°). Applied to the look and
up directions by small-angle rotation about the camera right/up axes and
renormalising; at 0.15° the small-angle error is 3.4e-6 rad. Two incommensurate
frequencies (8.5 Hz envelope, 5.3 Hz direction) so it never repeats visibly, and
it is a pure function of accumulated wall time — no RNG, no allocation.

0.15° is ~1.4 px at 720 p / 75°. "Default subtle" is not a euphemism.

### 2.7 Surface clamp (the T0111 landmine)

There is no terrain, but there is now collision, and on contact the sim freezes
with the ship *on* a surface — a 157 m arm behind a nose-down ship is
underground. Every frame the chase camera clamps its output position against the
relevant body (the impacted one while frozen, otherwise the dominant one) to

```
r ≥ R + max(2 m, R·1e-6)
```

which is exactly the existing `orbitCameraController` minimum-distance rule,
reused rather than reinvented. The clamp is applied to the **output**, not to the
spring state, so the arm behaves like a real spring arm colliding with the
ground: it slides along the surface while pressed, and leaves smoothly when the
ship rises. The look direction is computed *after* the clamp, from the actual
camera position to the actual ship position, so the ship stays centred even while
the arm is pinned.

While frozen the shake phase and the attitude lag stop advancing: a dead ship
should not vibrate.

## 3. `CameraDirector`

Signature is fixed by the plan's §2 shared-contract block:

```ts
export type CameraMode = 'chase' | 'cockpit' | 'cinematic' | 'observatory';
export class CameraDirector {
  setMode(mode: CameraMode): void; cycle(): void;
  readonly mode: CameraMode;
  update(wallDtSec: number, snapshot: SimSnapshot): void;
}
```

`cockpit` and `cinematic` belong to T0124/T0125. `setMode` **throws** a
`RangeError` naming the owning task rather than silently no-opping, so a future
caller finds out at the call site. `cycle()` steps the two implemented modes.

### 3.1 Mode cross-fade — no cuts

Both controllers run every frame regardless of mode, so the incoming one is
already settled when a switch happens. The switch itself is a 1.5 s blend (the
same `DEFAULT_TRANSFER_DURATION_SEC` the orbit camera uses) built from the
**existing focus-transition machinery**, lifted into `game/cameraTransition.ts`
so there is one implementation rather than two:

- **anchor** (ship / orbit focus point): smootherstep lerp
- **arm distance**: logarithmic interpolation — mandatory here, the two distances
  differ by up to six orders of magnitude (157 m chase vs 210,000 km at Jupiter)
- **arm direction, look, up**: unit-vector slerp
- **fov**: linear lerp

The orbit camera's extra `travelDistance · 0.15 · sin²(πt)` context pull-back is
deliberately **not** applied at director level: with anchors up to 4 AU apart it
would add a hundred million kilometres of swing. Log interpolation of the two
endpoint distances already produces the pull-out/push-in read. Noted here because
it is a conscious deviation from "use the existing machinery".

### 3.2 Focus routing, and the two kinds of "focus"

Camera focus and navigation target can now disagree (T0109 made this possible;
chase makes it the normal case). Two distinct entry points, and this is the rule:

**Only the camera input port changes the camera mode.**

| Caller                                       | Method                     | Effect                                          |
| -------------------------------------------- | -------------------------- | ----------------------------------------------- |
| `SharedCameraControls` (drag/wheel/keys)      | `focusBody`, `cycleFocus`  | may change mode; ship ⇒ chase, body ⇒ observatory |
| `Commands.setTarget`, system-map focus change | `focusObservatoryBody`     | re-aims the observatory camera, mode unchanged   |

So selecting Jupiter as a navigation target no longer yanks you out of the chase
camera, and the observatory camera is pre-aimed for when you switch to it.

The orbit controller's ring index is kept synchronised with the director's mode
(chase ⇒ ring on `ship`), so `[` / `]` still walk one ring; stepping onto the ship
enters chase and stepping off it returns to observatory. The director remembers
the last non-ship observatory focus (default `earth`) so `cycle()` out of chase
never lands you on a 39 m orbit view of your own hull.

### 3.3 The stale focus label (brief handoff 2)

`main.ts`'s `setTarget` recentred the camera without writing
`#camera-focus-label`. Latent in T0109, reachable now. Fixed by making the label
a function of `director.focusId` and writing it from **every** site that can move
the camera focus: `setTarget`, the system-map focus change, and the camera input
controller. `focusId` reports `ship` in chase and the orbit focus in observatory,
so the label always names what the camera is actually looking at.

## 4. Settings — profile document v4

Acceptance requires both effects to be switchable off. The profile document is
strictly parsed with exact-key checking, so a new field is a new version. This
follows the documented precedent in `settings.ts` exactly: a **new storage key**
`solar-voyager.settings.v4`, a `migrateProfileV3ToV4` that attaches defaults, and
a fourth read tier (v4 → v3 → v2 → v1) that migrates forward and writes to the
new key. A shared key would let a rolled-back build destroy a newer document.

```ts
interface CameraSettings { readonly fovWidening: boolean; readonly shake: boolean }
// defaults: both true — the effects are subtle by design, not off by default
```

Camera preferences are **profile-only**, like tutorial progress and gamepad
calibration: they are not projected into `GameSettingsV1` (the save-embedded DTO,
which stays at version 1 forever) and survive an import.

## 5. Restore-ring allowlist inversion (brief handoff 5, deferred from T0111)

`replacementInvalidatesRestorePoints` allowlists the origins that **invalidate**
the ring, so an origin added later defaults to *keeping* it — the dangerous
direction, because a future timeline-changing origin would silently inherit
stale restore points from another mission. Inverted to allowlist the two origins
that are known safe (`restore`, `respawn`); everything else invalidates. Fails
closed. `import`'s ring clearing was only exercised through the composed
`collisionRecovery` test, so it gets a direct case.

## 6. Frame loop and allocation

Per frame, in order (`main.ts`):

1. `shipVisual.writeState(...)` — already writes the ship triple **before** the
   camera reads it (T0109 handoff 1)
2. `cameraDirector.update(deltaSec, snapshot)` — replaces `cameraController.update`
3. `cameraRig.apply(director.pose, camera)` — `up.set`, `lookAt`, `fov`,
   `updateProjectionMatrix` only when the fov actually moved

Allocation budget: zero. All vectors are preallocated `Float64Array`/`{x,y,z}`
scratch on the controllers; `Vector3.set` / `Object3D.lookAt` /
`PerspectiveCamera.updateProjectionMatrix` are all in-place in three.js 0.185.
The orbit controller still updates every frame in chase mode (it is ~20 flops and
keeps the cross-fade source live).

## 7. Gates this moves, and what it costs

| Gate                        | Expected effect                                                          |
| --------------------------- | ------------------------------------------------------------------------ |
| `test:perf-gates` workload  | **re-baselined** — the ship is now resolved: 10 → ~34 calls, +5,538 tris  |
| `data/initial-path.json`    | **unchanged** — see below                                                 |
| `test:startup`              | must still pass unchanged, proven by running it                           |
| `test:camera-controls`      | extended with a chase-follow phase; Jupiter phase now goes via observatory |
| `test:ship-visual`          | production phase rewritten for chase-by-default, coverage preserved       |

**Why `ship.glb` does not go on the initial path (brief handoff 3).** The
critical path is the set of files that must arrive before *first playable*, and
`test:startup` measures exactly that window — it reaches `ready` **before** the
space phase exists (the harness clicks "New Game" afterwards). Ship lazy loading
is only enabled at space-phase activation, so `ship.glb` is fetched after the
5,000 ms budget window closes and never appears in `requestedCriticalFiles`.
Adding it to `data/initial-path.json` would move a 2 MB-class asset *into* the
budget it is currently outside of, making startup strictly slower to save one
frame of point-sprite. So: **let chase resolve late.** The point representation
already covers the gap and `ShipVisual`'s existing cross-fade makes the handover
invisible. The first-frame program-count assertion is also safe: the model fetch
is kicked off *by* frame 1 and resolves asynchronously, so nothing compiles
within it. Both claims are proven by running `test:startup`, not asserted.

## 8. Tests

Unit (`vitest`), all in `src/game`:

- `cameraTransition.test.ts` — smootherstep endpoints/monotonicity, log
  interpolation, slerp against a reference implementation, antipodal fallback
- `chaseCameraController.test.ts` — the exact spec formula at zero offset; **zero
  overshoot** componentwise on a step from rest; settle < 0.8 s; distance clamp to
  [2, 50] ship lengths; 120 ms lag measured against `1 − e^{−1}`; FOV curve at
  0.1 s / 0.5 s; shake amplitude ≤ 0.15° at ≥ 5 g and 0 below threshold and 0 when
  disabled; surface clamp; allocation-free steady state
- `cameraDirector.test.ts` — mode cycling, cross-fade continuity (no step larger
  than a fraction of total travel), focus routing table from §3.2, `setMode`
  throwing for unimplemented modes

Browser (`tools/tests/cameraControlsRegression.mjs`, extended):

- a **chase-follow phase** on the shipped game that warps time forward and proves
  the camera position tracks the ship (arm length stays within the commanded
  band, ship stays centred, ship stays resolved) — the "does it actually follow"
  case the brief requires
- a **mode-transition phase** asserting no discontinuous camera step
- `--capture` writes the third-person proof shot to `docs/bench/`

## 9. Deliberately out of scope

- **No `SimSnapshot` body rates** (T0112 owns them, and they need an ADR).
- No cockpit or cinematic mode (T0124/T0125).
- No plume, no exposure change, no new post pass.
- The relativistic post pass keeps taking the **ship's** velocity as the observer;
  this task only makes that finally coherent with where the camera is. Verified,
  not changed.
