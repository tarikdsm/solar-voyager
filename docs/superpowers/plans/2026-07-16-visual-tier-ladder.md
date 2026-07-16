# Visual Tier Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scaffold cube with a true-scale point/sphere/glTF body ladder that transitions without popping and never fetches non-hero assets before approach.

**Architecture:** A Three-free math module selects tiers with projected angular diameter and 20% hysteresis. `BodyVisualSystem` batches every distant body into one point cloud, shares sphere geometry, and attaches cached glTF roots only after asynchronous load plus shader precompile. `CameraRelativeSpaceScene` remains the only float64-to-float32 position bridge.

**Tech Stack:** TypeScript 6, Three.js r185 (`Points`, `KTX2Loader`, `GLTFLoader`, `DRACOLoader`), Vite, Vitest, Playwright, KTX-Software 4.4.x.

## Global Constraints

- Physics/catalog positions remain float64 kilometres; `Math.fround(body - camera)` appears only in `src/render/spaceScene.ts`.
- Point/sphere and sphere/model boundaries are 1.5 px and 200 px with ±20% hysteresis.
- Point rendering is one draw call; all sphere meshes share one geometry.
- Sun, Earth, and Moon sphere resources are the only eager body assets; every glTF model is threshold-triggered.
- No materials, geometry, closures, object literals, or array helpers are created in the normal frame loop.
- A newly loaded model is compiled before it becomes visible.
- The initial critical path remains strictly below 8 MiB.

---

### Task 1: Define startup tiers and generate sphere KTX2 assets

**Files:**
- Create: `docs/decisions/ADR-023-tiered-startup-payload.md`
- Create: `data/initial-path.json`
- Modify: `docs/rendering-spec.md`
- Modify: `docs/performance-spec.md`
- Modify: `docs/asset-pipeline.md`
- Modify: `tools/assets/ktx.mjs`
- Modify: `tools/assets/ktx.test.mjs`
- Modify: `tools/assets/ingest.mjs`
- Modify: `tools/assets/ingest.test.mjs`
- Modify: `tools/checks/assetBudgets.mjs`
- Modify: `tools/checks/assetBudgets.test.mjs`
- Regenerate: `public/assets/manifest.json`
- Create: `public/assets/textures/*_albedo_tier2.ktx2`
- Create: `public/assets/codecs/{basis,draco}/*`

**Interfaces:**
- Produces: manifest-listed `textures/<id>_albedo_tier2.ktx2` for surface bodies.
- Produces: `data/initial-path.json` with `{ schemaVersion: 1, files: string[] }` repo-relative paths.
- Produces: `buildKtxArguments(inputPath, outputPath, metadata, options?: { width?: number; height?: number })`.

- [ ] **Step 1: Write failing KTX and ingest tests**

Add expectations that explicit `width/height` append one resize pair, that planet albedo emits a 2048×1024 tier-2 KTX2, moon/dwarf albedo emits 1024×512, the derivative is in the asset `files` list, and reruns are byte-identical.

```js
expect(buildKtxArguments('earth_albedo.jpg', 'earth_albedo_tier2.ktx2', metadata,
  { width: 2048, height: 1024 })).toEqual(expect.arrayContaining([
    '--width', '2048', '--height', '1024',
  ]));
expect(manifest.assets[0].files).toContain('textures/earth_albedo_tier2.ktx2');
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run tools/assets/ktx.test.mjs tools/assets/ingest.test.mjs`

Expected: FAIL because explicit resize options and tier-2 output do not exist.

- [ ] **Step 3: Implement deterministic derivative generation**

Extend `encodeTexture()` to forward explicit dimensions to `buildKtxArguments()`. In `ingestAssets()`, after encoding the full albedo, encode a second file using category size:

```js
const sphereWidth = asset.category === 'planets' ? 2048 : 1024;
const sphereRelative = `textures/${asset.id}_albedo_tier2.ktx2`;
await encoder(source, join(stagingRoot, sphereRelative), {
  executable: options.ktxExecutable,
  width: sphereWidth,
  height: sphereWidth / 2,
});
files.push(sphereRelative);
```

