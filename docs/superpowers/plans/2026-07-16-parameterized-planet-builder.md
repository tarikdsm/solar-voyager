# T0032 Parameterized Planet Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke Earth builder with a catalog-driven planet builder and reproducibly publish the approved Earth runtime asset.

**Architecture:** Catalog schema v2 owns the polar/equatorial visual ratio. A pure Python configuration layer selects planet/texture contracts; Blender-only assembly consumes it through T0030 helpers. T0035 remains the sole runtime publisher.

**Tech Stack:** Python 3.9+, Blender 5.1 `bpy`, JSON Schema 2020-12, Node 22, Sharp/KTX-Software, unittest/Vitest.

## Global constraints

- Authored equatorial radius is exactly 1; glTF north is +Y and prime meridian +X.
- No embedded images, Draco, cameras, lights, or animations in authored GLB.
- Earth uses current hero tiers: 8k albedo, 4k normal/night/cloud layers and 1k detail pair; runtime total is at most 20 MiB.
- Catalog schema changes require ADR-021 and a version increment.

### Task 1: Catalog schema v2 visual shape

**Files:** `tools/tests/test_bake_ephemerides.py`, `data/bodies.schema.json`, `tools/bake_ephemerides.py`, `data/bodies.json`, `docs/decisions/ADR-021-visual-polar-radius-ratio.md`.

- [ ] Add tests asserting schema version 2, required finite `visual.polarRadiusRatio` in `(0,1]`, Earth `6356.8/6378.1`, and deterministic bake preservation.
- [ ] Run `python -m unittest tools.tests.test_bake_ephemerides -v`; expect failures on schema version/field absence.
- [ ] Add `polar_radius_ratio: float = 1.0` to `BodyDefinition`, set published planet ratios (Earth from NASA NSSDCA 6356.8/6378.1), emit the field, and update the closed schema/version.
- [ ] Rebuild the committed catalog through the offline deterministic core path and verify schema validation plus existing rails tests.
- [ ] Commit as `feat(data): [T0032] add visual polar radius ratio`.

### Task 2: Pure builder configuration

**Files:** create `tools/blender/planet_config.py`, create `tools/tests/test_blender_planet_config.py`.

- [ ] Add tests for `planet_config(body_id, catalog_path, models_root, textures_root)`: Earth succeeds with stable paths/ratio; Sun and unknown ids fail; missing role files list every missing filename.
- [ ] Run focused unittest and observe missing-module failure.
- [ ] Implement catalog loading, planet-kind enforcement, normalized ratio validation, category/output resolution, and Earth role map without importing `bpy`.
- [ ] Run focused and complete Python tool tests; commit `feat(assets): [T0032] add planet builder configuration`.

### Task 3: Blender planet assembly

**Files:** create `tools/blender/build_planet.py`, modify `tools/blender/build_earth.py`, modify helpers only where tests demonstrate a missing capability.

- [ ] Add a headless acceptance mode taking `--id earth` and `--output-root`; initially verify it fails because the entry does not exist.
- [ ] Build surface/cloud meshes with shared geometry, apply Blender Z scale `polarRadiusRatio`, apply transforms, wire `mat_surface`/`mat_clouds`, export via canonical GLB helper, copy approved authoring textures, and print manifest.
- [ ] Make `build_earth.py` a compatibility delegate so `build_all.py --only earth` uses the same implementation.
- [ ] Run Blender twice to separate build roots and compare complete authored hash trees; require 32,256 triangles, equatorial radius 1, and catalogued polar ratio.
- [ ] Regenerate committed Earth artifacts and commit `feat(assets): [T0032] generalize Earth planet builder`.

### Task 4: Runtime ingest and delivery

**Files:** update `docs/asset-pipeline.md`, `tools/README.md`, `tasks/T0032-build-planet-earth.yaml`, regenerated `public/assets/**`.

- [ ] Run two focused ingests with `KTX_BIN=C:\Program Files\KTX-Software\bin\ktx.exe`; compare SHA-256 trees and require Earth <=20 MiB.
- [ ] Run `npm test`, `npm run test:tools`, lint, typecheck, format, build, task schema, budgets, and `npm run assets:verify`.
- [ ] Move T0032 to REVIEW, document exact evidence, rebase on `origin/main`, push, open PR, obtain independent review, and merge only with green CI.
