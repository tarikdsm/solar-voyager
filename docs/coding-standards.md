# Coding Standards — Solar Voyager

## Language & tooling

- TypeScript, `strict: true`, no `any` (use `unknown` + narrowing). Target ES2022.
- Vite for dev/build; Vitest for tests; ESLint + Prettier (repo configs are canonical — run `npm run lint` before pushing).
- English everywhere: code, comments, commits, docs, UI text.

## Module rules

- Import direction `core ← sim ← game ← render/ui` is enforced by ESLint `import/no-restricted-paths`. If the linter blocks you, your design is wrong — do not disable the rule.
- `src/sim/` and `src/core/`: pure TS. No three.js, no DOM, no `Date.now()`, no globals, no I/O. Data in, data out.
- One concept per file; files > ~300 lines are a smell — split.
- Physics code cites the spec: `// physics-spec.md §3.1` above each implemented formula.

## Naming

- Files: `camelCase.ts` (matching main export), Preact components `PascalCase.tsx`.
- Physical quantities carry units in the name when ambiguous: `altitudeKm`, `speedKmS`, `timeSec`, `deltaVMS`. Radians are the default for angles (`pitchRad`); degrees only in UI formatting.
- Body ids: lowercase canonical names (`earth`, `io`, `67p`).

## Tests

- Everything in `src/sim` and `src/core` ships with unit tests in the same PR — no exceptions.
- Regression tests follow `physics-spec.md` §7; tolerances come from the spec, never invented ad hoc.
- Golden-file changes must be intentional: a separate commit titled `golden: <reason>`.
- Render/UI: Playwright smoke test (page loads, canvas renders, no console errors) from M3 on.

## Commits & PRs

- Conventional-style prefix + task id: `feat(sim): [T0012] kepler solver with hyperbolic branch`.
- Prefixes: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`, `assets`, `golden`.
- One task per PR. PR title: `[T0012] Kepler solver`. PR description links acceptance criteria and states how each was verified.
- CI (lint, typecheck, tests, build, budgets) must be green; no force-merges, no `--no-verify`.

## Comments & docs

- Comment constraints and non-obvious physics, not narration. Cite spec sections and paper/table sources (e.g., "USSA-1976 table 4").
- Public interfaces (`SimSnapshot`, `Commands`, module entry points) get doc comments.
- If you change behavior described in a `docs/*.md`, update the doc in the same PR.

## Dependencies

- Adding a runtime dependency requires an ADR. Dev-dependencies are fine if mainstream and maintained.
- No physics/math libraries for core mechanics — the sim is our own (that's the point). Small vetted utilities are acceptable with an ADR.
