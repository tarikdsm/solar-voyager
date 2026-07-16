# Asset Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Validate authored models and deterministically emit Draco/KTX2 runtime
assets plus a canonical manifest.

**Architecture:** Small pure validation modules inspect source GLB and texture
metadata before an orchestration layer invokes pinned glTF-Transform/Draco and a
KTX-Software command adapter. Publication is staged and atomic.

**Tech Stack:** Node.js 22+, Vitest 4, glTF-Transform 4.4.1,
draco3dgltf 1.5.7, Sharp 0.35.3, KTX-Software 4.4.x.

---

### Task 1: Lock contracts with failing validation tests

**Files:**
- Create: `tools/assets/assetIngest.mjs`
- Create: `tools/assets/glb.mjs`
- Create: `tools/assets/config.mjs`
- Create: `tools/assets/assetIngest.test.mjs`

- [ ] Build temporary minimal GLB and image fixtures.
- [ ] Require combined wrong-scale, embedded-image, and missing-SOURCES
  diagnostics to cite guide sections 2, 3, and 8.
- [ ] Add focused tests for discovery, triangle/category limits, texture format
  and aspect rules, forbidden cameras/lights/animations, and attribution.
- [ ] Run the focused tests and observe the expected failure.

### Task 2: Implement source discovery and validation

**Files:**
- Implement: `tools/assets/config.mjs`
- Implement: `tools/assets/glb.mjs`
- Implement: `tools/assets/assetIngest.mjs`

- [ ] Parse GLB headers/JSON safely and expose raw authoring violations.
- [ ] Discover singleton and body-directory layouts in stable order.
- [ ] Load geometry, compute world-space bounds/radius, and count triangles.
- [ ] Validate texture metadata and `SOURCES.md` coverage.
- [ ] Aggregate actionable findings without writing public output.
- [ ] Run focused tests to green and commit the validation core.

### Task 3: Implement deterministic processing and publication

**Files:**
- Create: `tools/assets/processAsset.mjs`
- Create: `tools/assets/ktx.mjs`
- Create: `tools/assets/ingestCli.mjs`
- Create: `tools/assets/processAsset.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Add pinned glTF-Transform, Draco, and Sharp dependencies.
- [ ] Add failing tests for Draco options, KTX mode selection, canonical
  manifest bytes, budget rejection, failed-run preservation, and two-run hashes.
- [ ] Encode Draco at 14/10/12 and rewrite external texture references to KTX2.
- [ ] Encode ETC1S color/UASTC normal textures with full mips and one worker.
- [ ] Publish a fully regenerated staging tree atomically.
- [ ] Expose `npm run assets:ingest` and `npm run assets:verify`.
- [ ] Run focused tests to green and commit processing.

### Task 4: Exercise the real Earth acceptance fixture

**Files:**
- Create: `tools/assets/verifyEarth.mjs`
- Modify as required: `assets/models/planets/earth/*`
- Generate: `public/assets/**`

- [ ] Install/use KTX-Software 4.4.x from the official release.
- [ ] Run Earth-only ingest and require total output below 20 MiB.
- [ ] Validate Draco and KTX2 extensions/headers.
- [ ] Hash the complete output, rerun, and require identical hashes.
- [ ] Run the full repository ingest and budget gate.

### Task 5: Document, verify, and deliver

**Files:**
- Modify: `docs/asset-pipeline.md`
- Modify: `assets/models/MODELING-GUIDE.md`
- Modify: `assets/README.md`
- Modify: `public/assets/README.md`
- Modify: `tools/README.md`
- Modify: `tasks/T0035-asset-ingest-pipeline.yaml`

- [ ] Document setup, supported KTX version, deterministic guarantees,
  manifest layout, validation sections, and regeneration commands.
- [ ] Run lint, typecheck, all tests, format check, build, task checks, budget
  checks, real asset verification, and `git diff --check`.
- [ ] Move T0035 to REVIEW, push the branch, open a PR, and hand independent
  review/merge to a different agent.