Copy the pinned Three codec files and `node_modules/three/LICENSE` into staging on every ingest so a rerun cannot delete them.

The exact copied files are `examples/jsm/libs/basis/basis_transcoder.js`,
`basis_transcoder.wasm`, `examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js`,
`draco_decoder.wasm`, and `LICENSE`.

- [ ] **Step 4: Replace filename heuristics in the budget gate**

Read `data/initial-path.json`, reject absolute/escaping/duplicate/missing paths, and sum its canonical files plus all built `.js/.css/.html/.mjs/.wasm` files. Update fixtures so `data/stars.bin` and only listed tier resources count; unlisted full hero maps do not.

```json
{
  "schemaVersion": 1,
  "files": [
    "data/stars.bin",
    "public/assets/manifest.json",
    "public/assets/textures/earth_albedo_tier2.ktx2",
    "public/assets/textures/moon_albedo_tier2.ktx2"
  ]
}
```

- [ ] **Step 5: Record the decision and regenerate assets**

ADR-023 supersedes only ADR-022's assumption that every Moon tier is startup-critical. Preserve ADR-022's 4k/2k full tier, define 2k planet and 1k moon/dwarf sphere tiers, and state that full models/maps are lazy.

Run:

```powershell
$env:KTX_BIN='C:\Program Files\KTX-Software\bin\ktx.exe'
npm run assets:ingest
npm run check:budgets
```

Expected: manifest contains tier-2 albedos, codecs are local, and critical path is < 8 MiB.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tools/assets tools/checks/assetBudgets.test.mjs`

Commit: `assets(runtime): [T0041] add startup sphere tiers and local codecs`

---

### Task 2: Implement projected-size, hysteresis, and magnitude math

**Files:**
- Create: `src/render/visualTier.ts`
- Create: `src/render/visualTier.test.ts`
- Modify: `docs/rendering-spec.md`

**Interfaces:**
- Produces: `type VisualTier = 1 | 2 | 3`.
- Produces: `projectedDiameterPx(radiusKm, distanceKm, viewportHeightPx, verticalFovRad): number`.
- Produces: `selectVisualTier(current, diameterPx): VisualTier`.
- Produces: `apparentMagnitude(bodyIndex: number, sunIndex: number, meanRadiusKm: number, geometricAlbedo: number, positionsKm: Float64Array, cameraPositionKm: ReadonlyVec3): number`.

- [ ] **Step 1: Write failing boundary tests**

Cover exact transitions at 1.2/1.8/160/240 px, direct point→model/model→point jumps, surface/zero distance finiteness, and monotonic projected diameter.

```ts
expect(selectVisualTier(1, 1.79)).toBe(1);
expect(selectVisualTier(1, 1.8)).toBe(2);
expect(selectVisualTier(2, 1.19)).toBe(1);
expect(selectVisualTier(2, 240)).toBe(3);
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/render/visualTier.test.ts`

Expected: FAIL because `visualTier.ts` is absent.

- [ ] **Step 3: Implement scalar-only math**

Use `2 * Math.asin(Math.min(1, radiusKm / distanceKm))`, explicit finite/range checks at setup-facing boundaries, and a `switch` on current tier. Implement the Lambert phase brightness formula from the design and document it in rendering-spec §3.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx vitest run src/render/visualTier.test.ts`

Commit: `feat(render): [T0041] add visual tier selection math`

---

### Task 3: Extend the camera-relative boundary for packed bodies

**Files:**
- Modify: `src/render/spaceScene.ts`
- Modify: `src/render/spaceScene.test.ts`
- Modify: `tests/render/float32Boundary.test.ts`

**Interfaces:**
- Produces: `bindPackedVisual(visual: Object3D, positionsKm: Float64Array, componentOffset: number): void`.
- Produces: `bindPackedPointPositions(points: Points, positionsKm: Float64Array): void`.

- [ ] **Step 1: Write failing packed-binding tests**

