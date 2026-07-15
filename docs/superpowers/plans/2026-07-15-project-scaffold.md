# Project Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver T0001: a strict Vite/TypeScript/Three.js/Preact scaffold whose lint, typecheck, unit tests, production build, layering guard, and placeholder WebGL scene all work.

**Architecture:** `src/main.ts` owns bootstrap and the animation loop, `src/render/createRenderer.ts` owns the initial high-performance WebGL renderer, and `src/ui/App.tsx` owns the Preact overlay. Pure placeholder modules in `src/core`, `src/sim`, and `src/game` establish the enforced dependency direction `core <- sim <- game <- render/ui` without introducing future physics interfaces.

**Tech Stack:** Node.js 22, npm, Vite, TypeScript strict mode, Three.js, Preact, `@preact/signals`, Vitest, ESLint flat config, `eslint-plugin-import`, Prettier.

## Global Constraints

- Vite base is exactly `/solar-voyager/`.
- TypeScript targets ES2022 with `strict: true` and no `any`.
- `src/core` and `src/sim` contain no Three.js, DOM, or side effects.
- Import direction is `core <- sim <- game <- render/ui`; ESLint must reject `sim -> render`.
- Renderer requests `powerPreference: "high-performance"`; the complete fallback policy remains T0045 scope.
- The frame loop performs no per-frame object, array, closure, geometry, or material creation.

---

### Task 1: Package and toolchain configuration

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`

**Interfaces:**

- Consumes: Node.js 22 and npm.
- Produces: `npm run dev`, `build`, `test`, `lint`, `typecheck`, and `format:check`.

- [ ] **Step 1: Create the package manifest**

  Define `type: "module"`, scripts using `vite`, `vitest run`, `eslint .`, `tsc --noEmit`, and `prettier --check .`; add runtime dependencies `three`, `preact`, and `@preact/signals`; add current compatible Vite, TypeScript, Vitest, ESLint, Prettier, `typescript-eslint`, `eslint-plugin-import`, and Three.js types as development dependencies.

- [ ] **Step 2: Install and lock dependencies**

  Run: `npm install`

  Expected: exit 0 and a new `package-lock.json` using lockfile version 3.

- [ ] **Step 3: Configure TypeScript and Vite**

  Configure `tsconfig.json` for `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `jsxImportSource: "preact"`, `strict: true`, `noEmit: true`, and DOM libraries. Configure Vite with `base: "/solar-voyager/"` and the Preact preset.

- [ ] **Step 4: Configure formatting and linting**

  Apply TypeScript recommended strict rules, browser globals for `src`, Node globals for config files, Prettier-compatible exclusions, and `import/no-restricted-paths` zones that forbid imports from higher layers into `core`, `sim`, and `game`.

- [ ] **Step 5: Verify configuration parses**

  Run: `npm run typecheck`

  Expected: initial failure only because application source files do not exist yet; no configuration or unknown-option errors.

- [ ] **Step 6: Commit**

  Run: `git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts index.html eslint.config.js .prettierrc.json && git commit -m "chore: [T0001] configure Vite TypeScript toolchain"`

### Task 2: Layer boundaries and automated guard

**Files:**

- Create: `src/core/appInfo.ts`
- Create: `src/sim/scaffoldState.ts`
- Create: `src/game/createScaffoldState.ts`
- Create: `tests/architecture/importBoundaries.test.ts`

**Interfaces:**

- Consumes: ESLint flat configuration from Task 1.
- Produces: `APP_TITLE: string`, `ScaffoldState`, and `createScaffoldState(): ScaffoldState`.

- [ ] **Step 1: Write the failing architecture test**

  The test creates a temporary `src/sim/__invalidImport.ts` containing `import "../../render/createRenderer"`, invokes ESLint programmatically for that file, and asserts that a message with rule id `import/no-restricted-paths` is returned; cleanup runs in `finally`.

- [ ] **Step 2: Run the focused test**

  Run: `npm test -- tests/architecture/importBoundaries.test.ts`

  Expected: FAIL until the layer zones are correctly configured.

- [ ] **Step 3: Add minimal boundary modules and correct the lint zones**

  Export `APP_TITLE = "Solar Voyager"` from core; define a readonly scaffold state containing the title in sim; construct it in game. Do not import DOM or Three.js in these modules.

- [ ] **Step 4: Re-run the focused test**

  Run: `npm test -- tests/architecture/importBoundaries.test.ts`

  Expected: one passing test and zero leaked temporary files.

