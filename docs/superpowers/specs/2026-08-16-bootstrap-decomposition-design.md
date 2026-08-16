# T0113 — Bootstrap decomposition (diagnostics contract first) — Design

Task: `T0113` (plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §T0113, spec
`docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §12.3).
Branch: `task/T0113-bootstrap-decomposition`.

## 0. The problem, stated precisely

`src/main.ts` is 1,656 lines. It was 1,094 when v2 started; eleven V2M1 tasks each added wiring to
it. It is simultaneously:

- the document contract (canvas, `#app`, the startup shell),
- the startup state machine (renderer → world → quality probe → menu → space activation),
- the owner of seven frozen `Object.defineProperty(canvas, 'solarVoyager*')` browser-diagnostic
  objects that roughly 25 CI gates read,
- the frame loop, with the sim/render/UI instrumentation seams telemetry is built on,
- and the composition root that hands every subsystem its ports.

This task splits it. **It is a behavior-preserving refactor: no new features, no behavior changes,
no opportunistic fixes.** Its entire value is that it can be verified by "everything still passes",
which means the verification has to be real — every browser gate, not a sample.

## 1. Why the contract test comes first

The diagnostics are the refactor's blast radius. They are read from Playwright by property name, in
`page.evaluate` callbacks that TypeScript never sees. Dropping a field, renaming one, or losing a
getter's `this` binding produces a gate failure hundreds of lines away from the cause — or, worse,
a silently passing gate, because most readers are *subsets*:

| Reader | What it pins |
|---|---|
| `tools/tests/mainMenuRegression.mjs` | the **only** `deepEqual` on `RuntimeResourceCounts` — two frozen literals, menu state and activated state, all 17 fields |
| `tools/tests/startupRegression.mjs` | 15 `solarVoyagerStartup` fields by name, plus `frozen` / `nullPrototype` / `readOnly`, plus `solarVoyagerShip.loadState` / `.resolved` |
| `tools/tests/shipVisualRegression.mjs` | `solarVoyagerShip.{modelOpacity,focused}`, `solarVoyagerCamera`, `RuntimeResourceCounts.shipVisualCreations` |
| `tools/tests/cameraControlsRegression.mjs`, `tools/tests/cameraWaits.mjs` | `solarVoyagerCamera.{mode,focusId,transitioning,distanceShipLengths,armDistanceKm,fovDeg,positionXKm…}` |
| `tools/tests/systemMapRegression.mjs` | `solarVoyagerSystemMap` (21 reads incl. object **identity** across mode changes) + `RuntimeResourceCounts` |
| `tools/tests/burnLogRegression.mjs` | `solarVoyagerBurnLog` incl. the `identity: 'solarVoyagerBurnLog.v1'` literal and object identity across a session replacement |
| `tools/tests/tutorialRegression.mjs` | `solarVoyagerTutorial.{status,stepId}`, `solarVoyagerBurnLog.activeAvailable` |
| `tools/tests/hudPresetsRegression.mjs` | `solarVoyagerCamera`, `solarVoyagerSystemMap`, `RuntimeResourceCounts` |
| `tools/smoke/applicationSmokeContract.mjs` | `RuntimeResourceCounts.animationLoopStarts` |

A subset reader cannot fail on a *dropped* field it does not happen to read. So the refactor needs
a gate that fails on the whole shape, in the fast unit lane, before any code moves.

`tests/architecture/diagnosticsContract.test.ts` is that gate. Constraints that shaped it:

1. **It must pass before the split and be unchanged after.** So it cannot name `src/main.ts`, and it
   cannot name `src/bootstrap/` either. It locates its subjects by *scanning* `src/**/*.ts`.
2. **It runs in Node, under Vitest.** Five of the six diagnostics need a `WebGLRenderer`, an
   `EpochWorld` and a live canvas to construct; they cannot be instantiated here at all.

So the test works at two levels:

- **Declaration level (all seven properties).** A lightweight TypeScript AST scan — `ts.createSourceFile`,
  no program, no type checker, no module resolution, so it costs milliseconds — finds each contract
  interface by name anywhere under `src/`, and asserts its member list as
  `readonly? name?: <declared type text>`, compared with `deepEqual` against a literal in the test.
  Declared type *text* rather than a checker-resolved type is deliberate: it keeps the literal types
  that are themselves contract (`identity: 'solarVoyagerBurnLog.v1'`, `mapSceneCreations: 1`) legible,
  and it keeps the test independent of module resolution.
- **Definition-site level.** The same scan finds every `Object.defineProperty(<expr>, 'solarVoyager…')`
  call in `src/` and asserts the set of property names is exactly the expected seven, each defined
  exactly once, each with a descriptor that is `{ value }`-only — no `writable`, no `configurable`,
  no `enumerable` — which is what makes them non-writable, non-configurable, and what
  `startupRegression`'s `readOnly` check observes from the browser.
- **Runtime level (the one constructible diagnostic).** `StartupDiagnostic` is produced by
  `StartupTracker.createDiagnostic()`, which is pure `game/` code with no DOM. The test builds one
  and asserts the own-property names, `Object.isFrozen`, the null prototype, that every descriptor
  is a non-configurable getter with no setter, and the `typeof` of every value in both the initial
  and the `ready` state. That is the exact discipline `startupRegression` verifies in Chromium,
  re-verified in 20 ms.

What the test deliberately does **not** cover, because something else already does it better:
the *values* of `RuntimeResourceCounts` in the menu and activated states (`mainMenuRegression`'s two
`deepEqual`s), and `solarVoyagerTelemetry`, which is defined by `src/render/telemetry.ts` behind
`RENDER_TELEMETRY_PROPERTY` and covered by `src/render/telemetry.test.ts`.

## 2. Where the modules go, and why not `game/bootstrap/`

The plan and `docs/architecture.md` both said `src/game/bootstrap/`. **That location is impossible**
and the architecture map is corrected in this PR.

`eslint.config.js` declares the zone

```js
{ target: './src/game', from: ['./src/render', './src/ui'],
  message: 'Game orchestration must not import from render or UI.' }
```

and it matches subdirectories. Verified empirically before committing to a layout: a one-line probe
at `src/game/bootstrap/probe.ts` importing `../../render/telemetry.js` fails
`import/no-restricted-paths`. The composition root's whole job is to import from `render/` **and**
`ui/` **and** `game/` **and** `sim/` and join them; it is by definition the one module that sits
outside the layering, which is exactly why `main.ts` has always lived at `src/` root rather than in
a layer directory.

Per `docs/coding-standards.md` — "If the linter blocks you, your design is wrong — do not disable
the rule" — the modules go to **`src/bootstrap/`**, a sibling of `main.ts`, sharing its
outside-the-layers position. `docs/architecture.md` and the plan §1 module map are updated in this
same PR, per the plan's naming rule ("if an implementing agent must deviate, they update this plan
file in the same PR").

```
src/
├── main.ts                    # document contract + one composition call
└── bootstrap/
    ├── diagnostics.ts         # the 7 canvas contract objects, and nothing else
    ├── frameLoop.ts           # renderFrame + the runtime state it shares with composition
    └── composition.ts         # startup ordering, ports, listeners, activation
```

## 3. What moves where

**`main.ts` (≈60 lines).** Imports, the four `document.querySelector` lookups with their exact
`throw new Error(...)` messages and instanceof guards, the `StartupLoadingElements` record, the
`./style.css` side-effect import, and `await startApplication({ canvas, appRoot, startupLoadingElements })`.
`index.html` still points at `/src/main.ts`. The module keeps its top-level `await`, so the entry
module's async evaluation semantics are unchanged.

**`bootstrap/diagnostics.ts`.** The seven contract objects and their types, moved verbatim:
`RuntimeResourceCounts`, `ShipRuntimeDiagnostics`, `CameraRuntimeDiagnostics`,
`SystemMapRuntimeDiagnostics`, `BurnLogRuntimeDiagnostics`, `MutableBurnLogDiagnosticEntry`,
`TutorialRuntimeDiagnostics`, plus `createDiagnosticEntry` / `copyDiagnosticEntry` and one
`define*` / `create*` function per property. Every getter body is transcribed character for
character; each factory takes the objects the getters close over today as parameters.

**`bootstrap/frameLoop.ts`.** `renderFrame`, unchanged statement for statement, plus the
`FrameLoopRuntime` interface (§4). `createFrameLoop(runtime)` returns the `renderFrame` callback;
the self-rescheduling `requestAnimationFrame(renderFrame)` tail stays inside it.

**`bootstrap/composition.ts`.** Everything else, in the same order: the startup tracker and its
diagnostic, the burn-log runtime `await`, the resource counters, the renderer `await`, telemetry and
the perf/HUD/state-vector/map/trajectory stores, the session controller and its two callbacks, the
tutorial controller, the `Commands` facade, the system-map controller, the pointer-lock and gamepad
browser adapters, the canvas pick/dblclick handlers, `resizeRenderer`, `prepareApplication`,
`activateSpacePhaseRuntime`, and the final `prepareApplication().catch(...)`.

## 4. The one structural change: `FrameLoopRuntime`

`main.ts` today is a set of closures over ~14 mutable module-level `let`s. Two files cannot share a
`let`. The mechanical translation is a single mutable object holding exactly the state the frame
loop and the composition root both touch:

```ts
export interface FrameLoopRuntime {
  readonly canvas: HTMLCanvasElement; readonly renderer: WebGLRenderer;
  readonly postProcessingEnabled: boolean; readonly telemetry: RenderTelemetry;
  readonly session: GameSessionController; readonly sceneManager: SceneManager;
  /* …the const dependencies… */
  world: EpochWorld | null; postPipeline: LightingPostPipeline | null;
  relativisticVisuals: RelativisticVisualController | null;
  stateVectorWidget: StateVectorWidget | null;
  inputEngine: InputEngine | null; flightController: FlightController | null;
  flightInputRouter: FlightInputRouter | null; hudInputRouter: HudInputRouter | null;
  perfGovernor: PerfGovernor | null;
  systemMapDiagnostics: SystemMapRuntimeDiagnostics | null;
  trajectoryPredictorClient: TrajectoryPredictorClient | null;
  trajectoryPredictionPending: boolean;
  tutorialFrameObserver: ((snapshot: SimSnapshot) => void) | null;
}
```

Field names match the variables they replace, so the diff reads `world` → `runtime.world`. Three
properties of this choice matter:

- **It allocates nothing per frame.** One object, created once at composition time; the loop does
  monomorphic property reads. The heap gate (≤ 196,608 B / 30 s) and `npm run bench` confirm it.
- **Narrowing is preserved by local binding.** `renderFrame` opens by copying the four
  null-checked references into `const` locals before the early-return guard, so the ~120 statements
  after it are textually identical to today's. Stack slots, not allocations.
- **State the frame loop never reads stays local to `composition.ts`** — `cameraInput`,
  `systemMapCameraInput`, `runtimeDisposed`, `spacePhaseActivation`, `startupFailed`,
  `trajectoryPredictionComplete`, `sceneHalted`, `pauseRequestCount`, the click-pick pointer
  fields. Widening the shared object beyond what is genuinely shared would be the opposite of the
  point.

## 5. Invariants transcribed, not re-derived

Enumerated here because each one is a place where "tidying while moving" would silently break a gate.

1. **Startup ordering.** `solarVoyagerStartup` is defined *before* the burn-log chunk `await`, so a
   failed `burnLogRuntime-*.js` still produces a readable `stage: 'failed'`, `failedStage: 'boot'`
   diagnostic — `startupRegression.runRecoverableBootstrapFailure` asserts exactly that.
   `solarVoyagerRuntimeResources` is defined *after* that await and *before* the renderer await.
   `canvasBindings` is incremented at its definition site, before anything else can count.
2. **The measured state machine.** `StartupTracker.move()` throws unless milestones arrive in order
   (`context → star-catalog → asset-manifest → hero-spheres → flight-shaders → map-shaders →
   quality → post-ready → ready`). `advance('context')` fires right after the session controller is
   built; the middle six come from `createEpochWorld`'s `onProgress`; `recordQuality` and
   `advance('post-ready')` and `recordReady` are the tail of `prepareApplication`. Each is followed
   by `updateStartupLoadingView` and `canvas.dataset.startupStage = startupTracker.stage`.
3. **Instrumentation seams.** `telemetry.beginFrame(nowMs)` → `simulationStartMs` → input poll +
   `session.simulation.step` + predictor → `simulationEndMs` (which is *also* `uiStartMs`) → HUD
   stores → `hudEndMs` → `renderStartMs` → camera + scene + `postPipeline.render` → `renderEndMs` →
   perf-panel publish → `telemetry.endFrame(sim, render, ui + perfPanel, nowMs)`. The `uiStartMs =
   simulationEndMs` aliasing and the summed UI term are preserved literally.
4. **Pause halt semantics (T0112).** `halted = sceneManager.state !== 'space'`; `simDeltaSec = 0`
   when halted; the step is skipped and the previous snapshot reused; `restorePoints.update` gets
   `simDeltaSec` while everything else gets `deltaSec`; `cameraDirector.update` gets `simDeltaSec`;
   rAF keeps running. The T0112 input gate — the whole poll/route/`flightController.update` block
   behind `!halted` — moves with it.
5. **`programCountAfterFirstFrame`.** Recorded at the tail of `renderFrame` on the first frame only;
   `test:startup` asserts it equals `programCountAtReady`.
6. **`data/initial-path.json` stays four files.** Nothing about the split adds a fetch; the
   `import('./ui/burnLogRuntime.js')` dynamic import keeps its own chunk, which the bootstrap-failure
   gate routes by filename glob.
7. **Diagnostic object identity.** `systemMapRegression` and `burnLogRegression` stash the object
   and assert it is the same reference later. The factories create exactly one instance each, at the
   same point in the sequence as today.
8. **Focus-label DOM contract.** `#camera-focus-label` is resolved inside `activateSpacePhaseRuntime`
   and throws if absent; `writeCameraFocusLabel` re-queries per call. Unchanged.

## 6. Considered and rejected

**Keep the frame loop in `main.ts`.** It is the largest single block and the one with a documented
bench requirement, so leaving it behind would leave `main.ts` around 300 lines and defeat the
acceptance criterion. Rejected.

**Pass the mutable state as getter closures instead of a shared object.** Equivalent at runtime and
allocation-free, but it needs ~14 arrow functions defined in `composition.ts` purely to be read from
`frameLoop.ts`, which is more code and a worse diff than `runtime.x`. Rejected.

**Split further (a fourth `viewport.ts` for `resizeRenderer` / `updateStateVectorViewport`).**
Tempting — `composition.ts` lands around 800 lines, above the 300-line smell threshold in
`docs/coding-standards.md` — but the plan names exactly three modules, and adding a fourth in a
behavior-preserving task means one more set of dependency wiring to get wrong for no verification
benefit. The composition root is the one file whose length is a function of how many subsystems the
game has; it is not a "one concept per file" violation, it *is* the concept. Noted as follow-up
material for whichever v2 task next adds a subsystem to it, not done here.

**Use the TypeScript checker in the contract test.** `checker.typeToString` on
`SystemMapRuntimeDiagnostics['scene']` expands `EpochWorld['systemMap']['diagnostics']` into a large
structural type, and building a program pulls in three.js's declarations — seconds per run, in the
fast lane, for a less readable assertion. Declared type text is exact and free. Rejected.

## 7. Verification plan

`npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`, then
**every** browser gate in `package.json`, one at a time — concurrent headless Chromium on this
machine produces spurious failures. Plus `npm run bench` before/after into
`docs/bench/T0113-summary.md`, because the frame loop moved. Full results in the task report.
