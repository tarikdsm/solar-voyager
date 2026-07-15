# CI Check Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Deliver T0002 with deterministic task-schema/DAG and asset-budget validators, fixture-driven failure tests, npm scripts, and mandatory CI wiring.

**Architecture:** Node ESM checkers expose pure validation functions plus thin filesystem CLIs. The task checker parses YAML documents with the official `yaml` package and validates normalized unknown data. The budget checker walks an injected filesystem root using one source-of-truth limits object, so tests use real temporary directory fixtures rather than mocks.

**Tech Stack:** Node.js 22, Vitest, `yaml` parser, existing npm/Vite toolchain.

## Global Constraints

- Test-first red/green for every validation behavior.
- No runtime dependency: `yaml` is a development dependency used only by CI tooling.
- Errors name the offending file/field/dependency/budget and return nonzero CLI exit status.
- Filesystem traversal excludes `.git`, `node_modules`, worktrees, `dist`, coverage, and orchestration output from repo totals.
- Existing committed assets must pass; fixtures prove over-limit failures.

### Task 1: Task YAML schema and DAG checker

**Files:** Create `tools/checks/taskSchema.mjs`, `tools/checks/taskSchema.test.mjs`; modify `package.json`/lockfile.

- [ ] Write failing tests for valid queue, missing/extra field, invalid status, filename/id mismatch, duplicate id, unknown dependency, self-dependency, and multi-node cycle.
- [ ] Use `parseDocument(source, { uniqueKeys: true, prettyErrors: true, strict: true })`; surface document errors before `toJS()`.
- [ ] Validate exact template fields/types, `T####` ids, allowed statuses, empty ownership while TODO, nonempty ownership/branch while claimed/active/review, unique ids, dependency existence, and acyclic graph.
- [ ] CLI defaults to `tasks/`, validates all `T*.yaml` except `_template.yaml`, prints count on success, exit 1 on findings.
- [ ] Run focused/full gates; commit `feat(ci): [T0002] validate task schema and dependency DAG`.

### Task 2: Asset budget checker

**Files:** Create `tools/checks/assetBudgets.mjs`, `tools/checks/assetBudgets.test.mjs`.

- [ ] Write failing temp-directory tests for repo total >300 MB, public/assets >150 MB, critical path >8 MB, planet model triangle metadata >50k, and asteroid metadata >5k; include boundary-equal pass cases.
- [ ] Implement streaming/stat-based byte totals without loading asset bytes. Critical path is `dist/` code plus matching Sun/Earth/Moon/stars runtime artifacts under `public/assets/`; deduplicate paths.
- [ ] Read optional generated asset manifest JSON when present for triangle counts; absence is not an error before T0035, malformed manifest is.
- [ ] CLI defaults to repository root, prints measured totals/limits, exit 1 with all violations.
- [ ] Run focused/full gates; commit `feat(ci): [T0002] enforce asset budget limits`.

### Task 3: npm and GitHub Actions integration

**Files:** Modify `package.json`, `.github/workflows/ci.yml`, `tasks/T0002-ci-check-scripts.yaml`.

- [ ] Add `check:tasks` and `check:budgets` scripts without `--if-present` semantics.
- [ ] Update CI steps to call both scripts unconditionally after build; retain Node 22/npm ci and existing gates.
- [ ] Run schema checker against real queue, budget checker against repository, all tests, lint, typecheck, build, format, and diff check.
- [ ] Set T0002 to REVIEW with exact fixture/gate evidence; commit `chore(tasks): [T0002] ready for review`, push, open PR.
- [ ] Independent reviewer verifies, marks DONE, and merges only with CI green.
