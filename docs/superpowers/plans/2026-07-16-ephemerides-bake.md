# Ephemerides Bake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and validate the J2026 Sun/planet/Moon catalog and independent heliocentric regression vectors from JPL Horizons.

**Architecture:** A pure Python core normalizes Horizons-shaped rows and builds deterministic JSON documents; a thin lazy-import adapter performs remote Astroquery calls. JSON Schema plus offline Python and Vitest tests validate the committed artifacts without network access.

**Tech Stack:** Python 3.9+, astroquery 0.4.11, TypeScript/Vitest, Ajv 8, JSON Schema draft 2020-12.

## Global Constraints

- Use float64-compatible JSON numbers and km, km/s, seconds, radians, and km^3/s^2.
- Use J2026 `JD 2461041.5 TDB` and `149597870.7 km/AU` exactly.
- Planet elements are heliocentric; Moon elements are Earth-relative; all check vectors are heliocentric ecliptic J2000.
- No network access is required by CI tests.
- A failure before atomic replacement must leave committed JSON unchanged.
- The initial `bodies.json` schema is ADR-gated.

---

### Task 1: Pure bake core and unit tests

**Files:**
- Create: `tools/bake_ephemerides.py`
- Create: `tools/tests/test_bake_ephemerides.py`

**Interfaces:**
- Produces: `AU_KM`, `DAY_SEC`, `EPOCH_JD_TDB`, `CHECK_OFFSETS_DAYS`, `BODY_DEFINITIONS`, `elements_from_row(row)`, `state_from_row(row)`, `sphere_of_influence_km(a, child_mu, parent_mu)`, `build_catalog(elements_by_id)`, and `build_checks(vectors_by_id)`.

- [ ] **Step 1: Write failing conversion and document tests**

```python
class BakeCoreTests(unittest.TestCase):
    def test_converts_horizons_units(self):
        elements = bake.elements_from_row({
            "a": 2.0, "e": 0.1, "incl": 180.0,
            "Omega": 90.0, "w": 45.0, "M": 270.0,
        })
        self.assertEqual(elements["semiMajorAxisKm"], 2 * bake.AU_KM)
        self.assertAlmostEqual(elements["inclinationRad"], math.pi)
        state = bake.state_from_row({"x": 1, "y": 2, "z": 3, "vx": 4, "vy": 5, "vz": 6})
        self.assertEqual(state["positionKm"], [bake.AU_KM, 2*bake.AU_KM, 3*bake.AU_KM])
        self.assertEqual(state["velocityKmS"][0], 4*bake.AU_KM/bake.DAY_SEC)

    def test_builds_parent_order_and_soi(self):
        catalog = bake.build_catalog(sample_elements_for_all_bodies())
        self.assertEqual([body["id"] for body in catalog["bodies"]], bake.BODY_IDS)
        moon = next(body for body in catalog["bodies"] if body["id"] == "moon")
        self.assertEqual(moon["parentId"], "earth")
        self.assertGreater(moon["soiRadiusKm"], 0)
```

- [ ] **Step 2: Run tests and confirm missing-module failure**

Run: `python -m unittest discover -s tools/tests -p "test_*.py" -v`

Expected: FAIL because `tools/bake_ephemerides.py` does not exist.

- [ ] **Step 3: Implement constants, ordered metadata, conversions, and builders**

Use dataclass `BodyDefinition` for the ten ordered metadata rows. Require exact input keys, reject non-finite values, convert with `math.radians`, and construct dictionaries in canonical serialization order. `build_checks` emits samples for offsets `0`, `30`, `365` and exact zero Sun states.

- [ ] **Step 4: Run the Python suite**

Run: `python -m unittest discover -s tools/tests -p "test_*.py" -v`

Expected: all pure-core tests PASS without Astroquery installed.

- [ ] **Step 5: Commit**

```bash
git add tools/bake_ephemerides.py tools/tests/test_bake_ephemerides.py
git commit -m "feat(data): [T0020] add ephemerides bake core"
```

### Task 2: Catalog schema, ADR, and offline validation

