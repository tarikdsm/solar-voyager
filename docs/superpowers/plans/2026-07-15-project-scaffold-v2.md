# Project Scaffold V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver T0001 as the first gate of the complete Solar Voyager roadmap, including reproducible pre/post renderer performance evidence.

**Architecture:** Establish the Node/Vite toolchain and a benchmarkable 2D canvas baseline first. Then add strict layer boundaries, Three.js setup, Preact UI, and an allocation-free frame loop; rerun the identical benchmark after the renderer so the PR contains actual before/after numbers.

**Tech Stack:** Node.js 22, npm, Vite, TypeScript strict, Three.js, Preact, `@preact/signals`, Vitest, ESLint flat config, Prettier, Playwright Chromium.

## Global Constraints

- Vite base is exactly `/solar-voyager/`.
- TypeScript targets ES2022 with `strict: true` and no `any`.
- Import direction is `core <- sim <- game <- render/ui`.
- `src/core` and `src/sim` contain no Three.js, DOM, globals, I/O, or side effects.
- Renderer requests `powerPreference: "high-performance"`; full fallback policy remains T0045.
- No application allocations, geometry/material creation, or shader compilation in the frame loop.
- `npm run lint`, `typecheck`, `test`, `build`, and `format:check` must all exit 0.
- Benchmark reports are committed under `docs/bench/`; identical measurement code is used before and after Three.js.

---

### Task 1: Toolchain and baseline-aware formatting

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, and `index.html`.

- [ ] Add runtime dependencies `three`, `preact`, `@preact/signals`; add compatible Vite/Preact, TypeScript, Vitest, ESLint, Prettier, TypeScript ESLint/import resolver, globals, Three types, and Playwright dev dependencies.
- [ ] Define scripts `dev`, `build`, `test`, `lint`, `typecheck`, `format:check`, and `bench:scaffold`.
- [ ] Configure strict ES2022/Bundler/Preact TypeScript and a valid composite Node config; run `npm run typecheck` and reject TS configuration errors.
- [ ] Configure `import/no-restricted-paths` with TypeScript resolution.
- [ ] Make `.prettierignore` baseline-aware: exclude pre-existing asset/generated/legacy documentation areas, but keep all T0001-created source/config/tests, its task YAML, and both T0001 plans checked.
- [ ] Run scoped Prettier and commit `chore: [T0001] configure benchmark-ready toolchain`.

### Task 2: Measurable pre-Three.js baseline

**Files:** Create `src/main.ts`, `src/style.css`, `tools/bench/scaffoldBench.mjs`, `docs/bench/T0001-before.json`.

- [ ] Implement a minimal full-viewport 2D canvas with static `Solar Voyager` heading and one module-level rAF callback rotating a simple blue square; no Three.js import.
- [ ] Implement `scaffoldBench.mjs`: start the built preview server, open Chromium at `/solar-voyager/`, wait 120 warmup frames, collect 600 rAF deltas, report median/p75/p99, canvas size, console/page errors, and `performance.memory` heap delta when exposed; fail on console/page errors.
- [ ] Run lint/typecheck/test/build/format gates, then `npm run bench:scaffold -- --output docs/bench/T0001-before.json` twice; require less than 5% p75 variance.
- [ ] Commit baseline source, harness, and report as `perf: [T0001] record pre-Three.js baseline`.

### Task 3: Layer boundaries and automated rejection test

**Files:** Create `src/core/appInfo.ts`, `src/sim/scaffoldState.ts`, `src/game/createScaffoldState.ts`, `tests/architecture/importBoundaries.test.ts`.

- [ ] Write the architecture test first using `ESLint.lintText` with a virtual `src/sim` filename and only a valid temporary render target on disk; concurrent `eslint .` must never observe an intentionally invalid file.
- [ ] Assert rule id `import/no-restricted-paths` for an extensionless `sim -> render` import and cleanup safely in `finally`.
- [ ] Add `APP_TITLE`, readonly `ScaffoldState`, and `createScaffoldState()` without DOM/Three imports in core/sim.
- [ ] Run focused test concurrently with lint, then all tests/typecheck/format; commit `test: [T0001] enforce module import direction`.

### Task 4: Three.js renderer and setup-only scene

**Files:** Create `src/render/createRenderer.ts`, `src/render/createPlaceholderScene.ts`, `src/render/placeholderScene.test.ts`.

- [ ] Write failing tests for exactly one mesh, ambient light, directional light; camera Z nonzero; returned cube identity; `matrixAutoUpdate === false`.
- [ ] Implement renderer with canvas, high-performance preference, antialias/stencil/alpha/preserveDrawingBuffer false, and pixel ratio capped at 2.
- [ ] Create geometry/material/lights once during setup and call initial matrix update.
- [ ] Run focused/all tests, lint, typecheck, format; commit `feat(render): [T0001] add placeholder Three.js scene`.

### Task 5: Preact overlay and allocation-free bootstrap

**Files:** Create `src/ui/App.tsx`, `src/ui/app.css`; replace baseline `src/main.ts` and update `src/style.css`/`index.html`.

- [ ] Keep canvas and Preact root as siblings; accessible state-derived `h1`; pointer-transparent static overlay; inline favicon prevents browser 404.
- [ ] Create renderer/scene once. Use module-level named resize/frame/startup callbacks; steady-state frame path mutates scalars, updates matrix, renders, and reschedules the same callback.
- [ ] Run `renderer.compileAsync(scene, camera)` before the first rAF and surface startup failure clearly.
- [ ] Resize only on drawing-buffer mismatch, call `setSize(..., false)`, then update camera aspect/projection.
- [ ] Run all gates and production build; verify `/solar-voyager/assets/` URLs; commit `feat(ui): [T0001] bootstrap Solar Voyager placeholder`.

### Task 6: Post-render benchmark and delivery

**Files:** Create `docs/bench/T0001-after.json`; modify `tasks/T0001-project-scaffold.yaml`; update PR evidence.

- [ ] Run the identical `bench:scaffold` twice against final build; require less than 5% p75 variance and commit median/p75/p99, canvas, heap delta, and errors.
- [ ] Compare before/after reports in `docs/bench/T0001-summary.md`; explain render cost, bundle size, and any unavailable browser metric without inventing values.
- [ ] Run fresh lint, typecheck, tests, build, format check, architecture test, and browser screenshot/console gate.
- [ ] Change T0001 to REVIEW only after all gates pass; commit `chore(tasks): [T0001] ready for review`, push v2, and open a new PR.
- [ ] A different agent reviews the full branch and, only if approved with CI green, merges while flipping T0001 to DONE.
