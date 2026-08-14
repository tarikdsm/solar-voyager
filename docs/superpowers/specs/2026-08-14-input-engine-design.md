# Input Engine Design (T0105)

- **Date:** 2026-08-14
- **Task:** T0105 — New input engine: pointer lock, analog axes, UI-focus policy
- **Milestone:** V2M1
- **Release spec:** `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.2, §7
- **Plan:** `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2, §3.1, T0105

## Scope

Replace v1's `KeyboardCommandMapper` with a real input engine that later v2 tasks
poll once per frame:

- a stable, allocation-free `InputFrame` contract (T0106 gamepad, T0108
  `FlightController`, T0110 `CameraDirector` all consume it);
- pointer-lock mouse-look producing wall-frame radian deltas;
- an analog throttle axis in `[0, 1]` with a keyboard ramp, replacing the
  ten-step ratchet;
- one UI-focus policy shared by every keyboard consumer in the codebase;
- the two v1 defects that make flying impossible, each with a regression test.

Out of scope (owned elsewhere): gamepad axes and the rebinding-UI extension
(T0106), wall-time rate normalization and the manual-attitude warp lock
(T0107/T0108, ADR-035), the chase camera (T0110), the pause menu itself (T0112).

## The two v1 defects

### Defect 1 — focused buttons kill flight input

`src/game/inputMapping.ts:49` classified `tagName === 'BUTTON'` as an editable
target, so `handleKeyDown` returned early whenever any HUD button had focus.
Clicking the burn-log toggle, a warp button, or the map toggle made W/A/S/D/R/F
dead until the player clicked the canvas again. `tools/tests/burnLogRegression.mjs`
had to `blur()` the active element between two key presses to work around it.

**New policy:** only `INPUT`, `TEXTAREA`, `SELECT` and `contenteditable` subtrees
block flight keys. Buttons do not.

### Defect 2 — Shift disables every flight control

`src/game/inputMapping.ts:83` bailed on `event.shiftKey`, so holding Shift (the
camera-orbit chord) disabled all flight input — the player could not steer and
move the camera at the same time.

**New policy:** Shift is a normal modifier. Only `Ctrl`, `Alt` and `Meta` (real
browser/OS chords) suppress flight keys.

### Why the freeze felt random

The policy existed in **three** independently written copies with three
different rules:

| Site | INPUT/SELECT/TEXTAREA | contenteditable | BUTTON | ancestors |
|---|---|---|---|---|
| `game/inputMapping.ts` | blocks | blocks | **blocks** | no |
| `ui/cameraInputController.ts` | blocks | blocks | passes | `closest()` |
| `ui/SystemMapPanel.tsx` | blocks | blocks | passes | `matches()` + `closest()` |

Identical-looking focus states therefore produced different results per
subsystem. T0105 collapses these into one exported predicate.

## Considered approaches

### 1. Poll-per-frame engine + stable frame object — selected

The engine accumulates raw events into preallocated state and publishes one
mutable `InputFrame` that is reused forever. Consumers read it once per frame.
This preserves v1's deliberate flush-once-per-frame shape (see "Flush shape"
below), keeps the frame path allocation-free, and gives T0106/T0108 a single
seam to extend with gamepad sources.

### 2. Event-driven callbacks straight into `Commands` — rejected

This is what v1 did. It couples every input source to the sim command facade,
makes rate/assist orchestration impossible (T0108 needs to filter and normalize
intent before it reaches the sim), and forces every consumer to reimplement
edge/level bookkeeping.

### 3. Signals-based reactive input — rejected

The HUD signal pattern is right for 10–20 Hz DOM updates, not for a 60 Hz
control path: subscription dispatch allocates and the ordering guarantees we
need (drain look deltas exactly once per frame) are weaker than an explicit
poll.

## The contract

