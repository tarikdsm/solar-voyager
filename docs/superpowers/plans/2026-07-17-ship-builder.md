# Ship Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ingest a deterministic PBR ship asset that preserves the approved design and satisfies every T0034 acceptance criterion.

**Architecture:** `build_ship.py` owns the procedural scene and authored maps, using the existing Blender common reset/export/manifest boundary. The ingest pipeline gains one generic `<material>__<role>` filename convention so ship maps are wired to exact glTF materials without changing existing body bindings. Verification covers the binding unit, authored artifact, deterministic rebuild, runtime ingest, visual output, and repository gates.

**Tech Stack:** Blender 5.1 Python API, glTF 2.0, Node.js 22, glTF-Transform 4.4, Vitest 4, KTX-Software 4.4, Sharp 0.35.

## Global Constraints

- Work only on claimed task T0034 and branch `task/T0034-build-ship`.
- One Blender unit is one metre for the ship; `engine_nozzle` is an exact node name.
- The authored model must contain no embedded images, cameras, lights, animations, or Draco data.
- Applied geometry must stay at or below 30,000 triangles.
- Ship GLB plus runtime KTX2 maps must stay below 8 MiB.
- Generated runtime files are produced only by `npm run assets:ingest`.
- Preserve the current approved silhouette and material palette.

---

### Task 1: Material-scoped runtime texture binding

**Files:**
- Modify: `tools/assets/processAsset.mjs`
- Modify: `tools/assets/processAsset.test.mjs`
- Modify: `docs/asset-pipeline.md`
- Modify: `assets/models/MODELING-GUIDE.md`

**Interfaces:**
- Consumes: ingest binding objects `{ role, sourceName, uri }`.
- Produces: `parseTextureRole(role)` semantics where `mat_hull__normal` resolves to material `mat_hull` and semantic role `normal`; unscoped roles retain existing behavior.

- [ ] **Step 1: Write a failing scoped-binding test**

Add a fixture option for multiple named materials and a test that compresses a GLB with `mat_hull__albedo`, `mat_hull__normal`, `mat_hull__metallic`, and `mat_engine_glow__emissive`. Assert that the first three texture slots are present only on `mat_hull`, the emissive slot is present only on `mat_engine_glow`, and `KHR_texture_basisu` is required.

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `npx vitest run tools/assets/processAsset.test.mjs`

Expected: FAIL because scoped roles currently fall through to the first material and extras.

- [ ] **Step 3: Implement exact material parsing and binding**

In `processAsset.mjs`, split at one `__`; return `{ materialName: null, semanticRole: role }` for legacy roles and `{ materialName, semanticRole }` for scoped roles. Resolve scoped material names exactly, throw `Texture role "<role>" targets missing material "<name>"` when absent, and route the semantic role through the existing base-color, normal, metallic-roughness, emissive, occlusion, or extras logic. Keep the full original role in the runtime image marker so image identities remain unique.

- [ ] **Step 4: Add and pass the missing-material regression**

Test that `compressGlb()` rejects `mat_missing__albedo` with the exact actionable message. Re-run `npx vitest run tools/assets/processAsset.test.mjs`; expected: all tests PASS.

- [ ] **Step 5: Document the convention**

Add `<asset>_<material-name>__<role>.<ext>` to the asset pipeline and modeling guide, with ship examples and the supported standard roles. State that exact named-material resolution is validated during ingest.

- [ ] **Step 6: Commit the independently testable pipeline change**

Run `git add tools/assets/processAsset.mjs tools/assets/processAsset.test.mjs docs/asset-pipeline.md assets/models/MODELING-GUIDE.md && git commit -m "feat(assets): [T0034] bind textures to named ship materials"`.

### Task 2: Deterministic procedural ship source

**Files:**
- Create: `tools/blender/build_ship.py`
- Modify: `assets/models/ship/SOURCES.md`
- Regenerate: `assets/models/ship/ship.glb`
- Create: `assets/models/ship/ship_mat_hull__albedo.png`
- Create: `assets/models/ship/ship_mat_hull__normal.png`
- Create: `assets/models/ship/ship_mat_hull__metallic.png`
- Create: `assets/models/ship/ship_mat_engine_glow__emissive.png`

**Interfaces:**
- Consumes: `common.reset_scene`, `common.create_pbr_material`, `common.export_glb`, `common.build_manifest`, and `common.print_manifest`.
- Produces: `build(output_root: pathlib.Path) -> dict`, a guide-compliant `ship.glb`, four external maps, and a JSON manifest printed to stdout.

- [ ] **Step 1: Add the builder contract before geometry**

Implement argument parsing with `--output-root` defaulting to `assets/models`, resolve the singleton output as `<output-root>/ship`, reset the scene, and define constants for expected node names, map dimensions `(1024, 512)`, triangle limit `30_000`, and ship length tolerance around 26 m. Calling `build()` before geometry exists must fail its own named-node/triangle assertions.

- [ ] **Step 2: Run the headless builder and confirm the red state**

Run: `& 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe' --background --python tools/blender/build_ship.py -- --output-root build/T0034-red`

Expected: non-zero exit with the builder's missing ship geometry invariant.

- [ ] **Step 3: Recreate the approved mesh hierarchy**

Add focused primitive helpers for cones/cylinders, UV spheres, torus, and bevelled boxes. Recreate the reference dimensions and transforms for `hull_main`, `hull_nose`, `hull_tip`, `engine_skirt`, `engine_nozzle`, `engine_glow_disc`, `drive_ring`, four pylons, two radiators, canopy, eight RCS blocks, antenna mast, and dish. Apply smooth shading and modifiers before strict selected export. Keep `engine_nozzle` as its own exported mesh object.

