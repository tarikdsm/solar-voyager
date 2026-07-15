# ADR-004: No ECS — layered plain modules with enforced import direction

**Status:** accepted (2026-07-15)

## Decision

No entity-component-system framework. Plain TypeScript modules in layers `core ← sim ← game ← render/ui`, direction enforced by ESLint `import/no-restricted-paths`. `SimulationCore` is the single source of truth, exposing an immutable per-frame `SimSnapshot`; player intent enters via one `Commands` interface.

## Why

- The domain is ~50 bodies + 1 ship. ECS buys generality we don't need and forces three different agents to learn a framework.
- The two typed interfaces (`SimSnapshot`, `Commands`) are the only meeting point between physics work and UI/render work — the key enabler for parallel multi-agent development.
- Lint-enforced layering means an agent *cannot silently* violate the architecture.

## Consequences

If v2+ ever needs many dynamic entities (debris, stations), revisit; the snapshot pattern ports to ECS without breaking consumers.
