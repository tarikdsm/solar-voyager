# Cinematic camera and photo capture — design (T0125)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §5 and §8.
Contract: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2 (`CameraMode`,
`IMPLEMENTED_CAMERA_MODES`) and §5 T0125. Consumed by T0147 (album) and T0148 (menu backdrop).

## 1. What this task actually decides

The acceptance text fixes the *what* (orbit the ship with the existing controller, roll on Q/E,
FOV 20–90°, HUD hidden, slow idle drift, PNG blob without `preserveDrawingBuffer` through a
`CaptureSink`, five metadata fields). Four things were genuinely open, and each is below with the
alternative that was rejected: where the roll/FOV/capture keys live, how the frame reaches a PNG,
what the download sink does about naming and repeat captures, and what "no steady-state
allocation" means for a feature whose whole job is to allocate a 3 MB blob on demand.

## 2. The camera

### 2.1 One orbit controller, two modes

`CinematicCameraController` (`src/game/cinematicCameraController.ts`) does **not** own a camera. It
reads the pose the existing `OrbitCameraController` already computes — the same instance
observatory uses — and adds the three things orbiting does not give you: an up vector you can roll,
a field of view you can change, and an idle drift. `CameraDirector` points that controller at the
ship (`orbit.focusBody(shipFocusId)`) on entering cinematic, exactly as it already does on entering
chase, so the focus ring stays coherent across all three modes.

Consequence, deliberately accepted: **yaw, pitch and distance are shared state between cinematic
and observatory**, because they are one controller. Drifting for a minute in cinematic and then
cycling to observatory shows the drifted bearing. That is the direct price of the acceptance
criterion ("using the existing orbit controller"), it matches what chase↔observatory already does
with focus, and a second orbit controller would double the per-frame `recomputeCamera` work to
avoid a cosmetic surprise.

Rejected: a standalone cinematic controller with its own spherical state. It would have been ~120
lines of duplicated, separately-drifting orbit math, and the acceptance criterion says otherwise.

### 2.2 The up vector, and why cinematic does not inherit observatory's `+Y`

Observatory publishes a literal `(0, 1, 0)` up hint — v1's implicit three.js default, preserved
bit-for-bit by T0110. Cinematic cannot use it: `+Y` is neither perpendicular to the look direction
nor a stable roll reference, and at the (perfectly ordinary) bearings where the camera looks along
`±Y` it degenerates to the `lookAt` fudge factor. So cinematic derives its own orthonormal up from
the orbit controller's own spherical frame — the pitch tangent
`(-sinP·cosY, -sinP·sinY, cosP)`, which is exactly perpendicular to the look direction and points
at ecliptic north — and rotates it about the look axis by the roll angle (Rodrigues, reduced to
`u·cosθ + (L×u)·sinθ` since `L·u = 0` by construction).

At roll 0 the horizon is therefore the ecliptic, not v1's accidental framing. Entering cinematic
from observatory animates that difference as a roll, because the director slerps the up vector
through the cross-fade — a deliberate, visible, one-off "the camera settles" move rather than a cut.

### 2.3 FOV and drift numbers

- FOV: clamped to **[20°, 90°]** (acceptance), starts at the scene base (75°), changes at
  20 °/s while a key is held. Not persisted: a session-local framing choice, so no profile
  generation bump and no new migration tier.
- Idle drift: **0.02 rad/s** (1.15 °/s, one revolution in 5 min 14 s) in yaw only, after
  **2.5 s** with no camera input. Yaw only because a drifting pitch walks into the ±90° clamp and
  stops, which reads as a bug. Exported as `CINEMATIC_DRIFT_RATE_RAD_PER_SEC` for T0148's menu
  backdrop, which the plan says reuses this idle.
- Drift runs only while cinematic is the active mode; the pose stays live in every mode, so the
  director's "both cameras are always settled" invariant is unchanged.

### 2.4 Input routing: `CameraInputRouter`, not more hardcoded camera keys

Roll, FOV and capture are **rebindable input actions** (`cameraRollLeft` `KeyQ`, `cameraRollRight`
`KeyE`, `cameraFovNarrow` `Comma`, `cameraFovWiden` `Period`, `photoCapture` `KeyP`) consumed by
`game/cameraInputRouter.ts`, a sibling of `flightInputRouter` and `hudInputRouter`. This follows
T0112's precedent verbatim ("rebindable like every other action … rather than becoming two more
hardcoded camera-style keys") and buys two things the `ui/cameraInputController.ts` keydown switch
cannot: **held-key continuous roll** (a keydown ladder rolls in visible steps) and one focus policy.
`INPUT_ACTIONS` is append-safe by construction — `parseInputBindings` backfills a new action with
its default, or with an `unbound.` placeholder if a player already bound that code — so five new
actions need no profile version bump.