- [ ] **Step 4: Generate and wire deterministic PBR maps**

Generate 1024×512 PNG pixel buffers with fixed panel bands and seam-safe edges: silver hull albedo, tangent-space normal around `(128,128,255)` with shallow panel variation, metallic/roughness channels compatible with glTF, and cyan-blue engine emission. Wire the first three to `mat_hull` and the last to `mat_engine_glow` at strength 2; keep all six approved material names and the other approved factor values.

- [ ] **Step 5: Export, validate builder invariants, and update attribution**

Export only mesh objects to `ship.glb`, print the manifest, assert `engine_nozzle` is exported, assert triangles are in `(0, 30_000]`, and assert the longitudinal bounds remain approximately 26 m. Rewrite `SOURCES.md` to identify `build_ship.py` as canonical, document the original project-authored design, each generated map, Blender version, dimensions, orientation, and processing.

- [ ] **Step 6: Run the real builder**

Run: `& 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe' --background --python tools/blender/build_ship.py`

Expected: exit 0 and a manifest listing `ship`, triangles at or below 30,000, four texture paths, and authored bytes.

- [ ] **Step 7: Commit the authored source and artifacts**

Run `git add tools/blender/build_ship.py assets/models/ship && git commit -m "assets(ship): [T0034] add reproducible PBR ship builder"`.

### Task 3: Determinism, authored-contract, and runtime acceptance

**Files:**
- Regenerate: `public/assets/manifest.json`
- Regenerate: `public/assets/models/ship.glb`
- Create: `public/assets/textures/ship_mat_hull__albedo.ktx2`
- Create: `public/assets/textures/ship_mat_hull__normal.ktx2`
- Create: `public/assets/textures/ship_mat_hull__metallic.ktx2`
- Create: `public/assets/textures/ship_mat_engine_glow__emissive.ktx2`

**Interfaces:**
- Consumes: authored ship output and KTX executable `C:\Program Files\KTX-Software\bin\ktx.exe`.
- Produces: reproducibility hashes and canonical runtime ship files listed in `public/assets/manifest.json`.

- [ ] **Step 1: Build twice into disposable roots**

Run the Blender command twice with `--output-root build/T0034-repro-a` and `build/T0034-repro-b`. Compute SHA-256 for `ship.glb` and all four PNGs in both roots. Expected: matching filename/hash pairs.

- [ ] **Step 2: Validate the authored asset and node contract**

Use `validateAssetDirectory()` for `assets/models/ship` with `{ category: 'ship', id: 'ship' }`; expected: no findings and triangles ≤30,000. Parse GLB JSON and assert an exported node is named exactly `engine_nozzle`.

- [ ] **Step 3: Run focused runtime ingest**

Set `$env:KTX_BIN='C:\Program Files\KTX-Software\bin\ktx.exe'` and run `npm run assets:ingest -- --only ship --output build/T0034-runtime`. Expected: manifest lists four `textures/*.ktx2` files and `models/ship.glb`; their sum is below 8,388,608 bytes.

- [ ] **Step 4: Inspect the focused runtime GLB**

Parse `build/T0034-runtime/models/ship.glb`; assert `KHR_draco_mesh_compression` and `KHR_texture_basisu` are required, image URIs point to the four external KTX2 files, the material slots are correct, and the named nozzle node remains present.

- [ ] **Step 5: Regenerate all canonical runtime assets**

Run `npm run assets:ingest` with the same `KTX_BIN`. Expected: exit 0, all catalog assets remain in the manifest, and ship files match the focused output.

- [ ] **Step 6: Commit runtime output**

Run `git add public/assets && git commit -m "assets(runtime): [T0034] ingest PBR ship KTX2 assets"`.

### Task 4: Visual and repository verification

**Files:**
- Create only under ignored review output: `build/T0034-review/ship.png`
- Modify if verification finds a defect: files owned by Tasks 1–3

**Interfaces:**
- Consumes: regenerated authored and runtime assets.
- Produces: review evidence for T0034 delivery and a clean, merge-ready branch.

- [ ] **Step 1: Render the regenerated authored ship**

Open the generated scene headlessly, add a review-only camera and area lights outside the export selection, and render a 16:9 image showing the nose, radiators, drive ring, and cyan engine glow. Inspect the PNG for silhouette parity, readable materials, normal-map artifacts, and clipped geometry.

- [ ] **Step 2: Run focused and full automated checks**

Run `npx vitest run tools/assets/processAsset.test.mjs tools/assets/assetIngest.test.mjs`, `npm run test:blender`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check:budgets`, and `npm run check:tasks`. Expected: every command exits 0.

- [ ] **Step 3: Smoke-test the game**

Serve the production build and open it in a real browser. Expected: page and canvas load, the playable flow reaches the space scene, and the browser console contains no errors attributable to asset loading or KTX2/Draco decoding.

- [ ] **Step 4: Check final scope and history**

Run `git diff main...HEAD --check`, `git status --short`, and inspect `git diff --stat main...HEAD`. Expected: no whitespace errors, no unrelated files, and ignored review artifacts remain untracked/uncommitted.

- [ ] **Step 5: Request independent review and fix findings**

Review against the T0034 spec, asset-pipeline contract, exact nozzle name, deterministic hashes, material bindings, and 8 MiB budget. Resolve every Critical or Important finding and rerun affected checks.

- [ ] **Step 6: Deliver through the task protocol**

Update `tasks/T0034-build-ship.yaml` through REVIEW to DONE with concise acceptance evidence, push the task branch, open the task PR, merge only after green CI and approval, then fast-forward local `main` without staging or modifying the maintainer's unrelated files.
