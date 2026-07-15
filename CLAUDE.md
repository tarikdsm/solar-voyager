# Solar Voyager — Agent Entry Point (Claude Code)

Realistic browser-based solar-system exploration game. Three.js + TypeScript + Vite + Preact, custom float64 n-body physics, Blender-scripted assets, deployed to GitHub Pages.

## Before any work

1. Read `docs/architecture.md` (module map, layering, invariants).
2. Read `docs/task-protocol.md` (how work is claimed and delivered — MANDATORY).
3. Pick a task from `tasks/` following the protocol. Never code outside a claimed task.

## Hard rules

- `src/sim/` and `src/core/` are pure TypeScript: no three.js, no DOM, no side effects. Import direction: `core ← sim ← game ← render/ui`.
- All physics in float64, units km / km/s / s / km³/s² (see `docs/physics-spec.md`).
- Every formula you implement must match `docs/physics-spec.md`; if it isn't there, add it there in the same PR.
- Changes to `SimSnapshot`, `Commands`, the `bodies.json` schema or `physics-spec.md` require an ADR in `docs/decisions/`.
- Tests required for all `src/sim` code (Vitest). CI must pass before merge.
- **Performance is a spec, not a polish pass:** zero allocations in the frame loop, no runtime material/geometry creation, precompiled shaders, instancing for repeated objects — full mandatory rules in `docs/performance-spec.md` §5. CI enforces heap-growth-zero and budget gates; 60 fps is a floor.
- Blender scenes are code: edit `tools/blender/*.py`, never hand-edit exported `.glb`.

## Shared resources

- Procedural skills (agent-agnostic): `agents/skills/*.md` — read the relevant one before the matching task type.
- MCP servers: `.mcp.json` (blender-mcp for interactive Blender, context7 for library docs).
- Blender path (this machine): `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`.

Commit format and code style: `docs/coding-standards.md`.
