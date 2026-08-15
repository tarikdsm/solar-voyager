# Gamepad input — per-task design (T0106)

## Problem

T0105 shipped `InputEngine`, which turns keyboard + pointer-lock events into one
preallocated `InputFrame` per frame. T0108 shipped `FlightController` +
`FlightInputRouter`, which turn that frame into `Commands`. Neither touches a
gamepad. The plan (`docs/superpowers/sdd/2026-08-14-v2-free-flight/T0106-brief.md`)
asks for: Gamepad API polling into the existing axis pipeline (deadzone 0.08,
curve exponent 1.6, both configurable), a standard-mapping default (left stick
pitch/yaw, right-X roll, triggers throttle, A/B reserved for the not-yet-built
cruise system), per-axis invert + sensitivity in settings with a v2→v3 profile
migration, and zero polling cost while nothing is connected.

Two things make this harder than "read `navigator.getGamepads()` in the frame
loop":

1. **`getGamepads()` returns a fresh array on most browsers on every call**,
   which collides with the CI heap-growth gate if called unconditionally at
   60 Hz forever.
2. **The profile settings document (`GameSettingsV2`) is parsed on every
   session start**, and T0108 already hit the failure mode once: appending
   actions to the registry without a backfill made every pre-T0108 document
   unloadable. Adding a whole new required `gamepad` field needs the same care.

## Decision summary

- Gamepad polling is a collaborator **owned by `InputEngine`**, not a second
  input surface `main.ts` wires independently. `InputEngine.poll()` still
  returns the one `InputFrame` `FlightInputRouter` already consumes — gamepad
  axes are summed into `frame.axes.{pitch,yaw,roll}`, the trigger pair sets
  `frame.axes.throttle` directly (bypassing the keyboard ramp), and the A/B
  buttons latch `InputFrame` press edges for two new registry actions,
  `cruiseEngage` / `cruiseAbort`. This is what "feed the existing axes, don't
  add a parallel path" means concretely: there is exactly one `InputFrame`,
  exactly one `FlightInputRouter.apply()` call, unchanged.
- Device access is a new port, `GamepadHost` (`getGamepads` + connect/disconnect
  listeners), implemented by `main.ts` — same shape as `PointerLockSurface`.
- **Connect/disconnect gates every `getGamepads()` call.** `GamepadPoller` keeps
  a primary-index field, updated only inside the (rare) connect/disconnect
  callback by rescanning once. `poll()` checks that field first; with no
  gamepad connected it returns immediately without calling `getGamepads()` at
  all — zero allocation is then trivially true because zero device calls
  happen. See "Allocation discipline" for the connected steady state.
- Settings: a new independent `GamepadSettings` value (global `deadzone` +
  `curveExponent`, per-axis `{invert, sensitivity}` for pitch/yaw/roll/throttle)
  lives only on the **profile** document, never on the save-embedded
  `GameSettingsV1` DTO (architecture.md is explicit that the embedded DTO stays
  quality lock + bindings forever). The profile document becomes
  `GameSettingsV3`; `GameSettingsV2` is kept, unexported beyond this file, as
  the strict parser for the one-time migration — the same shape T0108 used for
  `GameSettingsV1 → GameSettingsV2` via `migrateLegacySettings`.
- `cruiseEngage` / `cruiseAbort` are registered in `INPUT_ACTIONS` (so they get
  keyboard defaults and show up in the existing rebinding UI for free) but no
  code branches on them anywhere except the gamepad button table. T0116 wires
  behavior; this task only guarantees `frame.pressed('cruiseEngage')` is `true`
  on the frame the A button goes down.

## Considered approaches for where polling lives

1. **Selected: fold into `InputEngine`.** One frame object, one call site,
   `FlightInputRouter` needs no changes. Costs: `InputEngine` grows a
   constructor-injected optional dependency and ~40 lines of merge logic.
2. **Rejected: a sibling poller `main.ts` calls before `flightInputRouter.apply`,
   writing into `FlightController` via its decomposed setters directly.** The
   plan's own architecture note floats this ("so a gamepad ... and the
   CruiseDirector drive the same surface") but the T0106 brief is explicit:
   feed the existing axes, and `flightInputRouter.ts`'s module doc says it is
   "the only module that knows both `InputFrame` and `FlightController`" — a
   second caller of the controller's setters would falsify that sentence and
   create two places that decide what "manual rotation locked above
   `MANUAL_ATTITUDE_MAX_WARP`" means instead of one.