**Files:**
- Create: `data/bodies.schema.json`
- Create: `data/bodies.test.ts`
- Create: `docs/decisions/ADR-013-body-catalog-schema.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: catalog/check document shapes from Task 1.
- Produces: closed draft-2020-12 JSON Schema and Ajv validation test.

- [ ] **Step 1: Add Ajv and write the failing artifact test**

Run: `npm install --save-dev ajv@^8.17.1`

Create `data/bodies.test.ts` to compile `bodies.schema.json`, validate
`bodies.json`, assert IDs
`sun,mercury,venus,earth,moon,mars,jupiter,saturn,uranus,neptune`, assert parent
topology, and verify all three check samples have finite position/velocity
triples for all IDs.

- [ ] **Step 2: Run the test and confirm missing-artifact failure**

Run: `npm test -- data/bodies.test.ts`

Expected: FAIL because schema and baked JSON do not exist.

- [ ] **Step 3: Add the closed schema and ADR-013**

The schema requires the exact root and body fields from the design, numeric
lower bounds for physical magnitudes, nullable Sun-only fields, six required
element fields, hex `albedoColor`, nullable `assetRef`, and uint32
`proceduralSeed`. ADR-013 records versioning, signed rotation, nullable root
fields, parent ordering, and heliocentric check-vector separation.

- [ ] **Step 4: Keep the focused test red for only the missing baked files**

Run: `npm test -- data/bodies.test.ts`

Expected: FAIL because `data/bodies.json` and `data/ephemerides-check.json` have not yet been baked, not because the schema is invalid.

- [ ] **Step 5: Commit**

```bash
git add data/bodies.schema.json data/bodies.test.ts docs/decisions/ADR-013-body-catalog-schema.md package.json package-lock.json
git commit -m "feat(data): [T0020] define body catalog schema"
```

### Task 3: Horizons adapter, CLI, and atomic output

**Files:**
- Modify: `tools/bake_ephemerides.py`
- Modify: `tools/tests/test_bake_ephemerides.py`
- Create: `tools/requirements-ephemerides.txt`

**Interfaces:**
- Produces: `query_body(body, cache)`, `bake(selected_ids, output_dir, cache)`, `atomic_write_json(path, document)`, and CLI flags `--only`, `--no-cache`, `--output-dir`.

- [ ] **Step 1: Write failing adapter/atomicity tests**

Patch a fake `Horizons` factory that records target, location, and epochs.
Assert planets use `500@10`, Moon elements use `500@399`, all vector calls use
`500@10` with the three exact JDs, and a raised query exception leaves existing
output bytes unchanged.

- [ ] **Step 2: Run tests and confirm missing API failures**

Run: `python -m unittest discover -s tools/tests -p "test_*.py" -v`

Expected: FAIL because query/bake/atomic APIs are absent.

- [ ] **Step 3: Implement lazy Astroquery adapter and CLI**

Instantiate `Horizons(id=str(horizons_id), id_type=None, location=center,
epochs=...)`; call `elements(refplane="ecliptic", cache=cache)` and
`vectors(refplane="ecliptic", cache=cache)`. Validate one element row and
three vector rows. Full bake queries all bodies before writing either output;
partial bake loads both existing documents and replaces only selected bodies.

- [ ] **Step 4: Verify CLI and unit tests offline**

Run:

```bash
python tools/bake_ephemerides.py --help
python -m unittest discover -s tools/tests -p "test_*.py" -v
```

Expected: help exits 0 and all tests PASS without importing Astroquery.

- [ ] **Step 5: Commit**

```bash
git add tools/bake_ephemerides.py tools/tests/test_bake_ephemerides.py tools/requirements-ephemerides.txt
git commit -m "feat(data): [T0020] query JPL Horizons atomically"
```

### Task 4: Bake artifacts, document workflow, and deliver

**Files:**
- Create: `data/bodies.json`
- Create: `data/ephemerides-check.json`
- Modify: `tools/README.md`
- Modify: `data/README.md`
- Modify: `tasks/T0020-bake-ephemerides.yaml`

**Interfaces:**
- Consumes: pinned Astroquery environment and CLI from Task 3.
- Produces: committed J2026 catalog/check artifacts and reviewer handoff.

- [ ] **Step 1: Install the pinned bake environment and run the full bake**

Run:

```bash
python -m pip install -r tools/requirements-ephemerides.txt
python tools/bake_ephemerides.py --no-cache
```

Expected: ten bodies and three vector epochs written; no partial files remain.

- [ ] **Step 2: Run offline data and Python validation**

Run:

```bash
python -m unittest discover -s tools/tests -p "test_*.py" -v
npm test -- data/bodies.test.ts
```

Expected: all tests PASS; schema validates and every body has three check states.

- [ ] **Step 3: Document sources and rerun commands**

Document Python setup, full/partial/cache commands, Horizons IDs/centers,
TDB/ecliptic semantics, physical-metadata sources, atomic behavior, and upstream
solution revision caveat in `tools/README.md`; summarize artifact roles in
`data/README.md`.

- [ ] **Step 4: Run all repository gates**

Run: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run format:check`, `npm run check:tasks`, `npm run check:budgets`, and the
Python unittest command.

Expected: every command exits 0.

- [ ] **Step 5: Commit artifacts and documentation**

```bash
git add data/bodies.json data/ephemerides-check.json tools/README.md data/README.md
git commit -m "data(catalog): [T0020] bake J2026 planets and Moon"
```

- [ ] **Step 6: Review, move task to REVIEW, push, and open PR**

Rebase on `main`, record commands/counts in `handoff_notes`, set
`status: REVIEW`, commit `chore(tasks): [T0020] move ephemerides bake to review`,
push `task/T0020-bake-ephemerides`, and open `[T0020] J2026 ephemerides bake`.
