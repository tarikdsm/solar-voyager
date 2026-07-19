# T0096 Main Menu and New-Game Flow Plan

**Goal:** Deliver the canonical accessible `MainMenu -> SpacePhase` v1 start
without duplicate runtime resources or regressions in direct-play harnesses.

**Architecture:** A pure game-layer scene manager coordinates atomic session
operations. Preact renders menu or HUD. Main owns a one-shot runtime activation
boundary; explicit `?autostart=1` keeps existing browser/performance harnesses
deterministic while the normal URL proves the menu.

## Global constraints

- Do not change `SimSnapshot`, `Commands`, physics, catalog schemas, or goldens.
- Normal production URL must stop in MainMenu until a successful user action.
- New Game must construct the canonical 400 km LEO state.
- Failed/invalid Continue or Import must not enter SpacePhase.
- Runtime activation is exactly once; frame-loop and GPU allocation contracts
  remain unchanged.
- Preserve the user's dirty root checkout; edit only this worktree.

### Task 1: Pure phase and session contracts

**Files:** `src/game/sceneManager.ts`, tests, `sessionController.ts`, tests.

- [x] Write RED tests for phase transitions, repeated activation, atomic New
  Game replacement, and valid/missing/invalid Continue availability.
- [x] Implement the minimal game-layer contracts without DOM/three.js imports.
- [x] Run focused and full unit tests, lint, and typecheck.
- [x] Commit the game-layer boundary.

### Task 2: Accessible MainMenu component

**Files:** `src/ui/MainMenu.tsx`, tests, `App.tsx`, `SessionSettingsPanel.tsx`,
`app.css`.

- [x] Write RED component/model tests for New Game, disabled Continue, errors,
  successful load/import activation, keyboard focus, and repeated events.
- [x] Implement menu-vs-HUD rendering and accessible responsive styling.
- [x] Verify reduced motion and session/settings availability.
- [x] Commit the UI boundary.

### Task 3: Bootstrap, browser regression, and dashboard

**Files:** `src/main.ts`, production harness URLs, new browser regression,
`package.json`, CI, `docs/check_plan.html`, task YAML.

- [x] Write a RED real-browser test proving a fresh normal URL shows MainMenu,
  Continue is disabled, and no simulation frames advance before New Game.
- [x] Add idempotent SpacePhase activation and explicit autostart policy; update
  existing production harness URLs to opt in.
- [x] Cover New Game canonical LEO, valid/invalid Continue, reload, compact
  viewport, reduced motion, one canvas/runtime/listener set, and console errors.
- [x] Reconcile T0096-T0101 in the dashboard exactly once and remove converted
  non-task actions.
- [x] Run all repository, browser, performance, schema, budget, and diff gates.
- [x] Obtain independent exact-head review, move to REVIEW, publish, require CI,
  move to DONE, require final CI, and merge while retaining the branch.