```ts
// src/game/input/inputEngine.ts
export interface InputAxes {
  readonly pitch: number;    // [-1, 1], +1 = nose up
  readonly yaw: number;      // [-1, 1], +1 = nose right
  readonly roll: number;     // [-1, 1], +1 = roll right
  readonly throttle: number; // [0, 1], absolute analog lever position
}

export interface InputFrame {
  readonly lookYawRad: number;   // wall-frame delta since the previous poll, +right
  readonly lookPitchRad: number; // wall-frame delta since the previous poll, +up
  readonly axes: InputAxes;
  pressed(action: InputAction): boolean;   // edge: went down since the previous poll
  pressCount(action: InputAction): number; // number of such presses (saturating at 255)
  held(action: InputAction): boolean;      // level: down right now
}

export class InputEngine {
  constructor(options: InputEngineOptions);
  poll(wallDtSec: number): InputFrame;     // allocation-free; returns the same object forever
  applyBindings(bindings: InputBindings): void;
  releaseHeldKeys(): void;
  setThrottleAxis(value01: number): void;
  requestPointerLock(): void;
  releasePointerLock(): void;
  get pointerLocked(): boolean;
  dispose(): void;
}
```

`pressed()` is **edge-triggered**, matching v1: the mapper acted on `keydown`
with `repeat` filtered, so discrete actions (attitude modes, warp rungs) fired
once per physical press. An edge is latched when the key goes down and stays
readable for exactly the one frame that follows, so a press that happens between
two polls is never lost. `held()` is the level query, added for consumers that
want "is this down" without re-deriving it. `pressCount()` exists so two taps
between two polls still step warp twice (v1 processed each `keydown`
immediately; a plain boolean would silently drop the second).

The returned object is the engine's own preallocated frame — callers must read
it before the next `poll()` and must not retain it across frames.

## Modules

### `src/game/input/bindings.ts`

The binding registry and the UI-focus policy — the two things every keyboard
consumer in the codebase needs and nothing else.

- `INPUT_ACTIONS` / `InputAction` / `InputBindings` re-exported from
  `game/settings.ts`, which stays the single source of truth for the persisted
  schema.
- `actionIndex(action)` — dense index into preallocated `Uint8Array` state.
- `BindingTable` — `KeyboardEvent.code → InputAction` lookup rebuilt only when
  settings change; rejects duplicate codes exactly as v1's `buildCodeMap` did.
- `isEditableTarget(target)` — the unified predicate. It is the union of the
  three v1 copies **minus** `BUTTON`: direct `isContentEditable`, `tagName` in
  `{INPUT, SELECT, TEXTAREA}`, `matches('input, select, textarea')`,
  `closest('input, select, textarea')`, and an inherited
  `closest('[contenteditable]')` whose attribute is `""` or `"true"`. Each guard
  is feature-detected, so structural test doubles keep working.
- `isActivationKeyForTarget(code, target)` — `Space`/`Enter`/`NumpadEnter` on an
  `A`, `BUTTON`, `SUMMARY`, or an ARIA widget role (`button`, `checkbox`, `link`,
  `menuitem`, `option`, `radio`, `switch`, `tab`).
- `blocksGameKey(event)` — `defaultPrevented || isEditableTarget(target) ||
  isActivationKeyForTarget(code, target)`.

A key belongs to the UI rather than the ship in exactly three cases. Clauses 2
and 3 are what make "buttons do not block" safe:

1. **The player is typing.** `isEditableTarget`.
2. **A control consumed the key explicitly.** `defaultPrevented`. The
   load-bearing case is the burn-log row (`ui/BurnLogPanel.tsx:114`), which
   `preventDefault()`s `ArrowUp`/`ArrowDown`/`Home`/`End` in the target phase,
   before the engine's window-level listener — so list navigation keeps working
   even when the player has bound flight actions to those codes, and nothing
   double-fires. (The rebind capture button at
   `ui/SessionSettingsPanel.tsx:263-268` also calls `preventDefault()`, but it
   additionally calls `stopPropagation()` and Preact attaches the handler on the
   element, so the window listener never sees that event at all. It is not what
   this clause is for.)
3. **The key natively activates the focused control.**
   `isActivationKeyForTarget`. The browser's default action *is* the activation
   and it never sets `defaultPrevented`, so clause 2 cannot see it. Without this,
   binding a flight action to `Space` would let the window listener
   `preventDefault()` every HUD `<button>` and the settings `<summary>` into
   silence; bind `Enter` too and keyboard activation is gone entirely — a
   regression against `docs/accessibility.md` that v1 avoided only because it
   blocked `BUTTON` outright.