Bind two roots at offsets 0 and 3 plus one six-component point attribute. Verify large heliocentric subtraction, object/attribute identity reuse, `needsUpdate`, invalid length/offset rejection, and exact recomputation after camera round-trip.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/render/spaceScene.test.ts tests/render/float32Boundary.test.ts`

Expected: FAIL because packed binding methods do not exist.

- [ ] **Step 3: Add setup arrays and indexed hot loops**

Store packed sources and offsets during binding. In `updateCameraRelative()`, write object positions and point attribute components using only:

```ts
target[offset] = Math.fround(source[offset] - cameraPositionKm.x);
target[offset + 1] = Math.fround(source[offset + 1] - cameraPositionKm.y);
target[offset + 2] = Math.fround(source[offset + 2] - cameraPositionKm.z);
```

Do not add any conversion outside `spaceScene.ts`.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx vitest run src/render/spaceScene.test.ts tests/render/float32Boundary.test.ts`

Commit: `feat(render): [T0041] bind packed camera-relative visuals`

---

### Task 4: Build the cached Three asset loader

**Files:**
- Modify: `src/render/assetManifest.ts`
- Create: `src/render/assetManifest.test.ts`
- Create: `src/render/bodyAssetLoader.ts`
- Create: `src/render/bodyAssetLoader.test.ts`

**Interfaces:**
- Produces: `interface LoadedBodyModel { root: Object3D; materials: Material[] }`.
- Produces: `class BodyAssetLoader` with `loadSphereAlbedo(id, category): Promise<Texture | null>`, `loadModel(id): Promise<LoadedBodyModel | null>`, and `preloadHeroSpheres(): Promise<void>`.
- Consumes: injected async loader factory in tests; production factory dynamically imports KTX2/GLTF/DRACO addons.

- [ ] **Step 1: Write failing cache/laziness tests**

Use injected spies to prove duplicate calls return the same promise, only Sun/Earth/Moon sphere URLs are touched by preload, no model is preloaded, missing entries return `null`, and a rejected URL is attempted once.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/render/bodyAssetLoader.test.ts`

- [ ] **Step 3: Implement loaders and material preparation**

Resolve URLs with `import.meta.env.BASE_URL`, configure KTX2 `detectSupport(renderer)`, configure Draco path, and reuse one loader instance. Traverse a loaded model once, collect unique materials without `.filter/.map` in runtime code, set its root scale later in the visual system, and retain failure state.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx vitest run src/render/assetManifest.test.ts src/render/bodyAssetLoader.test.ts`

Commit: `feat(render): [T0041] add cached lazy body asset loader`

---

### Task 5: Implement the batched point cloud and body visual system

**Files:**
- Create: `src/render/bodyPointCloud.ts`
- Create: `src/render/bodyPointCloud.test.ts`
- Create: `src/render/bodyVisualSystem.ts`
- Create: `src/render/bodyVisualSystem.test.ts`

**Interfaces:**
- Produces: `interface BodyVisualDefinition { id; category; meanRadiusKm; geometricAlbedo; albedoColor }`.
- Produces: `class BodyVisualSystem` constructor accepting renderer, space scene, definitions, packed positions, asset loader, and compile callback.
- Produces: `initializeEager(): Promise<void>`, `update(cameraPositionKm, viewportHeightPx, verticalFovRad, nowMs): void`, `getTier(id): VisualTier`, and `getLoadState(id): 'idle' | 'loading' | 'ready' | 'failed'`.

- [ ] **Step 1: Write failing structural tests**

Assert one `Points` object for 50 bodies, one shared `IcosahedronGeometry`, true-radius scales, precreated materials, point size capped at 1.5, and no model roots before loading.

- [ ] **Step 2: Write failing transition tests**

Drive synthetic distances through point→sphere→model→sphere→point. Assert hysteresis, one load call, fallback visibility while loading, opacity sum > 0 during every 250 ms fade sample, and model invisibility until compile resolves.

- [ ] **Step 3: Run RED**

Run: `npx vitest run src/render/bodyPointCloud.test.ts src/render/bodyVisualSystem.test.ts`

- [ ] **Step 4: Implement setup-time resources and shader**

Create position/color/size/opacity attributes once. The vertex shader assigns existing `aSize`; the fragment shader discards outside a unit circle and multiplies catalog color by bounded magnitude intensity and opacity. Prebuild every sphere mesh/material and bind roots/points to SpaceScene.

