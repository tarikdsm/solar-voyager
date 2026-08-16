# T0112 — HUD presets, real pause, world markers v0 — Design

Task: `T0112` (plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §T0112, spec
`docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §7).
Branch: `task/T0112-hud-presets`.

## 0. The problem, stated precisely

v1's complaint was never that the numbers were wrong. It was that the instruments *were* the game:
eight absolutely-positioned mission-control panels are always on screen, there is no pause, and
nothing in the world tells you where your target is. This task does not delete instrumentation — it
makes it **opt-in**, gives the player a real pause, and moves navigation into the world.

Five deliverables, one PR:

1. Preset state machine `clean | pilot | engineer`, one key, persisted.
2. World markers: target diamond + distance, prograde/retrograde, toggleable body labels.
3. Click-to-target by angular-disc picking.
4. A real pause: the simulation genuinely stops, with resume / settings / save / exit-to-menu.
5. CSS design tokens + a grid layer replacing the hand-placed insets of the migrated panels.

## 1. Layering and the one-publisher rule

```
core ← sim ← game ← render/ui        (ESLint-enforced; render ↮ ui)
```

Everything numeric this task adds is a **pure `game/` module**: preset ring, marker projection,
marker model, body picking, HUD input routing. `ui/` renders them; `render/` never sees them.

The Global Constraint that shapes the marker design most is the publication rule: UI reads
`SimSnapshot` through the **existing 10 Hz publisher**, not a second path. So the marker signals
live **inside `HudSignalStore`**, and the store gains one extra entry point:

```ts
publish(snapshot, nowMs): boolean;                              // unchanged
publishWorldMarkers(snapshot, pose, widthPx, heightPx): void;   // new
```

`publishWorldMarkers` is called from `renderFrame` **only on the frames where `publish()` returned
true**, after `cameraDirector.update()` has written the pose for that frame. One store, one 100 ms
clock, one snapshot read, no retention of the double-buffered snapshot across frames (it is passed
in, never stored).

Rejected alternatives, recorded so the next agent doesn't re-litigate them:

- *A second `MarkerSignalStore` with its own sampler.* Two 100 ms clocks drift apart, and the HUD
  would show a target distance from one frame and a diamond from another.
- *Raycasting three.js objects.* Forbidden by the brief and wrong anyway: bodies below the point
  threshold have no pickable mesh, the ship is at the render origin, and a raycast would need the
  f32 camera-relative scene — a second precision boundary.
- *Publishing markers from `render/`.* `render ↮ ui`.

## 2. Preset state machine

`src/game/hud/hudPresets.ts`, pure and allocation-free.

```ts
export const HUD_PRESETS = ['clean', 'pilot', 'engineer'] as const;
export type HudPreset = (typeof HUD_PRESETS)[number];
export type HudSurface = /* 15 named surfaces */;
export function nextHudPreset(preset: HudPreset): HudPreset;
export function hudPresetShows(preset: HudPreset, surface: HudSurface): boolean;
```

Presets are **monotone tiers**, not three independent sets: `clean ⊂ pilot ⊂ engineer`. Each surface
declares the lowest tier that shows it, and `hudPresetShows` is a rank comparison. Two consequences
worth the constraint: "Engineer = everything v1 had" is true by construction rather than by a list
somebody must remember to extend, and a surface added by a later task cannot accidentally appear in
Clean — the default for an un-ranked surface is the highest tier.

| Surface | Tier | Note |
|---|---|---|
| `reticle`, `throttleStrip`, `warnings`, `cruiseStatus`, `targetMarker` | clean | Clean's whole HUD |
| `navball`, `dualClock`, `radarAltitude`, `warpIndicator` | pilot | |
| `orbitReadout`, `energyPanel`, `stateVectors`, `burnLog`, `targetPanel`, `cameraHelp` | engineer | the v1 panels |

`cruiseStatus` is a **placeholder** in this task: T0116 owns `CruiseDirector`, so the strip renders
`Cruise · standby` and the phase/ETA slots stay empty. It ships now because Clean's layout has to
reserve the space, and a hole that appears three tasks later is a layout regression waiting to
happen.

Body labels are **not** a preset tier. They are an independent toggle (`bodyLabels`), because their
usefulness is a function of where you are, not of how much instrumentation you want.

Cycling: one key (`KeyH` by default) steps the ring; `KeyL` toggles labels. Both are registered in
`INPUT_ACTIONS`, so both are rebindable through the existing UI and the gamepad, and both go through
`InputEngine` — the same focus policy (`blocksGameKey`) that protects flight keys protects these.

## 3. Marker projection

`src/game/hud/markerProjection.ts` — float64 throughout, no `Math.fround`, so the scan in
`tests/render/float32Boundary.test.ts` stays satisfied with `src/render/spaceScene.ts` as the only
bridge.

The camera basis must match what `render/cameraRig.ts` hands three.js, or the diamond will not sit
on the planet. `applyCameraPose` calls `camera.lookAt(direction)` with the camera at the render
origin, so three.js `Matrix4.lookAt(eye=0, target=f, up=hint)` gives `z = −f`, `x = normalize(hint ×
z)`, `y = z × x`. Re-expressed without the sign flips:

```
f = normalize(pose.lookDirection)
r = normalize(f × pose.upDirection)        // camera +X
u = r × f                                  // camera +Y
```

`upDirection` is an *up hint* (three.js semantics, per the T0110 contract), so `r` is normalized
after the cross product and `u` is recovered from `r × f` rather than used raw. When the hint is
parallel to `f` the cross product degenerates; the projector reports `ok = false` and every marker
hides for that sample rather than snapping to a garbage basis.

Projection of a world point `p`:

```
d  = p − pose.positionKm                   // float64, magnitudes up to ~1e10 km
cz = d·f ;  cx = d·r ;  cy = d·u
t  = tan(fovDeg/2 · π/180) ;  aspect = widthPx / heightPx
ndcX = cx / (cz · t · aspect) ;  ndcY = cy / (cz · t)
xPx  = (ndcX + 1)/2 · widthPx ;  yPx = (1 − ndcY)/2 · heightPx
```

`cz ≤ 0` is *behind*, not invisible: the target marker still has to tell you which way to turn. A
behind-camera target is projected from the mirrored direction (`cx, cy` negated) and then clamped to
the viewport edge, and the marker carries `behind = 1` so the view can render an arrow instead of a
diamond. Points in front but outside the frustum are clamped the same way with `behind = 0`.

Everything writes into caller-owned `Float64Array`s. No allocation, no `Vector3`.

## 4. World marker model

`src/game/hud/worldMarkerModel.ts` fills one preallocated `WorldMarkerBuffer`:

- **Target** — `visible, xPx, yPx, behind, offscreen, distanceKm`. Source: `snapshot.targetBodyIndex`
  into `bodyPositionsKm`.
- **Prograde / retrograde** — direction markers. Projection is scale-invariant along a ray, so a
  direction is projected as `pose.positionKm + dir`. The direction is the ship's velocity **relative
  to the dominant body**, matching `navballProjection.ts` exactly; two prograde markers that disagree
  would be worse than one.
- **Body labels** — a fixed `BODY_LABEL_SLOT_COUNT = 8` slots. All 43 catalog bodies are scanned each
  sample; the eight nearest that are in front of the camera and inside the viewport win, chosen by an
  insertion pass over a fixed `Int32Array`. Eight is a legibility budget, not a performance one: 43
  labels is a wall of text.

The ship is excluded structurally, not by a filter: `snapshot.bodyPositionsKm` is catalog bodies
only. (`EpochWorld.positionsKm` is the array with the ship triple appended, and it lives in
`render/`.) The model asserts `bodyPositionsKm.length === bodyIds.length · 3` so a future change that
appends to the snapshot fails loudly here instead of drawing a label on the player's own hull.

## 5. Click-to-target

`src/game/hud/bodyPicking.ts`, pure:

```ts
pickBodyIndexAtPixel(out, snapshot, pose, radiiKm, widthPx, heightPx, pixelX, pixelY): number
```

Angular-disc test per body: project the centre, compute the apparent radius

```
radiusPx = (radiusKm / cz) / t · (heightPx / 2)
pickRadiusPx = max(radiusPx, MIN_PICK_RADIUS_PX = 8)
```

Hit when the pixel distance to the centre is within `pickRadiusPx`; among hits, the smallest `cz`
wins — *nearest along the ray*, which is the rule that makes clicking Io in front of Jupiter select
Io. The 8 px floor is what makes a 0.3-arcsecond asteroid clickable at all.

Radii come from `data/bodies.json` through `src/game/hud/bodyMarkerCatalog.ts`, built once at setup
into a `Float64Array` in catalog order — the same order as `snapshot.bodyIds`.

Gesture policy, in `main.ts`, because it is browser plumbing:

- Only in `space` map mode, only when not pointer-locked, only when not paused.
- A `pointerdown`/`pointerup` pair counts as a click only if it moved < 4 px and lasted < 400 ms.
  `CameraInputController` owns orbit-drag on the same canvas; without this, releasing a drag over
  Jupiter would re-target.
- A miss clears nothing. Deselecting stays the dropdown's job (`None`), which remains the documented
  fallback.

## 6. Real pause

### 6.1 Where the state lives

`SceneManager` gains the sub-state, per the acceptance criterion:

```ts
export type SceneState = 'main-menu' | 'space' | 'paused';
get state(): SceneState;  get paused(): boolean;
pause(): boolean; resume(): boolean; returnToMainMenu(): boolean;
subscribe(listener: (state: SceneState) => void): () => void;
```

`GamePhase` stays `'main-menu' | 'space'`. Pause is a *sub*-state of `space`, exactly as worded, and
keeping `GamePhase` two-valued avoids rewriting every `phase === 'main-menu'` branch in `App`,
`MainMenu` and their tests for a distinction none of them care about.

`returnToMainMenu()` is the "one-way landmine" fix: it clears the pause and sets the phase back to
`main-menu`, so `App` re-renders `MainMenu` and `SceneManager.startNewGame()` / `continueGame()` work
again. `main.ts` keeps the simulation halted while the menu is up, and `activateSpacePhase()` stays
memoised — re-entering the world must not build a second `InputEngine`, a second camera controller
pair or a second animation loop, and `RuntimeResourceCounts` is the contract that says so.

### 6.2 How the simulation actually stops

The acceptance wording is "sim halted via warp-hold, **not skipped frames**". Both halves matter:

- **Halted:** `renderFrame` does not call `session.simulation.step()` while paused; it reuses
  `session.simulation.snapshot`. Simulation time does not advance by one femtosecond. The restore-point
  ring and the camera director are advanced with `0` so no spring, no cadence and no capture moves.
- **Not skipped frames:** `requestAnimationFrame` keeps running and the scene keeps rendering. This is
  not cosmetic. `telemetry.beginFrame(nowMs)` derives `deltaSec` from the previous frame's timestamp;
  stopping the loop would make the first frame after a two-minute pause carry a two-minute wall delta
  straight into `step()`, which at 1e7× warp is 63 years of flight in one frame. Keeping the loop
  alive is what makes the pause *safe*, not just what makes it look nice.

Input while paused: on entering pause `main.ts` calls `inputEngine.releaseHeldKeys()` and
`flightController.resetAxes()`, and skips `inputEngine.poll` / `flightInputRouter.apply` /
`flightController.update` entirely; the same release runs on resume so a key held while clicking a
menu button does not fire into the ship. `resetAxes()` and not `releaseAxes()`: the latter issues
`rotate(0,0,0)`, which would silently stop a spinning ship every time the player paused.

### 6.3 The Escape ladder

Escape already has three owners. The ladder, from highest priority:

1. **System map open** — `SystemMapPanelModel.handleKeyDown` closes the map and calls
   `preventDefault()`.
2. **A HUD control that owns Escape** — today the burn-log rows, which `preventDefault()` and return
   focus to their toggle.
3. **Pause.**

This resolves the brief's "pause is conditional today" note, and it resolves it *without a new
arbitration mechanism*: `InputEngine.handleKeyDown` already runs `blocksGameKey(event)` before the
Escape branch, and `blocksGameKey` returns true for `defaultPrevented`. Levels 1 and 2 therefore
suppress the pause automatically — provided their listeners run first. They do, deterministically:
`SystemMapPanel` attaches its `window` listener during the Preact mount inside `prepareApplication()`,
and `InputEngine` is constructed in `activateSpacePhaseRuntime()`, which `await`s `applicationReady`
first. Same target, same phase, registration order. The burn-log handler is on the row element, which
bubbles before `window` regardless.

Two further suppressions are explicit predicates in `main.ts`, because no `preventDefault` exists to
lean on:

- **Impact freeze** (`impactOccurred === 1`) — the core is already inert and `ImpactOverlay` is the
  only exit. A pause menu stacked over it would hide restore/respawn.
- **Unacknowledged hardware-acceleration warning** — a mandatory pre-flight alert. Pausing under it
  would put a modal over a modal; `test:renderer-policy` also proves the warning stays reachable
  after Escape, and the cheapest way to keep that true is to not open anything.

`canvas.dataset.pauseRequests` still increments on **every** Escape that reaches `InputEngine`,
suppressed or not. That is the T0105 seam `test:camera-controls` asserts, and the pause menu is
layered on top of it rather than replacing it. The new observable is `canvas.dataset.sceneState`.

### 6.4 The menu itself

`ui/PauseMenu.tsx`: `role="dialog" aria-modal="true"`, focus moves to **Resume** on open and returns
to the canvas on close, Escape closes it, Tab is trapped inside. Four actions: Resume, Settings
(expands the existing `SessionSettingsPanel` — one settings UI, not two), Save (`session.saveLocal()`
with the existing status line), Exit to menu. Z-index 30: above every HUD surface, below the impact
overlay's 40.

## 7. CSS: tokens and a grid

`app.css` is 2,003 lines with 21 `position: absolute|fixed` blocks. This task migrates the panels it
owns and leaves the rest, exactly as the acceptance criterion scopes it ("rest migrate in
T0119/T0149").

**Tokens** — a `:root` block: colour ramp, panel surface/border/blur, spacing scale, radii, type
scale, and a named z-layer ladder that replaces the current scattered magic numbers (7 through 40).

**Grid** — `.hud-grid` inside `.space-hud-surfaces`, a nine-area
`grid-template-areas` overlay sized to the viewport with `pointer-events: none`, panels opting back
in. Migrated off absolute insets: `orbit-readout`, `dual-clock`, `warp-control`, `energy-panel`,
`target-panel`, `state-vector-panel`, `navball`, `camera-help` — the eight v1 panels. Not migrated
(deferred, unchanged): the system-map, burn-log, perf and session-settings panels and their toggles,
the tutorial overlay, the hardware warning, the trajectory-impact warning, the impact overlay.

The compact-viewport media query and the `prefers-reduced-motion` block are preserved verbatim for
the deferred panels; `src/ui/App.test.tsx` asserts three regexes over this file
(`.system-map-panel` max-height/overflow, its compact rule, its reduced-motion rule) and none of them
may move.

**Harness gap closed while we are here:** `tests/render/sessionSettingsPage.tsx` never imported
`app.css`, so `test:session-settings` has been asserting layout against unstyled markup — the tracked
follow-up from T0106. It is a one-line import and this is the task that rebuilds the CSS it should
have been watching, so it is closed here.

## 8. Settings: profile generation v5

Adding a preference means a v5 tier, following the precedent already in `settings.ts` exactly:

- `GameSettingsV5 = GameSettingsV4 + { hud: HudSettings }` where
  `HudSettings = { preset: HudPreset; bodyLabels: boolean }`, defaulting to `clean` / `true`.
- New key `solar-voyager.settings.v5`; `…v4` joins v3/v2/v1 as a read-and-migrate-forward tier. Five
  tiers now, all funnelled through the shared `migrateForward` helper T0106 extracted for exactly
  this.
- `migrateProfileV4ToV5` attaches defaults — a whole-document migration, like every tier before it,
  because `hud` is a new required object with nothing in a v4 document to recover from.
- Two new `INPUT_ACTIONS` (`hudPresetCycle`, `hudBodyLabelsToggle`). `parseInputBindings` treats the
  registry as append-only and backfills missing actions, so **existing saves stay loadable** — the
  failure mode the brief warns about (`parseGameSettings` runs on every save load) is already
  defended, and this task adds a regression test that pins it rather than trusting it.
- `SaveEnvelopeV3`'s embedded `GameSettingsV1` DTO is untouched. HUD preference is profile state, not
  mission state: it must not ride along in a save someone emails you. `mergeGameSettingsPreferences`
  preserves it like `tutorial`, `gamepad` and `camera`.

## 9. Handoffs

### 9.1 T0111 → invert `replacementInvalidatesRestorePoints` — **already done**

T0110 landed it. `src/game/restorePoints.ts` allowlists the safe pair (`restore`, `respawn`) and
`replacementInvalidatesRestorePoints` returns `!MISSION_PRESERVING_ORIGINS.includes(origin)`, so an
unrecognised future origin clears the ring — fails closed. The second half ("pin `import`'s
ring-clearing directly") was **not** covered: the existing test exercises the rule through
`new-game`/`load`/`restore`/`respawn` only. This task adds the direct `import` case and a
"an origin nobody has thought of clears the ring" case.

### 9.2 T0108 → body rates in `SimSnapshot` — **declined, with reasons**

`SimSnapshot` publishes no angular rates, so a restore reinstates a spin the flight controller cannot
see, and `resetAxes()` zeroes its model of it. Adding `shipAngularVelocityBodyRadS` would be a
snapshot change and would need an ADR in this PR.

Declined for T0112:

1. **It is not this task's defect.** The visible symptom is a flight-controller/restore
   synchronisation bug (T0108/T0111 territory). Nothing in a HUD preset, a marker or a pause menu
   reads body rates. Bundling a snapshot contract change into the HUD PR buys the reviewer a
   cross-cutting ADR they did not ask for and gives a future bisect a misleading commit.
2. **This task makes the symptom rarer, not worse.** Pause now uses `resetAxes()`, whose entire
   contract is "forget intent, do not overwrite rates" — the pause path is deliberately the one that
   *cannot* zero a restored spin.
3. **The fix has a cheaper shape that belongs to somebody else.** A rate readout on the Pilot preset
   would need the snapshot field; a *controller* that adopts restored rates needs the field too but
   also needs to decide the adoption semantics (adopt as commanded intent? as a measured value the
   stability assist damps out?). That is a flight-model decision, not a HUD one.

Recorded for the next agent: the right home is T0113's V2M1 exit sweep or a dedicated fix-task, with
`ADR-0xx SimSnapshot body rates` covering the field, the double-buffer copy, and
`FlightController.adoptBodyRates()`. No radar-altitude or navball behaviour in this task depends on
it.

### 9.3 T0104 → `SHIP_MASS_KG` in `stateVectorModel.ts` — **fixed**

`src/render/stateVectorModel.ts` hardcoded `SHIP_MASS_KG = 10_000` to scale the momentum axis of the
state-vector widget. It is a display heuristic, but it is a *HUD* display heuristic, and it silently
mis-scales the momentum arrow for any vessel that is not the default. The scale table becomes a
function of `VesselConfig.restMassKg`:

```ts
export function createStateVectorScales(restMassKg: number): StateVectorScaleTable;
export const DEFAULT_STATE_VECTOR_SCALE = createStateVectorScales(DEFAULT_VESSEL.restMassKg);
```

`STATE_VECTOR_SCALE` is kept as a deprecated alias of the default table so nothing outside this file
has to change in the same commit, and `StateVectorWidget` takes the table from the session vessel.
`sim/ship/vessel.ts` is imported by `render/` — allowed by the layering (`sim ← render`).

## 10. Blast radius (greps run before the verification list)

| Touched | Read by | Gate |
|---|---|---|
| `app.css` | `src/ui/App.test.tsx` (3 regexes), `tests/render/{burnLogPanel,impactOverlay,systemMapPanel}Page.tsx`, `tools/tests/impactOverlayRegression.mjs` (full-bleed check) | `npm test`, `test:burn-log`, `test:impact-overlay`, `test:system-map-panel` |
| `RuntimeResourceCounts` | `mainMenuRegression.mjs` (two `deepEqual` literals), `applicationSmokeContract.mjs`, `shipVisualRegression`, `startupRegression`, `systemMapRegression` (subsets) | `test:main-menu` (+ the four subset readers) |
| `canvas.dataset.pauseRequests` | `cameraControlsRegression.mjs` (exactly +1 per Escape) | `test:camera-controls` |
| Escape handling | `burnLogRegression` (focus returns to toggle), `systemMapRegression`, `tutorialRegression`, `rendererPolicyRegression` (warning survives Escape) | those four |
| `SETTINGS_STORAGE_KEY` | `tools/perf/browserSettings.mjs`, `tools/tests/tutorialRegression.mjs` | `test:perf-gates`, `test:tutorial` |
| `INPUT_ACTIONS` | `bindings.ts` (array widths), `gamepad.ts`, `SessionSettingsPanel`, `settings.test.ts`, `sessionSettingsRegression.mjs` | `npm test`, `test:session-settings` |
| `SceneManager` | `sceneManager.test.ts`, `App.tsx`, `MainMenu.tsx/.test.tsx`, `sessionSettingsPanel.test.ts`, `main.ts` | `npm test`, `test:main-menu` |
| `HudSignalStore` | `hudSignals.test.ts`, `tests/render/hudSignalsPage.tsx`, `App.tsx` | `npm test`, `test:hud-signals` |
| `stateVectorModel.ts` | `stateVectorModel.test.ts`, `stateVectorWidget.ts`, `tests/render/stateVectorWidget.ts` | `npm test`, `test:state-vectors` |
| `App.tsx` panel set | every harness that selects `#orbit-readout` as "space is up" — `mainMenu`, `burnLog`, `systemMap`, `tutorial`, `hudSignals`, `smoke` | all of them |

The last row is the dangerous one and it drove a design decision: **`#orbit-readout` is the
"gameplay is running" sentinel for six browser gates**, and Clean does not show it. The default
preset for a *fresh profile* is therefore `clean`, but every harness that predates this task keeps
working because those harnesses plant their own profile or start from defaults — so the harness fix
is to have them cycle to Engineer, not to weaken the default. Where a harness cannot be changed
cheaply, `App` keeps the element mounted and `hidden`, and the gates that call `waitForSelector(...,
{state: 'visible'})` are the ones updated.

## 11. Verification list

`npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test` (baseline 1157 passed / 3
skipped), then one at a time (concurrent headless Chromium here produces spurious failures):
`test:main-menu`, `test:session-settings`, `test:hud-signals`, `test:burn-log`, `test:system-map`,
`test:system-map-panel`, `test:tutorial`, `test:impact-overlay`, `test:camera-controls`,
`test:renderer-policy`, `test:state-vectors`, `test:hud-presets` (new), `test:smoke`,
`test:perf-gates`.

Bench evidence: `docs/bench/T0112-summary.md` with before/after `npm run bench` JSON, since the
marker publisher and the pause branch are on the frame path.