`Space` and `Enter` are deliberately **not** added to `RESERVED_CODES`. That
would tighten `parseInputBindings`, and a profile or save envelope that already
binds them (legal and fully functional under v1, where `BUTTON` blocked) would
then fail validation: `SettingsRepository.load()` fails closed and discards the
entire profile including quality lock and tutorial progress, and
`SaveRepository.load()` would reject a previously valid save as invalid. There is
no migration hook that could rewrite the binding first — `migrateLegacySettings`
runs `parseGameSettings` on the v1 document and would throw on the same code.
Losing a player's settings and save is a far worse regression than the one being
fixed, so the fix lives in the engine, where it costs nothing.

### `src/game/input/inputEngine.ts`

Owns raw event subscription and per-frame state. DOM types appear only as
structural ports (`InputKeyboardTarget`, `PointerLockSurface`) — `src/game/`
keeps its no-globals discipline and the browser adapters live in `main.ts`, the
same pattern `settings.ts`/`KeyValueStorage` already uses.

Keyboard handling, in order:

```
repeat                      → ignore (OS auto-repeat is not a new press)
ctrlKey || altKey || metaKey→ ignore (real browser/OS chords)  [Shift is NOT here]
blocksGameKey(event)        → ignore (typing, consumed, or a native activation key)
Escape                      → raise the pause intent, release pointer lock, return
bindings.resolve(code)      → set held + latch edge, preventDefault()
```

`keyup` clears the held bit unconditionally (so a key released over a focused
button cannot stick — v1 already did this and it must survive). A `blur` on the
keyboard target calls `releaseHeldKeys()`, which clears held bits **and** queued
press edges: an edge latched just before the blur would otherwise fire on the
next poll and steal a warp rung or an attitude mode.

### `src/game/input/inputCommandBridge.ts` (interim)

`InputFrame → Commands` for the current build. **T0108's `FlightController`
supersedes this file.** It exists because T0105 removes the only thing that fed
the sim and every merged PR must leave the deployed game playable. It is a
separate, unit-tested module rather than inline `main.ts` code because the
session-settings browser harness drives the same path.

It reproduces v1's semantics exactly, including the flush shape:

- **Rotation is change-latched.** `commands.rotate()` is issued only when the
  axis triple differs from the one the bridge last issued. This is not an
  optimization: `rotate()` overwrites the sim's rotation rates, so an
  unconditional per-frame flush would erase rates restored from a save. v1
  encoded this as `axesDirty`; `resetAxes()` is the equivalent hook for the
  restore path (`releaseAxes()` is the same reset plus an explicit
  `rotate(0, 0, 0)`).
- **Throttle is compared against the snapshot.** `commands.setThrottle()` is
  issued when the frame's lever position differs from `snapshot.throttle`. This
  is deliberate: `SimulationCommands.setThrottle` silently forces 0 while
  `requestedWarp > MAX_THRUST_WARP`, so a change-latched throttle would leave
  the engine and the sim permanently disagreed. With snapshot comparison the
  lever position is honored again as soon as warp drops back below the ceiling,
  and the redundant call is a no-op (the sim early-returns on an equal value).
- Warp steps consume `pressCount()` against `snapshot.requestedWarp` and walk
  `WARP_LADDER`; attitude actions call `setAttitudeMode` on the edge.
- `ROTATION_RATE_RAD_S = 0.6` moves here unchanged. Wall-time normalization
  (plan §3.1) is **not** applied yet — it lands with ADR-035 in T0107/T0108.

## Analog throttle

Range `[0, 1]`, continuous, owned by the engine. A press is measured
**cumulatively from where it started**: the distance swept by a press that has
been held for `heldSec` is

```
sweep = max(THROTTLE_TAP_STEP, THROTTLE_RAMP_PER_SEC · heldSec)
lever = clamp01(origin ± sweep)
```