- [ ] **Step 5: Commit**

  Run: `git add src/core src/sim src/game tests/architecture eslint.config.js && git commit -m "test: [T0001] enforce module import direction"`

### Task 3: High-performance renderer and placeholder scene

**Files:**

- Create: `src/render/createRenderer.ts`
- Create: `src/render/createPlaceholderScene.ts`
- Create: `src/render/placeholderScene.test.ts`

**Interfaces:**

- Produces: `createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer` and `createPlaceholderScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; cube: THREE.Mesh }`.

- [ ] **Step 1: Write the failing scene-construction test**

  Assert that the scene contains exactly one mesh, one ambient light, and one directional light; assert the mesh geometry/material exist before the frame loop and the camera starts at a nonzero Z position.

- [ ] **Step 2: Run the focused test**

  Run: `npm test -- src/render/placeholderScene.test.ts`

  Expected: FAIL because `createPlaceholderScene` is missing.

- [ ] **Step 3: Implement setup-only scene construction**

  Create a box geometry and standard material once, disable `matrixAutoUpdate` on the cube, and return stable references. Configure the renderer with `powerPreference: "high-performance"`, `antialias: false`, `stencil: false`, `alpha: false`, and `preserveDrawingBuffer: false`; cap pixel ratio with `Math.min(window.devicePixelRatio, 2)`.

- [ ] **Step 4: Re-run the focused test**

  Run: `npm test -- src/render/placeholderScene.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/render && git commit -m "feat(render): [T0001] add placeholder Three.js scene"`

### Task 4: Preact title overlay and bootstrap loop

**Files:**

- Create: `src/ui/App.tsx`
- Create: `src/ui/app.css`
- Create: `src/main.ts`
- Create: `src/style.css`

**Interfaces:**

- Consumes: `createScaffoldState`, `createRenderer`, and `createPlaceholderScene`.
- Produces: browser entry point mounted into `#app`.

- [ ] **Step 1: Implement the overlay**

  Render an accessible `h1` containing `Solar Voyager` above a full-viewport canvas. Keep the overlay pointer-transparent and use only static CSS.

- [ ] **Step 2: Implement resize and frame loop**

  Create renderer/scene once. Reuse a module-level frame callback; update numeric cube rotations, call `cube.updateMatrix()`, then render. Resize only when canvas client dimensions differ from drawing-buffer dimensions; update the projection matrix after a real resize.

- [ ] **Step 3: Run static checks**

  Run: `npm run lint && npm run typecheck`

  Expected: both commands exit 0 with no warnings promoted to errors.

- [ ] **Step 4: Commit**

  Run: `git add src/main.ts src/style.css src/ui && git commit -m "feat(ui): [T0001] bootstrap Solar Voyager placeholder"`

### Task 5: Full verification and task delivery

**Files:**

- Modify: `tasks/T0001-project-scaffold.yaml`
- Modify: `README.md` only if actual commands differ from its Development section.

**Interfaces:**

- Produces: review-ready T0001 branch and evidence for every acceptance criterion.

- [ ] **Step 1: Run all required checks**

  Run: `npm run lint; npm run typecheck; npm test; npm run build`

  Expected: four exit codes of 0; Vite emits `dist/index.html` with `/solar-voyager/` asset URLs.

- [ ] **Step 2: Verify the layer guard independently**

  Run: `npm test -- tests/architecture/importBoundaries.test.ts`

  Expected: PASS with an observed `import/no-restricted-paths` lint finding inside the test assertion.

- [ ] **Step 3: Verify the browser manually**

  Run: `npm run dev -- --host 127.0.0.1`

  Open the reported `/solar-voyager/` URL and verify a rotating lit cube, the `Solar Voyager` title, no console errors, and a WebGL renderer created with the requested high-performance preference.

- [ ] **Step 4: Mark the branch for review**

  Change only this branch's task status from `IN_PROGRESS` to `REVIEW`, retaining `agent: chatgpt` and `branch: task/T0001-project-scaffold`.

- [ ] **Step 5: Commit and push**

  Run: `git add tasks/T0001-project-scaffold.yaml README.md && git commit -m "chore(tasks): [T0001] ready for review" && git push -u origin task/T0001-project-scaffold`

- [ ] **Step 6: Open the review gate**

  Create a PR titled `[T0001] Project scaffold` whose description maps lint, typecheck, tests, build, import-boundary rejection, and browser verification to the acceptance criteria. A different agent or the maintainer must review and merge before T0030 or T0035 can be claimed.
