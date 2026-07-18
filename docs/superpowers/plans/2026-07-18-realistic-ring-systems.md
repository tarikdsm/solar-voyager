# Realistic Ring Systems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver guide-compliant tier-3 assets and physically legible ring rendering for Saturn, Jupiter, Uranus, and Neptune, including a one-draw quality-governed Saturn flythrough field.

**Architecture:** Keep each ring annulus inside its parent planet GLB and introduce `data/rings.json` as the shared scientific contract for Blender, texture generation, and runtime rendering. Prepare stable shader augmentations and one maximum-capacity instanced particle field when a lazy model loads; update only preallocated uniforms and instance count in the existing body loop.

**Tech Stack:** TypeScript 5, Three.js r179, Vitest, Vite, Playwright, Node.js image tooling (`sharp`), Blender 5.1 Python, glTF/Draco, KTX2.

## Global Constraints

- `src/core` and `src/sim` remain pure TypeScript and are not modified.
- Runtime units remain km / km/s / s / km³/s²; authoring uses one parent equatorial radius per Blender unit.
- Ring annuli use at least 128 angular segments, no more than 5,000 triangles, external 2048×64 RGBA strips, `mat_rings`, and double-sided rendering.
- No gameplay-frame allocations, material/geometry/texture creation, shader compilation, synchronous GPU reads, or per-instance CPU matrix rewrites.
- Maximum particle field is one `InstancedMesh` draw call and its active count is a quality knob.
- Planet runtime total stays below 12 MB and each ring subset stays below 2 MB.
- Blender builders are deterministic, catalog-driven, use `tools/blender/common`, and emit stable manifests.
- T0085 owns animated gas bands; T0083 does not add surface-flow animation.

---

## File map

- `data/rings.json`, `data/rings.schema.json`: reviewed scientific values and validation contract.
- `src/render/ringCatalog.ts`: parse/freeze runtime ring definitions.
- `tools/textures/generateRingTextures.mjs`: deterministic 2048×64 strip generation.
- `tools/blender/ring_config.py`, `tools/blender/common/rings.py`: Blender-free config plus annulus authoring.
- `tools/blender/build_planet.py`, `build_{jupiter,saturn,uranus,neptune}.py`: common giant builder and discovery wrappers.
- `src/render/ringMaterial.ts`: ring/planet shader augmentation and uniform state.
- `src/render/ringParticleField.ts`: Saturn GPU particle patch.
- `src/render/ringSystem.ts`: model discovery, lifecycle, cross-fade, and allocation-free update.
- `src/render/bodyVisualSystem.ts`, `createEpochWorld.ts`, `perfGovernor.ts`, `renderQualityController.ts`, `main.ts`: integration.
- `tests/render/ringSystemsPage.ts`, `tools/tests/ringSystemsRegression.mjs`: real-browser visual acceptance.
- `tests/render/ringFlythroughPage.ts`, `tools/tests/ringFlythroughRegression.mjs`: particle/performance acceptance.

### Task 1: Scientific ring catalog and deterministic strips

**Files:**
- Create: `data/rings.json`
- Create: `data/rings.schema.json`
- Create: `src/render/ringCatalog.ts`
- Create: `src/render/ringCatalog.test.ts`
- Create: `tools/textures/generateRingTextures.mjs`
- Create: `tools/textures/generateRingTextures.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadRingCatalog(value: unknown): readonly RingDefinition[]`
- Produces: `ringDefinitionFor(id: string): RingDefinition | null`
- Produces: CLI `node tools/textures/generateRingTextures.mjs --body <id> --output <path>`

- [x] **Step 1: Write catalog validation tests**

```ts
expect(RING_DEFINITIONS.map((ring) => ring.bodyId)).toEqual([
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
]);
expect(ringDefinitionFor('saturn')).toMatchObject({ innerRadiusRatio: 1.11 });
expect(ringDefinitionFor('neptune')?.arcs).toHaveLength(4);
expect(() => loadRingCatalog({ schemaVersion: 1, systems: [] })).toThrow(/schemaVersion/u);
```

- [x] **Step 2: Run the focused test and observe the missing-module failure**

Run: `npx vitest run src/render/ringCatalog.test.ts`
Expected: FAIL because `ringCatalog.ts` does not exist.