with `origin` re-anchored whenever the held direction changes, and
`THROTTLE_RAMP_PER_SEC = 1 / THROTTLE_FULL_SWEEP_SEC = 1 / 1.5 s`. This makes the
two documented guarantees exact and mutually consistent:

- **any press moves the lever at least `THROTTLE_TAP_STEP = 0.1`** — including a
  press and release that both land between two polls, which has zero held
  duration and would otherwise be a silent no-op (this is exactly how scripted
  input and very fast presses arrive);
- **a hold from rest reaches full travel at exactly 1.5 s.**

Two rejected alternatives, both of which the unit tests now pin against:
*adding* the tap step to the ramp made a hold from rest finish in 1.35 s, which
contradicted `docs/controls.md`; applying the tap step only to sub-frame presses
made a slightly longer press move the lever *less* than a shorter one. Cumulative
sweep is monotonic in hold duration.

Both directions held cancels to zero net change. `setThrottleAxis()` seeds the
lever from a restored snapshot and re-anchors any hold in progress; `main.ts`
calls it from `onSimulationReplaced` so a load does not slam the restored
throttle to zero on the next frame. The v1 *ratchet* — where throttle could only
ever be a multiple of 0.1 — is gone.

## Pointer lock and the pause seam

- `requestPointerLock()` / `releasePointerLock()` drive a `PointerLockSurface`
  port; `main.ts` adapts canvas + document.
