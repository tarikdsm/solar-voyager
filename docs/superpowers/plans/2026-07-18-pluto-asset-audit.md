# Pluto Asset Audit Implementation Plan

> **Task:** T0093 — reconcile the existing Pluto authoring source with the canonical asset pipeline without changing its approved appearance.

## Goal

Make `tools/blender/build_pluto.py` reproducible and catalog-driven, preserve the normalized Pluto surface and textures, and prove that the canonical runtime artifacts satisfy structure, provenance, visual, and dwarf-budget requirements.

## 1. Lock the source contract with tests

- Add a pure-Python Pluto configuration test before production changes.
- Require catalog schema v2, body kind `dwarf`, Pluto's physical/visual values, canonical source/output names, preferred 4k preview input, and an actionable missing-file error.
- Require the committed provenance record to identify the NASA/JPL source, public-domain status, and deterministic procedural-detail generator/seed.
- Run the focused test and record the expected red failure while the configuration module is absent.

## 2. Migrate the Blender builder to shared authoring primitives

- Add `pluto_config.py` as the pure catalog and file-contract boundary.
- Rewrite `build_pluto.py` around `common` scene, geometry, material, export, GLB-normal, and manifest helpers.
- Keep the guide-prescribed 64×32 UV sphere (3,968 triangles), radius 1, `mat_surface`, roughness 0.78, and external maps; longitude-converged polar texture rows remove the starburst found during independent runtime review without changing the topology contract.
- Add isolated output and review-blend arguments so reproducibility can be tested without mutating canonical assets.
- Emit a stable JSON manifest and enforce exact triangle/radius invariants.

## 3. Prove reproducibility and source compliance

- Run the focused Python suite green.
- Build twice into isolated directories with Blender 5.1 and compare source GLB and published-file hashes.
- Inspect the GLB for normalized bounds, material/node names, external-image policy, and absence of cameras, lights, and animations.
- Regenerate the canonical source asset only after isolated results pass.

## 4. Run canonical ingest and acceptance checks

- Install workspace dependencies and locate the canonical KTX CLI.
- Run Pluto-only ingest and its validators.
- Confirm runtime GLB/KTX2 files are individually and collectively within the 4 MB dwarf budget.
- Render/inspect representative equatorial, seam, and polar views of both the Blender source and ingested asset; compare against the approved preview and check for UV seam or pole distortion.

## 5. Verify, review, and deliver

- Run all directly affected Python, asset, and project checks.
- Request the independent review required by `docs/task-protocol.md`, address actionable findings, and rerun verification.
- Mark T0093 done with evidence in its handoff, commit atomically, push, and merge through the repository's standard delivery flow.
