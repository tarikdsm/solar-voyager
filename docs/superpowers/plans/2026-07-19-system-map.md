# T0097 Interactive System Map Implementation Plan

**Goal:** Deliver a live, accessible, camera-relative system map without
duplicating simulation, renderer, listeners, or frame-loop allocations.

**Architecture:** A pure game-layer view controller selects one of two
preallocated camera-relative render scenes. Preact owns the accessible map
panel; `main.ts` keeps one simulation/predictor and renders exactly one scene per
frame.

## Global constraints

- Do not change `SimSnapshot`, `Commands`, `bodies.json`, physics formulas, or
  save schemas.
- Use the same renderer, snapshot, target command, predictor worker, and
  telemetry source.
- Create/compile all map GPU resources before the frame loop.
- Keep every frame and toggle free of resource creation and listener churn.
- Preserve the dirty root checkout; work only in this isolated worktree.

### Task 1: Pure view-mode and input gates

**Files:** `src/game/systemMapController.ts`, tests,
`src/ui/cameraInputController.ts`, tests.

- [x] Write RED tests for open/close/toggle idempotence, validated focus,
  callbacks, and unchanged focus on invalid ids.
- [x] Add an enabled gate to the existing camera input controller and prove
  disabled pointer/wheel/keyboard events have no effects or preventDefault.
- [x] Prove repeated toggles do not install/remove listeners or allocate new
  controllers.
- [x] Run focused tests, lint, and typecheck; obtain independent review.

### Task 2: Preallocated camera-relative map scene

**Files:** `src/render/spaceScene.ts`, tests,
`src/render/systemMapScene.ts`, tests, `src/render/createEpochWorld.ts`,
`docs/architecture.md`, `docs/rendering-spec.md`.

- [x] Write RED tests for generic packed line positions at inner/outer scales,
  one icon draw, one orbit-line draw, live parent anchoring, fixed resources,
  focus framing, selection highlighting, and shared trajectory resources.
- [x] Implement setup-time orbit sampling through existing orbital conversion,
  fixed-pixel icon shaders, one batched line resource, map camera, diagnostics,
  resize/update/render/dispose boundaries, and dynamic map chunk loading.
- [x] Precompile every map shader/resource and prove repeated updates preserve
  object/material/geometry/buffer identity with zero update-time allocations.
- [x] Run focused render tests, lint, typecheck, build, and an allocation check;
  obtain independent review.

### Task 3: Accessible map panel and shared navigation state

**Files:** `src/ui/systemMapSignals.ts`, tests,
`src/ui/SystemMapPanel.tsx`, tests, `src/ui/App.tsx`, `src/ui/app.css`.

- [x] Write RED tests for button/M/Escape toggles, labeled body selection,
  target/focus sharing, prediction text, keyboard focus, compact scrolling,
  reduced motion, and no duplicate keyboard effect.
- [x] Implement the signal adapter and always-mounted accessible panel without
  rerendering the main HUD on frame updates.
- [x] Hide non-map HUD surfaces while active, retaining performance and warning
  surfaces, and make return focus deterministic.
- [x] Run component tests, lint, typecheck, and format; obtain independent
  review.

### Task 4: Bootstrap, render switching, browser/performance delivery

**Files:** `src/main.ts`, browser regression, `package.json`, CI,
`docs/check_plan.html`, task YAML.

- [x] Write a RED browser regression for preallocated resources, repeated
  toggles, advancing sim time, inner/outer focus, target sharing, prediction
  markers, deterministic return, compact/reduced-motion behavior, and console
  errors.
- [x] Wire both cameras/input controllers, one worker result into both
  trajectory overlays, resize handling, dataset/diagnostics, and exactly-one
  scene render per frame.
- [x] Add the permanent CI command and preserve all direct-play harnesses.
- [x] Run full unit/static/build/browser/performance/budget/schema/diff gates
  plus an in-app real-browser playtest with screenshots and console inspection.
- [x] Obtain independent exact-head review, move to REVIEW, publish, require CI,
  move to DONE, require final CI, merge without force, and retain the branch.