**The `E` collision, and the two halves it takes to resolve.** `KeyE` is the cinematic roll-right
key *and* `ui/cameraInputController.ts`'s hardcoded "focus Earth" shortcut, which listens on
`window`. Both halves have to be scoped, and the first draft of this task scoped only one:

1. *Inside* cinematic, `E` must roll and must **not** jump to Earth.
   `CameraDirector.directFocusEnabled` is false in cinematic, `SharedCameraControls` forwards it, and
   the controller skips `[`, `]`, `e` and `j` while it is false. Coherent rather than a patch: in
   cinematic every direct-focus key would *leave* the mode, so `O` is the way out.
2. *Outside* cinematic, `E` must still focus Earth. This is the half that was missing, and the
   failure was not subtle: `InputEngine.handleKeyDown` calls `preventDefault()` for **any** bound
   action, the shared focus policy (`blocksGameKey`) reads `defaultPrevented` as "a control already
   consumed this", and `CameraInputController` therefore returned before its own `case 'e'` — in
   every camera mode, for every player. Scoping `CameraDirector.rollCameraBy` scoped the *effect*
   while the *claim on the key* stayed global. `tools/tests/systemMapRegression.mjs` caught it.
   The fix is `InputEngineOptions.isActionActive`: the engine consults it before claiming a bound
   key, so a suppressed action produces no `preventDefault`, no edge and no held state, and the key
   falls through untouched. `CINEMATIC_ONLY_ACTIONS` (roll ×2, field of view ×2) is the set;
   `photoCapture` is deliberately not in it, because a photo is worth taking from any camera.

The general rule this leaves behind: **a mode-scoped binding must scope the claim, not just the
effect.** Any later task that binds a key already spoken for by the `ui/` camera keys (`[`, `]`,
`E`, `J`, `O`) inherits the same requirement.

Flight control is **not** suppressed in cinematic. The ship keeps flying, which is what makes
filming a burn possible, and `Z`/`C` (ship roll) never collided with `Q`/`E` anyway.

### 2.5 HUD hidden

The HUD is a DOM overlay, so it was never in a canvas capture to begin with — hiding it is for the
player's eye, not for the photo. `HudPresetStore` gains a `hudHidden` signal that `App` ORs into
the existing `SpaceHudSurfaces` `hidden` attribute (the mechanism the system map already uses), and
the frame loop assigns it from `cameraDirector.mode === 'cinematic'` every frame — a signal write
with an unchanged value is a no-op in `@preact/signals`, so this costs nothing and needs no change
detection of its own. The perf panel (F3, explicitly opened debug UI) and the pause dialog stay:
"HUD hidden" means the flight instrument surfaces, not every pixel of DOM.

## 3. Photo capture

### 3.1 The frame path

`preserveDrawingBuffer` stays `false` (`render/createRenderer.ts`, asserted by
`createRenderer.test.ts` and the renderer-policy gate). `render/frameCapture.ts` therefore
**re-renders the live scene through the same post pipeline** and calls `canvas.toBlob()` in the
*same task*, before the browser composites and discards the drawing buffer. The re-render is a full
pass of the pipeline the player is looking at, so the photo carries bloom, relativistic aberration
and ACES tone mapping exactly as the screen does.

Rejected: an offscreen `WebGLRenderTarget` + `readRenderTargetPixels`. It is the textbook answer and
it is wrong here on three counts — it creates a GPU resource during gameplay
(`performance-spec.md` §5 forbids exactly that), the composer's buffers are `HalfFloatType` so the
readback is a manual half-float decode, and the post chain's last pass writes to the screen, so an
offscreen target either bypasses tone mapping or needs a duplicate chain. Rejected also: capturing
without re-rendering by hooking the end of the frame loop; it works, but it makes capture reachable
only from inside the animation frame and silently breaks the day someone calls it from a button.

### 3.2 `CaptureSink` and `CaptureMeta`

```ts
interface CaptureSink { capture(blob: Blob, meta: CaptureMeta): Promise<void> }
interface CaptureMeta {
  readonly simTimeSec: number; readonly tauSec: number;
  readonly positionKm: ReadonlyVec3; readonly dominantBodyId: string | null;
  readonly gammaMax: number; readonly utcTimeMs: number; readonly sequence: number;
}
```