- [x] **Step 3: Add schema v1 data and strict parser**

Use PDS/NASA kilometer radii, normalize by each catalog equatorial reference, sort systems by body id in the parser, freeze every nested array/object, and reject non-finite/inverted/out-of-annulus bands. Keep display exposure explicit per system instead of mutating physical optical depth.

```ts
export interface RingDefinition {
  readonly bodyId: string;
  readonly innerRadiusRatio: number;
  readonly outerRadiusRatio: number;
  readonly exposure: number;
  readonly bands: readonly RingBand[];
  readonly arcs: readonly RingArc[];
  readonly particles: RingParticleDefinition | null;
}
```

- [x] **Step 4: Write generator tests before implementation**

Generate Saturn twice into temporary directories; assert byte identity, 2048×64 RGBA, first/last column transparency, row identity for axisymmetric bodies, alpha ordering across named bands, and a stable seam for Neptune's arc metadata (arcs remain runtime masks, not baked rows).

- [x] **Step 5: Implement the strip generator**

Sample each output column at pixel center, combine overlapping bands with `1 - exp(-opticalDepth * exposure)`, feather each band by two pixels, write premultiplied-safe RGB with straight alpha, and duplicate the radial profile through all 64 rows. Use `sharp(...).png({ compressionLevel: 9, adaptiveFiltering: false })`.

- [x] **Step 6: Run focused tests and formatting**

