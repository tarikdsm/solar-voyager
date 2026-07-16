# Blender Common Helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Provide reusable Blender authoring helpers, a deterministic multi-builder
entry point, and a real headless sphere-to-ingest acceptance path.

**Architecture:** Blender-specific helpers are split by responsibility, while the
orchestrator keeps discovery/argument logic importable under ordinary Python for
CI tests. A temporary smoke builder proves the full Blender/export/ingest boundary.

**Tech Stack:** Blender 5.1 Python/bpy, Python 3.9+ standard library tests,
glTF 2.0 GLB, existing Node asset ingest.

---

### Task 1: Lock orchestration behavior with failing tests

- Create `tools/tests/test_blender_build_all.py`.
- Test sorted builder discovery, exclusion rules, `--all`, repeated `--only`,
  duplicate/unknown ids, catalog mismatch, and deterministic run order.
- Run the focused Python test and observe the missing-module failure.

### Task 2: Implement the common package and orchestrator

- Create `tools/blender/common/{__init__,catalog,scene,geometry,materials,export,manifest}.py`.
- Create `tools/blender/build_all.py` with pure discovery/parse functions and a
  Blender-time `main()`.
- Implement normalized geometry, PBR texture color spaces, strict export flags,
  evaluated triangle/radius measurement, and stable manifest output.
- Run ordinary Python tests to green.

### Task 3: Migrate Sun and build the smoke fixture

- Refactor `tools/blender/build_sun.py` to the common API without changing its
  artistic contract.
- Create `tools/blender/build_test_sphere.py` with `--output-root`.
- Create `tools/run_blender_smoke.py` to locate Blender from `BLENDER_PATH` or the
  documented Windows location, run the fixture, inspect its manifest output, and
  invoke T0035 ingest into temporary output.
- Add `npm run test:blender`.

### Task 4: Run real acceptance and document operation

- Execute Blender 5.1 headless smoke and verify raw GLB radius/sections.
- Run T0035 ingest and verify the runtime Draco GLB.
- Run `build_all.py --only sun` and `--all` argument/dry-run checks; avoid
  unnecessary regeneration of artistic assets.
- Document helper API, commands, supported-id behavior, and troubleshooting in
  `docs/asset-pipeline.md` and `tools/README.md`.

### Task 5: Verify and deliver

- Run lint, typecheck, Vitest, Python tools, format, build, task schema, budgets,
  Blender smoke, and diff check.
- Move T0030 to REVIEW, push, open a PR, and hand independent review/merge to a
  different agent.

