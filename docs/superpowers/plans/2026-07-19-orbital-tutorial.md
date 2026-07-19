# T0099 Orbital Navigation Tutorial — Implementation Plan

> Follow the repository task protocol, TDD for every behavior change, and independent review before delivery.

## 1. Version profile settings without changing save v2

- Add failing tests in `src/game/settings.test.ts`, `src/game/saveLoad.test.ts`, and `src/game/sessionController.test.ts` for:
  - missing profile -> v2 `unoffered` default;
  - v1 profile -> v2 `skipped` migration;
  - strict/frozen v2 parsing and invalid tutorial rejection;
  - save JSON still contains the v1 preferences DTO;
  - load/import merges preferences but preserves tutorial progress;
  - atomic persistence failure.
- Implement v2 profile types, parser, repository fallback, v1 projection/merge helpers, and session tutorial update.
- Update benchmark/browser settings helpers and architecture persistence documentation.
- Run focused tests, typecheck, lint, and format.

## 2. Build the event-driven tutorial state machine

- Add `src/game/tutorialController.test.ts` first for the complete sequence, out-of-order observations, persistence rejection, skip/resume/reset, conditional performance route, and terminal observer behavior.
- Implement `src/game/tutorialController.ts` with no DOM, Preact, simulation mutation, or timers.
- Expose stable state subscription and primitive observation methods.
- Run focused unit tests and static checks.

## 3. Add real keyboard camera access and observable UI seams

- Extend camera tests first for Arrow/Page Up/Page Down controls, editable-target suppression, and interaction callbacks.
- Add focused tests for burn-log expansion, F3/click performance expansion, hardware-warning acknowledgement, and successful save notification.
- Implement narrow optional callbacks without changing behavior for existing callers.
- Run focused tests and regressions for camera, burn log, performance, and session settings.

## 4. Render accessible offer, tutorial, resume, and reset UI

- Add `TutorialOverlay` component/model tests first for every step, enabled/disabled acknowledgement, focus behavior, skip, completion, keyboard semantics, and hidden terminal states.
- Add tutorial controls/status to `SessionSettingsPanel` and thread the optional port through `MainMenu` and `App`.
- Add compact and reduced-motion CSS.
- Run component tests, snapshots/DOM assertions, typecheck, lint, and format.

## 5. Wire bootstrap observations and diagnostics

- Wire command, camera, map, 10 Hz state, burn log, performance, warning, and save callbacks to the controller after the underlying real action succeeds.
- Add a stable `canvas.solarVoyagerTutorial` diagnostic and nullable active observer.
- Prove no protected contracts changed and no post-completion frame allocations are introduced.
- Run all unit tests plus existing browser regressions touched by the wiring.

## 6. Add permanent real-browser guided regression

- Write `tools/tests/tutorialRegression.mjs` against a production build and real main-menu entry.
- Cover full guided completion, reload persistence/no overlay, skip/resume/reset, keyboard-only camera/flight controls, compact 360x480, reduced motion, conditional hardware warning, and zero console/page errors.
- Add `test:tutorial` and a bounded CI step.
- Run the new regression at least twice locally to detect flakiness.

## 7. Verify, review, and deliver

- Run format, lint, typecheck, all Vitest tests, build, performance gates, application smoke, and all affected browser regressions.
- Run independent acceptance/code review and fix all critical/important findings.
- Update the task to `REVIEW`, commit with repository conventions, push, open `[T0099] Orbital-navigation tutorial overlay`, and include evidence for each acceptance criterion.
- Require exact-head green CI, update task to `DONE`, merge without force, and retain the branch/worktree per repository policy.