The signature the plan froze is untouched. `utcTimeMs` and `sequence` are additions T0147 gets for
free: the album needs a display timestamp and a stable identity, and both are known only here.

`positionKm` is the **ship's** heliocentric position, not the camera's: every other field in the
object is a ship fact, the album's "location" means where the flight was, and at cinematic ranges
(tens of metres) the two are the same point anyway.

`gammaMax` is not in `SimSnapshot` — γ is instantaneous there. `PhotoCaptureController.observe()`
tracks the peak over the session at the existing 10 Hz HUD tick and resets on session replacement.
It is therefore honestly "peak γ observed since this session loaded", not "peak γ of this save".
T0146 owns real flight statistics; when it lands it should feed this from its own store, and the
field's meaning improves without the interface moving.

### 3.3 The download sink: naming and repeat captures

**Decision: one file per capture, written immediately, named
`solar-voyager-<UTC>-<body>-<3-digit session sequence>.png`; a capture requested while another is
still encoding is dropped, not queued.**

Why, since T0147 inherits it:

1. **Immediate, not batched.** A browser download is the only durable channel that exists before
   T0147. Holding blobs in memory to offer "download all" later would lose every photo on reload
   while looking like it saved them — a worse failure than an extra file in the downloads folder.
   A ZIP would need either a runtime dependency (forbidden without an ADR) or a hand-rolled ZIP
   writer, which is a lot of code for a stopgap that T0147 deletes.
2. **The name carries the shot, and cannot collide.** UTC comes from `snapshot.utcTimeMs`
   (mission time, so the files sort into flight order — wall-clock time says nothing about a
   voyage), the dominant body says where you were, and a per-session sequence makes repeat captures
   distinct even when the game is paused and mission time does not move. Without the sequence,
   two shots of one paused frame collide and the browser silently appends `(1)` — an unmanaged name
   is a lost photo.
3. **Drop, don't queue.** Holding the key down must not enqueue forty encodes. One in flight at a
   time, and the drop is counted in the diagnostic rather than swallowed.

**T0147 must keep this sink, not replace it.** Its own acceptance already requires a
"private mode → download-only fallback with notice", and that fallback *is* this class: the sink is
deliberately independent of the album, holds no state but a counter, and needs only the three DOM
calls its port declares.

The DOM contact (`URL.createObjectURL` / `revokeObjectURL` / anchor click) is behind
`DownloadCapturePort`, supplied by `bootstrap/composition.ts`, so `game/` stays DOM-free and the
sink is unit-testable without a browser. The object URL is revoked in a `finally`.

## 4. Allocation and the heap gate

Steady state is unchanged: the camera path writes into preallocated scratch, the router reads
scalars, and the HUD-hidden write is a signal assignment. `npm run test:perf-gates` measures a 30 s
window on a page that never captures, so the gate never sees the capture window.

The capture window is **explicitly excluded** and documented in `docs/performance-spec.md` §5.
One capture transiently allocates: one PNG `Blob` (order 1–4 MB at 1280×720), one object URL, one
`CaptureMeta` with its position triple, one filename string, and the promise chain. All are
unreachable once the sink resolves and the URL is revoked. Two things follow for whoever measures
next: a heap window containing a capture is not a steady-state measurement, and the extra full
render costs one frame's worth of GPU time at the moment of capture — a deliberate, user-initiated
spike, not a per-frame regression.

## 5. Landmines found in existing code

- `ui/cameraInputController.ts` reads `event.key.toLowerCase()`, not `event.code`, for its
  hardcoded shortcuts. `KeyE` and the letter `e` are therefore the same key to it whatever the
  player rebinds, which is why the fix is a mode gate rather than a rebind.
- `CameraDirector.setMode` sends the orbit camera to `lastObservatoryFocusId` for *any* non-chase
  mode ("never hand the player a 39 m observatory view of their own hull"). Cinematic wants exactly
  that 39 m view, so the condition is now explicitly "observatory only" — a one-word change that
  would otherwise have silently pointed the cinematic camera at Earth.
- `OrbitCameraController.focusBody` runs a 1.5 s transfer with a context pull-back; entering
  cinematic therefore animates twice (the orbit transfer and the director cross-fade). They compose
  fine, but a test that asserts the final pose must run both to completion.
- The state-vector widget renders into the canvas, not the DOM, so it *would* appear in a photo.
  It is unmounted in Clean/Pilot presets and its viewport collapses to zero when the HUD is hidden,
  so cinematic captures are clean; a future preset that keeps it visible would put a triad in
  photos.