- [ ] **Step 5: Implement the allocation-free update machine**

Use parallel typed arrays for desired/current tier, fade start, load state, and opacities. Trigger promises only on the one-time idle→loading transition. Promise callbacks may allocate because they are load events, not the normal frame path.

- [ ] **Step 6: Run GREEN and commit**

Run: `npx vitest run src/render/bodyPointCloud.test.ts src/render/bodyVisualSystem.test.ts`

Commit: `feat(render): [T0041] add batched body visual tier system`

---

### Task 6: Integrate J2026 catalog bodies into the runtime

**Files:**
- Create: `src/game/createEpochWorld.ts`
- Create: `src/game/createEpochWorld.test.ts`
- Modify: `src/main.ts`
- Delete: `src/render/createPlaceholderScene.ts`
- Delete: `src/render/placeholderScene.test.ts`

**Interfaces:**
- Produces: `createEpochWorld(renderer): Promise<{ spaceScene; visualSystem; cameraPositionKm; positionsKm }>`.
- Consumes: `compileRailsCatalog`, `createRailsState`, `createRailsWorkspace`, `evaluateRailsInto`, catalog JSON, and BodyVisualSystem.

- [ ] **Step 1: Write failing world test**

Verify catalog count/order, finite packed positions, camera exactly 400 km above Earth's mean radius, all roots registered, and no cube geometry/material remains.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/game/createEpochWorld.test.ts`

- [ ] **Step 3: Implement setup and startup sequencing**

Compile/evaluate rails at `t=0`, build visual definitions from catalog fields, locate Earth index without a per-frame search, initialize hero spheres, compile initial shaders, then start rAF. In each frame call visual tier update, SpaceScene camera-relative update, and render using caller-owned objects.

- [ ] **Step 4: Run focused runtime tests and commit**

Run: `npx vitest run src/game/createEpochWorld.test.ts src/render`

Commit: `feat(game): [T0041] render the J2026 body catalog`

---

### Task 7: Add real-browser fly-in/network regression and deliver

**Files:**
- Create: `tests/render/visualTierFlyIn.html`
- Create: `tests/render/visualTierFlyInPage.ts`
- Create: `tools/tests/visualTierFlyIn.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tasks/T0041-visual-tier-ladder.yaml`

**Interfaces:**
- Produces: `npm run test:visual-tiers`.

- [ ] **Step 1: Write the Playwright runner before the fixture API exists**

The runner waits for `globalThis.__visualTierHarness`, records all requests, steps fixed camera distances, and asserts tier sequence `[1, 2, 3, 2, 1]`, nonzero rendered pixels at every fade sample, no console/page/WebGL errors, no non-hero URL before approach, and exactly one request per triggered URL.

- [ ] **Step 2: Run RED**

Run: `npm run test:visual-tiers`

Expected: FAIL because the fixture/harness is incomplete.

- [ ] **Step 3: Implement deterministic fixture controls**

Expose only setup-time test methods `stepDistanceKm(distanceKm, nowMs)` and `snapshotState()`. Use production BodyVisualSystem and real local KTX2/glTF assets; do not duplicate tier logic in the fixture.

- [ ] **Step 4: Wire CI and run browser GREEN**

Add `npm run test:visual-tiers` after the existing Chromium install and render-depth regression. Run it twice locally; both runs must have the same tier/request sequence and zero errors.

- [ ] **Step 5: Run performance and complete verification**

Run before/after `bench:scaffold` with 120 warm-up and 600 sampled frames. Then run:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:render-depth
npm run test:visual-tiers
npm run test:tools
npm run format:check
npm run build
npm run check:budgets
npm run check:tasks
git diff --check
```

- [ ] **Step 6: Move the task to REVIEW and commit**

Record exact pixel/request/bench/gate evidence in `handoff_notes`, set status REVIEW, and commit:

`chore(tasks): [T0041] move visual tier ladder to review`

- [ ] **Step 7: Push PR and request independent review**

Open `[T0041] Visual tier ladder (sprite / sphere / glTF) with lazy loading`. The reviewer must reproduce the fly-in/network assertions and confirm no valid-frame allocations before DONE/merge.
