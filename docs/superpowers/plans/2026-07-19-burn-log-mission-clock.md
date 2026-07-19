# T0098 Burn Log and Mission Clock Implementation Plan

**Goal:** expose the canonical burn ledger and UTC mission time through an
accessible, bounded, allocation-conscious HUD panel without changing protected
simulation interfaces or persistence schema.

## Task 1: Store and shared formatting

- [x] Add RED tests for empty, active, completed, wrapped-capacity, exact newest
  fields including body, the 257th burn, a short burn entirely between samples,
  empty no-step taps, immediate simulation replacement, relativistic UTC/proper
  divergence, signed axes, stable identities, and no history walk on unchanged
  publishes.
- [x] Implement shared burn formatters and `BurnLogSignalStore` with 256
  preallocated completed slot graphs, a stable active graph, indexed event-only
  ring copies, and explicit synchronous `rebind()`.
- [x] Run focused tests, full unit, lint, typecheck, format, diff-check.
- [x] Independent review: layering, ring correctness, persistence assumptions,
  mutation/identity behavior, and hot-path allocation/iteration.

## Task 2: Accessible panel and responsive layout

- [x] Add RED component tests for collapsed/expanded, empty/active/completed,
  labels, bounded 256 rows, ArrowUp/ArrowDown/Home/End, Escape focus return, and
  no flight command when those keys are rebound and focus is on row buttons.
- [x] Implement `BurnLogPanel`, wire it through `App`, clarify the dual clock's
  mission-UTC label, and add desktop/compact/reduced-motion styles.
- [x] Add a focused Chromium component regression for real focus and computed
  layout: bounding boxes, no horizontal overflow, usable vertical scroll, and
  zero transition duration under reduced motion; run component/unit/static gates.
- [x] Independent review: accessibility, focus lifecycle, list ordering,
  compact overflow, and absence of frame-loop DOM work.

## Task 3: Runtime, persistence, browser, and delivery

- [x] Add RED integration/browser coverage for a real scripted burn appearing
  within one HUD update via `page.keyboard`, active-to-completed transition,
  equality of every field against raw-core diagnostics, real Save/reload/
  Continue restoration, fixed diagnostic identity, and unchanged structural
  rebuild count across ordinary frames and multiple unchanged HUD commits.
- [x] Instantiate/rebind/publish the store in `main.ts`, expose fixed in-place
  raw-core diagnostics, add permanent package command and workflow CI step, and
  update `docs/architecture.md` to document this bounded direct BurnLogView UI
  read plus task handoff/acceptance evidence.
- [x] Run full unit/static/build/budgets/schema, affected browser suites,
  production heap/performance gates with before/after bench evidence, and
  desktop/compact playtest screenshots.
- [ ] Independent final review C0/I0/M0; mark plan complete, move task to REVIEW,
  open PR with acceptance evidence, obtain exact-head CI, move to DONE, rerun CI,
  and merge non-force while retaining the branch.
