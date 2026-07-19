# T0101 public v1 release — implementation plan

> **For Codex:** execute each step in this worktree with test-driven development,
> preserve task protocol transitions, and stop publication if any exact-head or
> live-deploy evidence is not green.

## 1. Lock release and dashboard contracts

- Add failing Node tests for `tools/checks/taskDashboard.mjs` covering canonical
  YAML loading, stable task order, duplicate/malformed rejection, marker-only
  replacement and check-mode drift detection.
- Implement exported pure helpers plus a CLI with explicit `--write`; add
  `generate:dashboard` and `check:dashboard` scripts.
- Replace the dashboard's parallel `TASKS`/override blocks with one generated
  payload between stable markers and derive footer counts at runtime.
- Add failing tests for `tools/checks/releaseReadiness.mjs`, then implement checks
  for package version, required files, README local links, canonical allowed task
  states and exact dashboard equality. Add `check:release` to CI.

Expected public shapes:

```js
export function loadCanonicalTasks(tasksDirectory) {}
export function renderDashboard(source, tasks) {}
export function verifyReleaseReadiness(repositoryRoot, options = {}) {}
```

## 2. Make the loaded menu the public landing

- Extend `src/ui/MainMenu.test.tsx` first with failing assertions for the public
  title, truthful mission facts, quick-start content, action order and preserved
  accessible settings/status behavior.
- Extend `tools/tests/mainMenuRegression.mjs` first for desktop and compact
  viewports, overflow, focus visibility, keyboard launch, readiness state and
  zero console/page errors.
- Update `src/ui/MainMenu.tsx` and `src/ui/app.css` with semantic text-only hero,
  facts and quick controls. Keep New Game/Continue as the first actionable
  control and preserve all existing session callbacks.
- Run focused Vitest and browser regressions before the broader suite.

## 3. Materialize the public v1 documentation

- Rewrite `README.md` as the player/contributor entry point.
- Add `LICENSE`, `docs/controls.md`, `docs/privacy.md`,
  `docs/accessibility.md`, `docs/credits.md` and `docs/release-notes.md`.
- Set `package.json` and `package-lock.json` to version `1.0.0` without publishing
  the private package.
- Generate the canonical dashboard and run both release checks.

## 4. Prove the release candidate locally

- Run Prettier, ESLint, both TypeScript projects, the complete Vitest suite and
  Python tool suite.
- Run the production build twice and compare artifact hashes; run task, asset,
  bundle, heap, simulation and every browser/render/performance regression gate.
- Serve `dist/` under the production base path and use a real Chromium session
  at desktop and compact sizes to launch the game, exercise keyboard controls,
  save/continue, settings and system-map paths, capturing screenshots and all
  network/console/page errors.
- Record final benchmark/browser evidence under `docs/bench/` and update task
  handoff notes without raising a budget.

## 5. Review, integrate and publish the exact artifact

- Commit atomic changes using the repository's Conventional Commits format,
  transition T0101 to REVIEW and push the exact head.
- Obtain an independent C/I/M review and require every CI job on that exact SHA.
- Address findings with tests, re-review changed code, transition T0101 to DONE,
  and merge while retaining branch/worktree.
- Require green CI and Pages deploy on the merge SHA. Audit the canonical live URL
  with cache disabled and verify no missing assets or console/page errors.
- Create `git tag -a v1.0.0 <merge-sha>` only then, push it, fetch/inspect the
  remote tag object and prove its peeled commit equals the deployed green SHA.