- While locked, `mousemove` accumulates `movementX/​Y × lookRadPerPixel` into
  pending yaw/pitch. `poll()` drains the accumulator into the frame and zeroes
  it, so deltas are per-frame and wall-frame (no warp scaling — that is
  T0108's job per plan §3.1). Default sensitivity `0.0022 rad/px`; T0106 makes
  it a setting.
- **Escape** is handled twice on purpose:
  1. an unlocked `Escape` keydown raises the pause intent directly;
  2. a pointer-lock loss that the engine did not itself request also raises it.

  Browsers consume the `Escape` keydown that exits pointer lock, so (2) is the
  path that actually fires during flight, and it also covers alt-tab and window
  blur — pausing on focus loss is the behavior a game wants anyway. A lock
  release the engine requested itself never raises the intent.
- The intent is a callback (`onPauseRequested`). T0105 wires a stub in `main.ts`
  that records the request on `canvas.dataset`; **T0112 owns the real menu** and
  must arbitrate with the panels that already consume Escape (system map, burn
  log), all of which `preventDefault()` and therefore suppress the intent today.
- Activation affordance: `dblclick` on the canvas requests the lock, guarded by
  the `pointerLocked` getter so an already-locked canvas never re-requests. This
  is interim. Single click stays with the v1 orbit-drag camera so
  `test:camera-controls` keeps passing; T0110's chase camera owns the real
  activation gesture.
- `Element.requestPointerLock()` returns a promise in current Chrome and rejects
  with `SecurityError` inside the short lock-out window that follows an Escape
  release (reachable as double-click → Escape → double-click). The adapter
  attaches a `.catch()`; an unhandled rejection would surface as a console error
  and fail every browser gate that asserts an empty error list.

## Settings compatibility

Untouched by design. `GameSettingsV2` keeps `inputBindings` as the
`KeyboardEvent.code` map, the strict validator, `RESERVED_CODES`, the v1→v2
migration and its committed fixtures. `src/game/settings.ts` gains **no**
changes at all: the engine consumes `InputBindings` and re-exports the action
list rather than redefining it, so the rebinding UI, the save envelope's
`GameSettingsV1` projection and the export/import merge all keep working
unchanged. All 13 actions and their default codes are preserved.

## Allocation discipline

Everything reachable from `poll()` is preallocated in the constructor:

- `Uint8Array(13)` × 3 — held bits, pending edge counts, frame edge counts.
- One `MutableInputFrame` with one `MutableInputAxes`, both reused forever.
- `Map<string, InputAction>` for code lookup and `Map<InputAction, number>` for
  the dense index; `Map.get` does not allocate. Maps are rebuilt only on a
  settings change, never per frame.
- Event handlers are constructor-bound arrow properties, created once.
- `poll()` uses `TypedArray.set`/`fill` (allocation-free) and scalar math only;
  no closures, literals, spread or array helpers.

The heap gate (`npm run test:perf-gates`, ≤ 196,608 B growth per 30 s window)
covers this in the real browser.

## Testing

Unit (Vitest):

- `bindings.test.ts` — the unified predicate against all three call sites' target
  shapes; the activation-key clause; duplicate-code rejection; dense index
  stability.
- `inputEngine.test.ts` — **Shift+W still pitches** and **W with a focused
  button still pitches** (the two v1 regressions), **`Space`/`Enter` bound to a
  flight action still activate a focused button or `<summary>`** while every
  other key keeps flying, `defaultPrevented` suppression, edge vs level
  semantics, the 1.5 s sweep measured from rest with no head start, tap-step
  monotonicity, queued-edge drop on blur/rebind, pointer-lock delta scaling and
  drain-once, Escape/pause intent, rebind routing, frame-object identity.
- `inputCommandBridge.test.ts` — flush shape (no rotate without change), restore
  preservation, warp-clamp throttle recovery, warp ladder stepping.

Browser: no *new* harness — input is not a visual feature, so the plan's
new-harness rule does not apply, and a separate CI step would cost a browser
launch for three assertions. Instead `tools/tests/cameraControlsRegression.mjs`
gains the pointer-lock case on the production page it already has open:
double-click takes the lock on `#space-canvas`, Escape releases it and
increments `canvas.dataset.pauseRequests`. That is the only new code path with no
other automated coverage. The remaining gates that cover this work —
`test:session-settings` (rebind + persistence + held-key rate), `test:burn-log`
(focused-button key presses), `test:tutorial` (throttle/warp/map key flow),
`test:main-menu` (`RuntimeResourceCounts`), `test:smoke`, `test:perf-gates` —
all stay green.

`RuntimeResourceCounts.keyboardCommandMappers` keeps its name even though the
class is gone: it is frozen CI contract surface (~25 browser gates) and the
rule is extend, never drop. It now counts input engines, one per space-phase
activation, exactly as before.

## Known interactions and follow-ups

- **Listener order.** The engine registers its window `keydown` during
  space-phase activation, after `SystemMapKeyboardBinding` (mounted with the
  app) and before `CameraInputController`. So map/panel keys win over flight
  keys (they `preventDefault()` first), and flight keys win over the
  non-rebindable camera focus keys `[ ] E J` and the `Shift`+arrow chords. That
  ordering is the right one — a key the player deliberately bound must always
  fly the ship — but it means binding a flight action to `E`, `J`, `[` or `]`
  shadows that camera shortcut. T0106 should surface this in the rebinding UI.
- **`cameraInputController` focus keys stay hardcoded.** Moving `[ ] E J` into
  the bindings registry would change the persisted settings schema (new
  actions), the rebinding UI, and the camera-controls harness — more churn than
  T0105 should carry, and T0110 rebuilds camera control anyway. What T0105 does
  fix is the policy divergence: `cameraInputController` and `SystemMapPanel` now
  import the shared predicate and honor `defaultPrevented`, so all three
  subsystems agree on what "the user is typing" means.
- **Wall-time authority** (plan §3.1) and the manual-attitude warp lock are not
  in this task; the bridge keeps v1's sim-time rates so behavior is unchanged
  until ADR-035 lands.
- **"Escape opens pause" is conditional until T0112.** `SystemMapPanel.tsx:85`
  `preventDefault()`s Escape whenever the map is open, and its window listener is
  registered before the engine's, so Escape closes the map and raises no pause
  intent. The same will apply to any future panel that claims Escape. T0112 owns
  the arbitration and should decide the precedence explicitly rather than
  inheriting it from listener registration order.
- **Deleting `inputCommandBridge.ts` (T0108) touches three files, not two.**
  `src/ui/BurnLogPanel.test.tsx` imports both `InputCommandBridge` and
  `ROTATION_RATE_RAD_S` from it to drive a real engine→Commands path in the
  focused-button regression. `ROTATION_RATE_RAD_S` must **move** to
  `game/flight/flightController.ts` (or wherever the rate constant lands), not be
  deleted with the file.