Run: `npx vitest run src/render/ringCatalog.test.ts tools/textures/generateRingTextures.test.mjs && npx prettier --check data/rings.json data/rings.schema.json src/render/ringCatalog.ts tools/textures/generateRingTextures.mjs`
Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add data/rings.json data/rings.schema.json src/render/ringCatalog.ts src/render/ringCatalog.test.ts tools/textures/generateRingTextures.mjs tools/textures/generateRingTextures.test.mjs package.json
git commit -m "feat(assets): [T0083] define scientific ring catalog"
```

### Task 2: Deterministic ringed-giant authoring and ingest sources

**Files:**
- Create: `tools/blender/ring_config.py`
- Create: `tools/blender/common/rings.py`
- Create: `tools/tests/test_blender_ring_config.py`
- Create: `tools/blender/build_jupiter.py`
- Create: `tools/blender/build_uranus.py`
- Create: `tools/blender/build_neptune.py`
- Modify: `tools/blender/build_saturn.py`
- Modify: `tools/blender/build_planet.py`
- Modify: `tools/blender/planet_config.py`
- Modify: `tools/blender/common/__init__.py`
- Create/Modify: `assets/models/planets/{jupiter,saturn,uranus,neptune}/**`
- Create/Modify: `assets/textures-src/{jupiter,saturn,uranus,neptune}/**`

**Interfaces:**
- Consumes: `data/rings.json` schema v1 and generated `<body>_rings.png`.
- Produces: `create_ring_annulus(name, inner_radius, outer_radius, segments=256, radial_segments=4)`.
- Produces: four normalized planet GLBs with `mat_surface` and `mat_rings`.

- [x] **Step 1: Write failing pure-Python contract tests**

Assert four configs, source paths, polar ratios, normalized radii, band containment, 256 angular segments, material names, and actionable missing-file errors. Pin Saturn 1.110–2.320, Jupiter 100000/71492–270000/71492, Uranus 39600/25559–106200/25559, and Neptune 41000/24764–62940/24764.

- [x] **Step 2: Run focused Python tests red**

Run: `python -m unittest tools.tests.test_blender_ring_config -v`
Expected: FAIL because `ring_config.py` is absent.

- [x] **Step 3: Implement shared config and annulus helper**

The helper builds an XY-plane Blender annulus (glTF XZ plane after export), uses radial U and angular V, smooth normals, no n-gons, and returns one object named `<body>_rings`. Four radial segments are sufficient because texture U carries structure; 256 angular segments produce 2,048 triangles.

- [x] **Step 4: Generalize the planet builder**

Extend `PlanetConfig` for the four giants, use a 128×64 surface, apply catalog polar ratios, attach `mat_rings`, publish albedo/detail/ring files, and assert surface plus ring triangles independently. Wrappers delegate to `build_planet.build('<id>', output_root)`.

- [x] **Step 5: Acquire and verify approved albedos**

Fetch the official Solar System Scope CC BY 4.0 URLs, record SHA-256, normalize to 4096×2048 JPEG where required, and document modifications. Generate the project-authored 1k gas detail pair and ring strips deterministically. Never commit an unverified network response.

- [x] **Step 6: Build twice in isolated roots**

Run Blender 5.1 once per planet into `build/T0083-authoring-a` and `build/T0083-authoring-b`; compare normalized GLB and texture SHA-256. Expected: all corresponding files match and each manifest reports ring triangles ≤5,000.

- [x] **Step 7: Inspect Blender previews**

Render lit, edge-on, and backlit authoring views for each planet with review-only cameras/lights excluded from export. Confirm true proportions, no UV seam, no embedded images, and no cameras/lights/animations in GLB.

- [x] **Step 8: Run tool tests and commit sources**

Run: `npm run test:tools && npm run test:blender`
Expected: PASS.

```powershell
git add tools/blender tools/tests assets/models/planets assets/textures-src
git commit -m "feat(assets): [T0083] author four ringed giant models"
```

### Task 3: Ring and planet-shadow shader preparation

**Files:**
- Create: `src/render/ringMaterial.ts`
- Create: `src/render/ringMaterial.test.ts`

**Interfaces:**
- Produces: `prepareRingMaterials(surface: MeshStandardMaterial, rings: MeshStandardMaterial, definition: RingDefinition): PreparedRingMaterials`
- `PreparedRingMaterials.updateSunDirection(x: number, y: number, z: number): void`
- `PreparedRingMaterials.setRepresentationBlend(value: number): void`
- `PreparedRingMaterials.dispose(): void`

- [x] **Step 1: Write shader-injection tests**

Use fake shader records and assert stable uniforms, cache key suffix, planet-ellipsoid occlusion in ring fragment code, ring-plane intersection in surface code, radial texture sample, bounded transmission, Neptune arc loop constants, and chained existing hooks.

- [x] **Step 2: Run the focused test red**

Run: `npx vitest run src/render/ringMaterial.test.ts`
Expected: FAIL because `ringMaterial.ts` is absent.

- [x] **Step 3: Implement one-time preparation**

Validate `mat_rings.map`, set `DoubleSide`, transparent true, depthWrite false, and reuse its texture as the surface shader's ring-opacity sampler. Inject object-local position varying once. Normalize Sun vectors into preallocated `Vector3` values only in the prepared object, never inside `onBeforeCompile` after setup.

- [x] **Step 4: Implement analytic cues**

Use a ray/oblate-spheroid quadratic for planet shadow, ray/`y=0` intersection for ring shadow, `smoothstep` edge feathering, and a maximum 0.22 transmitted-light contribution. Multiply annulus opacity by `1 - representationBlend * 0.65`, leaving enough distant context during flythrough.

- [x] **Step 5: Run tests and commit**

Run: `npx vitest run src/render/ringMaterial.test.ts && npm run typecheck`
Expected: PASS.

```powershell
git add src/render/ringMaterial.ts src/render/ringMaterial.test.ts
git commit -m "feat(render): [T0083] shade ring light transport cues"
```

### Task 4: One-draw Saturn flythrough field

**Files:**
- Create: `src/render/ringParticleField.ts`
- Create: `src/render/ringParticleField.test.ts`

**Interfaces:**
- Produces: `new RingParticleField(definition, parentMuKm3S2, parentRadiusKm)`.
- `update(cameraLocalX, cameraLocalY, cameraLocalZ, simTimeSec): number` returns blend.
- `setCountCap(count: number): void`.
- Readonly `mesh: InstancedMesh` and `blend: number`.

- [x] **Step 1: Write deterministic state tests**

Assert identical seed attributes across constructions, one mesh/material/geometry, maximum count from catalog, zero blend outside radial/vertical windows, continuous 0→1→0 plane crossing, exact quality caps, bounded modulo phase, and unchanged object identities over 10,000 updates.

- [x] **Step 2: Run red**

Run: `npx vitest run src/render/ringParticleField.test.ts`
Expected: FAIL because the module is absent.

- [x] **Step 3: Build setup resources**

Create one low-detail `IcosahedronGeometry`, one `ShaderMaterial`, one maximum-capacity `InstancedMesh`, seeded scalar attributes, and static instance transforms. Set `frustumCulled = false`, `matrixAutoUpdate = false`, and `count = 0` until activated.

- [x] **Step 4: Implement allocation-free GPU patch update**

Write camera-local radial/tangent basis and reduced simulation phase into stable uniforms. The vertex shader combines seeded patch offsets, samples radial band influence, and advances tangent position at `sqrt(mu/r³)`. The fragment shader shades irregular ice with catalog color and blend alpha.

- [x] **Step 5: Run tests and commit**

Run: `npx vitest run src/render/ringParticleField.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```powershell
git add src/render/ringParticleField.ts src/render/ringParticleField.test.ts
git commit -m "feat(render): [T0083] add Saturn ring flythrough field"
```

### Task 5: Model lifecycle, axial tilt, and quality integration

**Files:**
- Create: `src/render/ringSystem.ts`
- Create: `src/render/ringSystem.test.ts`
- Modify: `src/render/bodyVisualSystem.ts`
- Modify: `src/render/bodyVisualSystem.test.ts`
- Modify: `src/render/createEpochWorld.ts`
- Modify: `src/render/perfGovernor.ts`
- Modify: `src/render/perfGovernor.test.ts`
- Modify: `src/render/renderQualityController.ts`
- Modify: `src/render/renderQualityController.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `prepareRingSystem(root, materials, definition, body): PreparedRingSystem | null`.
- Adds `ringParticleCount: number` to `RenderQualityProfile`.
- Adds `setRingParticleCount(count: number): void` to the visual-system quality port.

- [x] **Step 1: Write lifecycle and quality tests**

Cover exact material pairing, incomplete-model rejection, Saturn particles only, root axial tilt at setup, Sun/local transforms, sphere fallback on preparation failure, disposal, profile sequence `4096, 2048, 1024, 0`, and no reapplication of an unchanged rung.

- [x] **Step 2: Run focused suite red**

Run: `npx vitest run src/render/ringSystem.test.ts src/render/bodyVisualSystem.test.ts src/render/perfGovernor.test.ts src/render/renderQualityController.test.ts`
Expected: FAIL on missing interfaces.

- [x] **Step 3: Implement `PreparedRingSystem`**

Find the ring mesh by material name, prepare shaders, optionally create Saturn particles, attach the particle mesh under the same tilted root, and expose `update(camera, sun, simTime)` using scalar arguments. Maintain temporary transform vectors/matrices as fields.

- [x] **Step 4: Integrate into the existing body loop**

Add `muKm3S2` and `axialTiltRad` to definitions from epoch data. Pass `snapshot.simTimeSec` into `BodyVisualSystem.update`. Reuse body distance and packed Sun/body coordinates; do not add a second body loop. Capture ring materials' original fade state alongside existing model material baselines.

- [x] **Step 5: Add quality count profiles**

Extend the profile constructor and every profile literal. Keep 4096 through high-quality rungs, descend to 2048 and 1024 before texture degradation, and use zero at the lowest rung/software policy. Forward changes without shader rebuild.

- [x] **Step 6: Run tests and commit**

Run: `npx vitest run src/render/ringSystem.test.ts src/render/bodyVisualSystem.test.ts src/render/perfGovernor.test.ts src/render/renderQualityController.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```powershell
git add src/render/ringSystem.ts src/render/ringSystem.test.ts src/render/bodyVisualSystem.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.ts src/render/perfGovernor.ts src/render/perfGovernor.test.ts src/render/renderQualityController.ts src/render/renderQualityController.test.ts src/main.ts
git commit -m "feat(render): [T0083] integrate ring systems and quality"
```

### Task 6: Canonical ingest and real-browser acceptance

**Files:**
- Modify: `public/assets/**`
- Modify: `public/assets/manifest.json`
- Create: `tests/render/ringSystems.html`
- Create: `tests/render/ringSystemsPage.ts`
- Create: `tools/tests/ringSystemsRegression.mjs`
- Create: `tests/render/ringFlythrough.html`
- Create: `tests/render/ringFlythroughPage.ts`
- Create: `tools/tests/ringFlythroughRegression.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces npm scripts `test:ring-systems` and `test:ring-flythrough`.

- [x] **Step 1: Write browser regressions before fixture implementation**

Require four loaded tier-3 models, zero WebGL error, stable program count after warm-up, visible radial variance, shadow-sector contrast, planet ring-shadow contrast, bounded backlight gain, Neptune arc localization, and no unexpected network requests.

The flythrough test requires a continuous combined alpha metric, moving particle centroid/parallax, one added draw call, exact quality counts, and stable heap after warm-up.

- [x] **Step 2: Run red**

Run: `npm run test:ring-systems && npm run test:ring-flythrough`
Expected: FAIL because fixture pages are absent.

- [x] **Step 3: Run canonical ingest twice**

Run: `npm run assets:ingest -- --ktx "C:\Program Files\KTX-Software\bin\ktx.exe"`, hash `public/assets`, repeat, and compare. Expected: identical hashes; four planet entries; each planet <12 MB; measured ring subset <2 MB.

- [x] **Step 4: Implement deterministic fixtures**

Use fixed cameras, Sun vectors, quality locks, and frame counts. Expose scalar metrics via `window.__ringSystemsTest` / `window.__ringFlythroughTest`; keep test-only control behind `import.meta.env.DEV` pages, not production globals.

- [x] **Step 5: Run browser acceptance and neighbors**

Run: `npm run test:ring-systems && npm run test:ring-flythrough && npm run test:visual-tiers && npm run test:lighting-post && npm run test:surface-detail && npm run test:perf-governor && npm run test:renderer-policy`
Expected: PASS with WebGL error 0.

- [x] **Step 6: Commit runtime artifacts and regressions**

```powershell
git add public/assets tests/render tools/tests package.json
git commit -m "test(render): [T0083] verify ring systems in WebGL"
```

### Task 7: Performance evidence, specifications, review, and delivery

**Files:**
- Create: `docs/bench/T0083-before.json`
- Create: `docs/bench/T0083-after.json`
- Create: `docs/bench/T0083-summary.md`
- Modify: `docs/rendering-spec.md`
- Modify: `docs/asset-pipeline.md`
- Modify: `assets/models/MODELING-GUIDE.md`
- Modify: `tasks/T0083-realistic-rings.yaml`

**Interfaces:**
- Produces complete acceptance evidence and REVIEW handoff.

- [ ] **Step 1: Capture paired benchmark evidence**

Run the unchanged native 1920×1080 benchmark route before/after with identical browser, warm-up, duration, and camera. Record FPS/cadence, CPU/GPU p50/p75/p99, draw calls, triangles, programs, heap, renderer string, console errors, and page errors. Add a dedicated Saturn-plane segment if the standard route does not activate particles.

- [ ] **Step 2: Document implemented constants only**

Update rendering spec §11 with catalog/shader/cross-fade/quality behavior, asset pipeline with `rings.json` and strip generation, and modeling guide with the shared annulus helper. Record sources and the reference-hardware limitation honestly.

- [ ] **Step 3: Run the full local gate set**

Run: `npm test`, `npm run test:tools`, `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`, `npm run check:tasks`, `npm run check:budgets`, all browser regressions, `npm run test:smoke`, and `git diff --check`.
Expected: every command exits 0; only documented skips remain.

- [ ] **Step 4: Request independent review**

Reviewer checks every acceptance criterion, exact ring radii/provenance, shader geometry, actual WebGL screenshots, one-draw particle evidence, zero-allocation design, budgets, and exact-head tests. Address findings and repeat affected/full gates.

- [ ] **Step 5: Move task to REVIEW and commit**

Fill `handoff_notes` with hashes, sizes, visual metrics, performance results, review verdict, and commands.

```powershell
git add docs assets/models/MODELING-GUIDE.md tasks/T0083-realistic-rings.yaml
git commit -m "docs(render): [T0083] record ring-system acceptance"
```

- [ ] **Step 6: Rebase, push, open PR, and merge only with green CI**

Rebase on current `origin/main`, push `task/T0083-realistic-rings`, open `[T0083] Realistic ring systems (Saturn, Uranus, Jupiter, Neptune)`, enumerate acceptance evidence, wait for CI, record `DONE` after independent approval, rerun CI, and merge.