3. **Rejected: gamepad emits its own `InputFrame`-shaped object, router takes
   two frames.** Doubles every call site in `FlightInputRouter` and the holds/
   warp logic, for no behavioral benefit over summing into the one frame.

## Axis mapping

Standard `Gamepad` mapping (`mapping === 'standard'`, the only layout this task
supports — a non-standard pad reports `connected` but `mapping !== 'standard'`
and is treated as not connected, since axis/button indices are meaningless
without the standard layout):

| Physical control      | Index                | Feeds                                  |
| ---------------------- | --------------------- | --------------------------------------- |
| Left stick X            | `axes[0]`             | `yaw` (right = `+1`, matches `yawRight`) |
| Left stick Y            | `axes[1]`             | `pitch`, **negated**                    |
| Right stick X           | `axes[2]`             | `roll` (right = `+1`, matches `rollRight`) |
| Left trigger (analog)   | `buttons[6].value`    | `throttle`, subtracted                  |
| Right trigger (analog)  | `buttons[7].value`    | `throttle`, added                       |
| A                       | `buttons[0].pressed`  | `cruiseEngage` edge/level               |
| B                       | `buttons[1].pressed`  | `cruiseAbort` edge/level                |

**Pitch sign.** `axes[1]` is `-1` at "stick pushed away from the player" per
the W3C standard-gamepad spec. The keyboard convention already fixes what
"pitch up" means: `pitchUp` (`W`) drives `frame.axes.pitch = +1`, and mouse-look
"up" also ends up `pitch up` (`inputEngine.ts` negates `movementY`, which is
positive-down, before folding it into the look delta). Both existing input
paths therefore agree on "away from the body = up", i.e. non-inverted,
FPS/mouse-look convention rather than the aircraft-yoke convention (push
forward = nose down) some flight sims default to. The gamepad stick matches
them: `pitchRaw = -axes[1]`. Players who want yoke-style pitch flip the `pitch`
axis's `invert` setting — a coin-flip default either way is one option flip
away from wrong for half the audience, so this only has to be *documented*,
not universally correct.

**Yaw and roll signs** are unambiguous: `axes[0]`/`axes[2]` are already
`-1 = left, +1 = right`, which is the same sign `yawRight`/`rollRight` already
use. No negation.

**Deadzone and curve** apply identically to all four logical axes (pitch, yaw,
roll, throttle) via one pure function, `shapeGamepadAxis`:

```
deadzoned = |raw| <= deadzone ? 0 : sign(raw) * (|raw| - deadzone) / (1 - deadzone)
curved    = sign(deadzoned) * |deadzoned| ^ curveExponent
shaped    = clamp(curved * (invert ? -1 : 1) * sensitivity, -1, 1)
```

The deadzone step *rescales* the surviving range back to `[0, 1]` rather than
just clamping the bottom off, so a shaped value still reaches exactly `±1` at
full deflection regardless of the deadzone setting — a raw clamp would leave
the last `deadzone` fraction of physical travel unreachable. The curve step is
a standard signed power law ("expo" in flight-sim terminology): `1.6 > 1` gives
finer control near center (a real concern on 8-bit-resolution thumbsticks)
while `1^1.6 = 1` keeps full deflection reachable. Defaults (`0.08` deadzone,
`1.6` exponent) are the brief's numbers verbatim.

**Throttle is the one axis where the deadzone/curve pipeline's *sign* changes
what happens downstream**, not just the shaped value:

```
rawThrottle = rightTrigger.value - leftTrigger.value        // both already [0, 1]
shaped      = shapeGamepadAxis(rawThrottle, throttleSettings) // same pipeline, signed [-1, 1]
leverValue  = clamp01(shaped)                                 // no reverse thrust exists
active      = shaped !== 0                                    // deadzone already collapsed "at rest" to exactly 0
```

Right trigger alone drives the lever up proportionally (the common single-
trigger-throttle scheme); left trigger pulls it back down/cuts it — both
triggers meaningfully participate, matching "triggers" (plural) in the brief
rather than wiring only one. `invert` swaps which trigger increases the lever;
`sensitivity` scales the shaped magnitude before the final `clamp01`, same as
the other three axes.

### The trigger sets the lever, it does not ramp it

