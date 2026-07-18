# T0080 State-Vector Widget Implementation Plan

> Execute with test-driven development and stop to correct any failed gate before moving on.

**Goal:** Deliver the spec-complete, allocation-free bottom-right 3D state-vector widget using the existing snapshot analysis fields.

**Architecture:** Pure render-model math feeds a preallocated Three.js inset scene and a sampled Preact signal/readout layer. `main.ts` owns lifecycle and ordered rendering with the existing renderer.

**Tech stack:** TypeScript, Three.js `Line2`, Preact Signals, Vitest, Playwright, Vite.

---

### Task 1: Logarithmic model and SI labels

**Files:**
- Create: `src/render/stateVectorModel.ts`
- Create: `src/render/stateVectorModel.test.ts`

1. Write failing tests for 30 km/s, 0.99c, monotonic log scaling, direction preservation, zero/non-finite hiding, and SI labels for v/a/p/L.
2. Run the focused test and confirm the intended failures.
3. Implement only the typed-array writer, scale constants, and formatters needed by the tests.
4. Re-run the focused test, lint, and typecheck.
5. Commit as `feat(render): [T0080] add state-vector model`.

### Task 2: Preallocated scissored renderer

**Files:**
- Create: `src/render/stateVectorWidget.ts`
- Create: `src/render/stateVectorWidget.test.ts`

1. Write failing tests for one-time resources, buffer mutation, viewport/scissor calculations, renderer-state restoration, camera-follow, fixed-ecliptic orientation, and disposal.
2. Confirm the focused failures.
3. Implement the orthographic scene, grid/axes, four `Line2` instances, glow tips, viewport cache, update/render methods, and scalar cost sample.
4. Verify no resource construction or object/array literal occurs in hot methods.
5. Re-run focused tests, lint, typecheck, and commit as `feat(render): [T0080] render scissored vector widget`.

### Task 3: Sampled signals and DOM panel

**Files:**
- Create: `src/ui/stateVectorSignals.ts`
- Create: `src/ui/stateVectorSignals.test.ts`
- Create: `src/ui/StateVectorPanel.tsx`
- Create: `src/ui/StateVectorPanel.test.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/app.css`

1. Write failing tests for 10 Hz sampling, all six readouts, pin toggle, accessible legend, and panel-rectangle callback.
2. Confirm failures, then implement the smallest signal store and component.
3. Add desktop and responsive styles without changing per-frame layout properties.
4. Run focused UI tests, lint, typecheck, and commit as `feat(ui): [T0080] add vector instrument panel`.

### Task 4: Frame-loop integration and telemetry

**Files:**
- Modify: `src/main.ts`
- Modify: `src/render/telemetry.ts`
- Modify: `src/render/telemetry.test.ts`
- Modify: `src/render/createEpochWorld.ts` only if startup precompile ownership is clearer there

1. Write failing telemetry/integration tests for widget cost publication and lifecycle wiring.
2. Construct the widget at startup, precompile it, publish snapshots at 10 Hz, update it from the current snapshot, and render after the main post chain.
3. Cache panel bounds on resize/scroll and connect the orientation signal without closure creation in the frame loop.
4. Run focused tests and the heap-growth gate, then commit as `feat(app): [T0080] integrate state-vector instrument`.

### Task 5: Browser regression and performance evidence

**Files:**
- Create: `tools/tests/stateVectorWidgetRegression.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/bench/T0080-summary.md`

1. Add a browser regression that checks rendered widget pixels, the ~30 km/s LEO label, gamma/%c, pin behavior, console cleanliness, and warm p75 widget cost.
2. Run the regression against an intentionally missing/incomplete hook and confirm failure before final wiring.
3. Run the finished regression on hardware acceleration and capture exact adapter, resolution, samples, and p75.
4. Run paired `npm run bench` on `origin/main` and the feature head on the same adapter and record all results and limitations.
5. Run `npm run test:perf-gates` to prove heap/draw gates remain green.
6. Commit as `test(render): [T0080] verify vector widget in browser`.

### Task 6: Full verification and delivery

**Files:**
- Modify: `tasks/T0080-state-vector-widget.yaml`

1. Run formatting, lint, typecheck, all Vitest/Python/browser tests, build, budgets, asset checks that do not rewrite files, task schema, and `git diff --check`.
2. Use the `playtest` skill for a real game session and visually inspect both orientation modes from LEO.
3. Use verification-before-completion and requesting-code-review; resolve findings with focused regressions.
4. Rebase on current `main`, re-run affected and full gates, set T0080 to `REVIEW`, and write evidence-rich handoff notes.
5. Push and open `[T0080] Bottom-right 3D state-vector widget`; include every acceptance criterion and before/after benchmark evidence.
6. Delegate independent review. Only the reviewer may approve, set `DONE`, and merge after exact-head CI passes.
