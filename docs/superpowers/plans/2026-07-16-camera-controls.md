# T0044 Camera Controls Implementation Plan

## 1. Specify controller behavior with failing tests

- Create `src/game/orbitCameraController.test.ts`.
- Test initial camera preservation, normalized orbit direction, pitch clamp,
  surface/system zoom limits, smooth Earth-to-Jupiter transfer, interrupted
  transfer continuity, live destination movement, and repeated minimum-zoom
  stability at heliocentric coordinates.

## 2. Implement the float64 game-layer controller

- Create `src/game/orbitCameraController.ts`.
- Validate setup-time targets and packed offsets.
- Preallocate camera, focus, look direction, and transition state.
- Implement allocation-free update, orbit, zoom, focus cycling, and direct
  focus APIs.

## 3. Integrate browser controls and production world

- Extend `EpochWorld` with the controller and target catalog.
- Create a disposable `src/ui/cameraInputController.ts` with pointer, wheel,
  cycle, Earth, and Jupiter controls.
- Update `src/main.ts` to advance and orient the camera before render work.
- Update the Preact overlay and CSS with concise controls and current focus.
- Extend world and UI tests before each production change.

## 4. Add real-browser acceptance regression

- Create `tests/render/cameraControlsPage.ts` and HTML fixture.
- Create `tools/tests/cameraControlsRegression.mjs`.
- Verify Earth-to-Jupiter screen-space samples are finite and continuous, the
  final target is Jupiter, and repeated surface-skimming frames do not jitter.
- Add the regression script to `package.json` and CI.

## 5. Verify performance and deliver

- Record before/after benchmark evidence in `docs/bench/T0044-summary.md`.
- Run formatting, lint, typecheck, unit tests, browser regressions, task schema,
  budgets, and production build.
- Rebase, set T0044 to `REVIEW`, push, and open a PR with acceptance evidence.
- Obtain review from a different agent; address findings, require green CI,
  mark T0044 `DONE`, and merge.
