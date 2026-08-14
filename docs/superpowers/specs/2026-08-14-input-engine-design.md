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
- `blocksGameKey(event)` — `event.defaultPrevented || isEditableTarget(target)`.

`defaultPrevented` is the load-bearing half of the new policy. A focused button
no longer blocks flight input *by virtue of being a button*; it blocks only the
specific keys it actually consumed. The burn-log row (`ui/BurnLogPanel.tsx:114`)
and the rebind capture button (`ui/SessionSettingsPanel.tsx:265`) already call
`preventDefault()` on the keys they handle, and they run in the target phase
before the engine's window-level listener, so arrow-key list navigation and
rebind capture keep working without disabling the rest of the ship.

### `src/game/input/inputEngine.ts`

Owns raw event subscription and per-frame state. DOM types appear only as
structural ports (`InputKeyboardTarget`, `PointerLockSurface`) — `src/game/`
keeps its no-globals discipline and the browser adapters live in `main.ts`, the
same pattern `settings.ts`/`KeyValueStorage` already uses.

Keyboard handling, in order:

```
repeat                      → ignore (OS auto-repeat is not a new press)
ctrlKey || altKey || metaKey→ ignore (real browser/OS chords)  [Shift is NOT here]
blocksGameKey(event)        → ignore (editable target, or already consumed)
Escape                      → raise the pause intent, release pointer lock, return
bindings.resolve(code)      → set held + latch edge, preventDefault()
```

`keyup` clears the held bit unconditionally (so a key released over a focused
button cannot stick — v1 already did this and it must survive). A `blur` on the
keyboard target releases every held key, which fixes stuck axes on alt-tab.

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
  encoded this as `axesDirty`; `markSynchronized()` is the equivalent hook for
  the restore path.
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

- Range `[0, 1]`, continuous, owned by the engine.
- **Hold** ramps at `1 / 1.5 s ≈ 0.667 s⁻¹`, so a full sweep takes 1.5 s.
- **Tap** applies `THROTTLE_TAP_STEP = 0.1` immediately, because a press and
  release that both land between two polls have zero held duration and would
  otherwise do nothing at all. A tap is a discrete nudge; the resulting value is
  still continuous and holding sweeps smoothly through it. The v1 *ratchet* —
  where throttle could only ever be a multiple of 0.1 — is gone.
- Both directions held cancels to zero net change.
- `setThrottleAxis()` seeds the lever from a restored snapshot;
  `main.ts` calls it from `onSimulationReplaced` so a load does not slam the
  restored throttle to zero on the next frame.

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
- Activation affordance: `dblclick` on the canvas requests the lock. This is
  interim. Single click stays with the v1 orbit-drag camera so
  `test:camera-controls` keeps passing; T0110's chase camera owns the real
  activation gesture.

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
  shapes; duplicate-code rejection; dense index stability.
- `inputEngine.test.ts` — **Shift+W still pitches** and **W with a focused
  button still pitches** (the two v1 regressions), `defaultPrevented`
  suppression, edge vs level semantics, throttle ramp timing (1.5 s sweep) and
  tap step, pointer-lock delta scaling and drain-once, Escape/pause intent,
  blur release, rebind routing, allocation-free repeat polling.
- `inputCommandBridge.test.ts` — flush shape (no rotate without change), restore
  preservation, warp-clamp throttle recovery, warp ladder stepping.

Browser: no new harness (input is not a visual feature; the plan's harness rule
targets visual features). The existing gates that cover this path —
`test:session-settings` (rebind + persistence + held-key rate),
`test:camera-controls`, `test:burn-log` (focused-button key presses),
`test:tutorial` (throttle/warp/map key flow), `test:main-menu`
(`RuntimeResourceCounts`), `test:smoke`, `test:perf-gates` — all stay green.

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
