# T0021 Full Catalog Bake Implementation Plan

> Execute with test-driven development and verify each checkpoint before continuing.

**Goal:** Bake the complete 43-body v1 catalog and three-epoch heliocentric check set from pinned, unambiguous JPL Horizons targets.

**Architecture:** Extend the setup-only Python definition table and query adapter. Body topology drives parent-relative element centers; runtime JSON remains schema v1 and parent-first. Production TypeScript remains unchanged, but its full-field goldens are intentionally regenerated after the data expansion.

**Tech stack:** Python 3.9+, Astroquery/JPL Horizons, JSON Schema/Ajv, Vitest.

---

### Task 1: Record branch semantics and sources

**Files:**
- Modify: `docs/physics-spec.md`
- Modify: `tools/README.md`
- Create: `docs/decisions/ADR-018-body-kind-independent-kepler-branches.md`

1. Correct the Kepler text so eccentricity/sign, not `kind`, selects the branch.
2. Document generalized centers, small-body resolution, pinned comet records, 43-body scope, and primary metadata sources.
3. Record why the integer schema remains sufficient and why both catalog comets are elliptic.

### Task 2: Expand the definition table with TDD

**Files:**
- Modify: `tools/tests/test_bake_ephemerides.py`
- Modify: `tools/bake_ephemerides.py`

1. Write failing tests for the exact 43 ids, class counts, parent-before-child order, unique procedural seeds, and pinned comet records.
2. Run the Python suite and confirm the expected definition failures.
3. Add physical metadata definitions for all listed dwarfs, moons, asteroids, and comets using the documented JPL source hierarchy.
4. Run tests green and verify every numeric field is finite/schema-compatible.

### Task 3: Generalize query routing with TDD

**Files:**
- Modify: `tools/tests/test_bake_ephemerides.py`
- Modify: `tools/bake_ephemerides.py`

1. Write failing adapter tests for a giant moon parent center, Charon/Pluto center, numbered small-body `id_type`, and unique comet record ids.
2. Add setup-only query resolution metadata to `BodyDefinition`.
3. Derive the element center from `parent_id`; keep vectors heliocentric.
4. Validate the returned `(a,e)` pair before publication with a body-naming error.
5. Run the complete offline Python suite.

### Task 4: Bake and validate real J2026 data

**Files:**
- Modify: `data/bodies.json`
- Modify: `data/ephemerides-check.json`
- Modify: `data/bodies.test.ts`

1. Run the full network bake using the pinned requirements and cache.
2. Inspect all 43 bodies, three complete check epochs, topology, finite values, SOI positivity, and exact comet branches.
3. Extend data tests to lock the full canonical id list and assert 1P/67P are elliptic with positive semimajor axes.
4. Run schema/data tests and the compiled-rails unit suite.

### Task 5: Refresh dependent full-field goldens

**Files:**
- Modify: `tests/golden/leo-30d.json`
- Modify: `tests/golden/earth-mars-transfer-30d.json`
- Modify: `tests/golden/jupiter-flyby-30d.json`

1. Confirm the existing golden regression fails after the catalog expansion for physical state drift, not metadata corruption.
2. Run `npm run golden:regen -- --update-goldens`.
3. Inspect step budgets and state diffs; commit only golden JSON in a separate `golden:` commit.
4. Run the golden regression green on Windows and focused Linux Node 22.

### Task 6: Verify and deliver

1. Run `npm test`, `npm run test:tools`, `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`, `npm run check:tasks`, and `npm run check:budgets` sequentially.
2. Request independent code/data review and resolve findings with re-verification.
3. Move T0021 to `REVIEW`, push, open `[T0021] Full ~50-body catalog bake`, and hand CI/DONE/merge to the independent reviewer.