The critical-context note calls this out explicitly, and it is the one place
gamepad input does *not* go through the same code path as its keyboard
counterpart at the call-site level (it goes through the same **output**, just
via a different **method**): keyboard throttle is `R`/`F`, a rate demand
integrated by `InputEngine.integrateThrottle()` into a lever position over
time (`docs/controls.md`: "a tap nudges it by ten percent, and holding the key
sweeps the full range in 1.5 seconds"). A trigger is not a rate demand, it is
an absolute position — pressing it 40% means "I want 40%", not "ramp toward
40%". So when the shaped trigger value is active (beyond deadzone), `poll()`
calls the engine's own public `setThrottleAxis(value01)` — the exact method
`main.ts` already uses to seed the lever from a restored snapshot — instead of
writing `frame.axes.throttle` directly. `setThrottleAxis` does three things
that matter here: it clamps and stores the value as the lever's persistent
state (`this.throttle`), it writes this frame's `axes.throttle`, and it
re-anchors the hold-ramp origin (`throttleHoldDirection/Sec/Origin`) to the new
value. That last part is why calling the existing method beats assigning
`frame.axes.throttle` directly: if a player lets go of the trigger and taps `R`
a moment later, the ramp must sweep from wherever the trigger left the lever,
not from a stale pre-trigger value or a discontinuous jump.

When the trigger pair is at rest (both under deadzone, `shaped === 0`), the
gamepad contributes nothing that frame — the keyboard ramp's own output from
earlier in `poll()` stands untouched. This is deliberate: a gamepad sitting on
the desk next to a keyboard-only player must never fight the keyboard, and a
trigger released to exactly zero should mean "I'm not touching this control"
(lever holds), not "force the lever to zero" (which is what a naive
"always overwrite" merge would do to a keyboard-set throttle the instant a
connected-but-unused controller is polled).

## Button wiring: `cruiseEngage` / `cruiseAbort`, deliberately inert

`GAMEPAD_BUTTON_BINDINGS` in `gamepad.ts` maps `buttons[0]` (A) →
`'cruiseEngage'` and `buttons[1]` (B) → `'cruiseAbort'`, mirroring the
`HOLD_BINDINGS` table already in `flightInputRouter.ts`. Both are new
`InputAction`s in `settings.ts`'s append-only `INPUT_ACTIONS`, with keyboard
defaults `KeyG` / `KeyV` (neither previously bound — `KeyB` was the first choice
but collides with an existing settings-test rebind fixture, so it moved) so the existing rebinding
UI lists them for free and the settings-schema backfill machinery (below)
already covers them.

Nothing in this PR reads either action. `FlightInputRouter.applyAssists()` is
untouched — it does not iterate `INPUT_ACTIONS` generically, it has an
explicit `HOLD_BINDINGS` table plus two named checks, so adding registry
entries cannot accidentally wire behavior. The comment at the
`GAMEPAD_BUTTON_BINDINGS` declaration says so explicitly: T0116's
`CruiseDirector` is the first and only intended reader of
`frame.pressed('cruiseEngage')` / `frame.pressed('cruiseAbort')`. The
settings-panel label text says "(reserved)" for the same reason a control
that is bindable but does nothing yet would otherwise look like a bug report.

## Settings: `GameSettingsV2` → `GameSettingsV3`

Read `src/game/settings.ts`'s existing `GameSettingsV1 → GameSettingsV2`
machinery (`migrateLegacySettings`, the two storage keys, `SettingsRepository
.load()`'s fallback branch) before reading this section — T0106 is a straight
copy of that shape one version up, not a new mechanism.

**This is a different fix from T0108's `parseInputBindings` backfill**, and
worth being precise about why. T0108 added seven actions to a registry that
was already parsed permissively per-field (missing keys backfilled from
defaults, in place, no version bump). T0106 adds one brand-new *required*
top-level field (`gamepad`) to a document that is parsed with
`assertExactKeys` — strict, all-or-nothing. A per-field backfill inside
`parseProfileSettings` would work too, but the brief's acceptance criterion
asks for "profile v2->v3 settings migration", i.e. the version-chain shape,
so that is what this does: `GameSettingsV2` (unchanged, `version: 2`, no
`gamepad` field) is kept as a private, exact-match parser
(`parseProfileSettingsV2`) used only by the new migration; the exported,
"live" `parseProfileSettings` now requires `version: 3` and a `gamepad` field.

`SettingsRepository.load()` gains one fallback layer, structurally identical to
the existing v1→v2 one:

```
text present at SETTINGS_STORAGE_KEY
  → JSON.parse fails                    → ok:false, "Unable to parse settings"        (unchanged)
  → parses, parseProfileSettings (v3) succeeds → ok:true, source:'stored'              (unchanged)
  → v3 parse fails, parseProfileSettingsV2 (v2) succeeds
      → migrateProfileV2ToV3 (adds DEFAULT_GAMEPAD_SETTINGS), write back
      → ok:true, source:'migrated'                                                     (NEW)
  → v2 parse also fails                 → ok:false, "Unable to parse settings" (the v3 error) (NEW branch, old outcome)
text absent → existing legacy-key (v1) path, now composed with migrateProfileV2ToV3
              before returning/persisting                                              (extended)
```

A stored, syntactically valid, but neither-v3-nor-v2 document still fails
closed — this only adds a migration path for a document that is a legitimate
v2 profile, it does not loosen validation. `mergeGameSettingsPreferences` also
grows one line: it already preserves `tutorial` (profile-only state a save
import must not clobber) across an import, and now preserves `gamepad` for the
same reason — a `.save.json` import carries only `GameSettingsV1` (quality +
bindings), never gamepad calibration.

**Real-world exercise of this path, not just unit tests**: `tools/perf/
browserSettings.mjs` (consumed by `test:perf-gates` and `bench`) plants a
hand-written `version: 2`, 13-binding, no-`gamepad` document directly into
`localStorage` before every perf/bench run, deliberately left that way since
T0108 (see that task's design doc §11) specifically *because* it exercises the
backfill on a real load path with a pinned assertion (`qualityLock: 'high'`)
that would visibly break if migration regressed. It now also exercises the
v2→v3 gamepad-default migration on every gate run for free.

### New settings surface

```ts
export const GAMEPAD_AXES = ['pitch', 'yaw', 'roll', 'throttle'] as const;
export interface GamepadAxisSettings { readonly invert: boolean; readonly sensitivity: number }
export interface GamepadSettings {
  readonly deadzone: number;       // [0, 0.5], default 0.08
  readonly curveExponent: number;  // [0.5, 4], default 1.6
  readonly axes: Readonly<Record<GamepadAxisId, GamepadAxisSettings>>; // sensitivity [0.1, 4], default 1
}
```

Four narrow mutators mirror `rebindInput`'s shape exactly (validated primitive
in, `parseProfileSettings` re-validates and re-freezes the whole document out):
`updateGamepadDeadzone`, `updateGamepadCurveExponent`, `updateGamepadAxisInvert`,
`updateGamepadAxisSensitivity`. `GameSessionController` gets one method per
mutator, `SessionSettingsPanel` one control group per mutator.

## Accessibility: never steal a focused text field

Keyboard already gates per-*event* on `event.target` (`blocksGameKey`).
Gamepad has no event target — it is sampled, not dispatched — so `InputEngine`
takes a new `isTextEntryActive: () => boolean` option (default `() => false`,
matching every other optional port). `main.ts` supplies
`() => isEditableTarget(document.activeElement)`, reusing the exact predicate
`SystemMapPanel.tsx` already uses for the same purpose. `poll()` still calls
`gamepad.poll()` unconditionally when a port is present (so the poller's own
edge-tracking — "was this button already down" — stays correct across a focus
excursion and a button held throughout a form fill-in does not fire a false
press when focus returns), but skips merging axes *and* buttons into the frame
for that call when a text field is focused. This mirrors "never steal input
from a focused text field" as literally as the keyboard path already does it
for keys.

## Allocation discipline

`GamepadPoller` preallocates everything in its constructor: two
`Uint8Array(INPUT_ACTION_COUNT)` (button down state, this-poll edge state) and
scalar fields for the four shaped axes. `poll()`:

- **Disconnected** (`primaryIndex < 0`, the common case in CI and for players
  without a controller): one field comparison, return. `getGamepads()` is never
  called. Zero allocations because zero device calls.
- **Connected**: calls `host.getGamepads()` once. This **does** allocate — a
  fresh top-level array is a documented, widely-known Chromium behavior
  ("navigator.getGamepads() famously returns a fresh array", per the brief),
  not something a userland port can avoid, since there is no event-based
  alternative to reading current axis values. The returned array and the
  `Gamepad` object read out of it are not retained past the synchronous `poll()`
  call — every value used afterward is a `number`/`boolean` copied into
  `GamepadPoller`'s own preallocated fields. This is why it does not move the
  CI heap gate: that gate (`tools/perf/performanceGate.mjs`) measures **retained**
  heap after two forced `gc()` calls over a settle window, not allocation
  churn — a same-size array that becomes unreachable every frame is exactly
  the kind of garbage a mark-and-sweep collector reclaims for free, unlike a
  leak that grows the *live* set. Proven empirically in Verification below,
  since CI has no physical controller to hold this path connected for the
  production 30 s window anyway (see Testing) — the disconnected-path gate is
  what actually runs in CI, and it is the literal zero the brief asks for.
- Merge math in `InputEngine.pollGamepad()` is scalar reads/writes and one
  `Uint8Array` pass over a 2-entry table — no closures, literals, or array
  helpers.

## Files

- `src/game/settings.ts` — `GameSettingsV3`, `GamepadSettings` +
  parse/validate/freeze, `migrateProfileV2ToV3`, `SettingsRepository` fallback
  chain, two new `INPUT_ACTIONS`, four new mutators. `GameSettingsV2` kept,
  no longer exported as "the" profile type.
- `src/game/input/gamepad.ts` (new) — pure shaping functions, `GamepadHost`
  port, `GamepadSource` interface, `GamepadPoller`, `GAMEPAD_BUTTON_BINDINGS`.
- `src/game/input/inputEngine.ts` — optional `gamepad`/`isTextEntryActive`
  constructor options, `pollGamepad()` merge step, `applyGamepadSettings()`,
  `dispose()` disposes the poller.
- `src/game/sessionController.ts` — `GameSettingsV2` → `GameSettingsV3`, four
  new mutator methods.
- `src/ui/SessionSettingsPanel.tsx` — gamepad settings section (deadzone/curve
  number inputs, four-row invert+sensitivity grid), `(reserved)` labels for
  the two new actions.
- `src/main.ts` — `GamepadHost` browser adapter (feature-detected), wires
  `GamepadPoller` into `InputEngine`, `isTextEntryActive`, keeps
  `applyGamepadSettings` in sync in the existing `onSettingsChanged` handler.
- `docs/controls.md` — new Gamepad section.
- `docs/architecture.md` — `game/input/` module-map row.
- `tests/fixtures/settings-profile-v2.json` (new) — committed pre-gamepad
  profile fixture for the migration test.

## Testing

Unit (Vitest):

- `gamepad.test.ts` — pure `shapeGamepadAxis` (deadzone rescaling, curve,
  invert, sensitivity, clamping) as table-driven cases; `GamepadPoller`
  against a faithful fake `GamepadHost` (standard mapping shape, a **fresh
  array instance returned by every `getGamepads()` call**, `gamepadconnected`/
  `gamepaddisconnected` firing independent of any specific event payload,
  multi-controller connect/disconnect ordering); the zero-call assertion while
  disconnected (spy on `getGamepads`, assert 0 calls across many `poll()`s);
  trigger-combination cases; button edge/level/disconnect-clears-down cases.
- `inputEngine.test.ts` — new describe block wiring a *real* `GamepadPoller`
  (not just the `GamepadSource` interface) into a real `InputEngine`, so the
  integration is exercised with production code on both sides: axis summing
  with simultaneous keyboard input, trigger-sets-lever-then-keyboard-resumes,
  text-entry-focus suppression, disconnect mid-session clearing held buttons.
- `settings.test.ts` — `GamepadSettings` validation (range rejection for all
  three numeric fields, exact-key rejection), the four mutators, and the
  v2→v3 migration itself against the new committed fixture (mirrors the
  existing "migrates a stored v1 profile" case) plus a "fails closed" case
  when neither schema accepts the document.

Browser: extends `tools/tests/sessionSettingsRegression.mjs` (no new harness —
this is UI inside the existing settings panel, exactly the T0105 precedent for
"not a new visual feature") with a gamepad-settings interaction (open panel,
change a sensitivity value, reload, assert it persisted) and confirms the
`(reserved)` labels render. `test:camera-controls`, `test:perf-gates`,
`test:smoke` are existing gates this change can reach and must stay green; run
explicitly.

## Verification

Run and reported in `T0106-report.md`: `lint`, `typecheck`, `format:check`,
`test` (baseline measured on this branch's base before any change), `test:perf
-gates`, `test:session-settings`, `test:camera-controls`, plus `npm run bench`
before/after for the frame-loop touch (`docs/bench/T0106-summary.md`).
