# ADR-032: v2.0 kickoff — scope, pillars, WebGL2 reaffirmed, budget-revision policy

**Status:** accepted (2026-08-14)

## Context

v1.0 shipped (tag `v1.0.0`, 2026-07-19) as an instrumented planetarium: physically
excellent, but the maintainer's own audit (2026-08-14, four subsystem deep-dives)
found the ship itself is never rendered, piloting is abstract (SVG navball, no
world feedback, warp-multiplied tumbling), reaching other bodies requires manual
orbital mechanics the maintainer — the game's own author — could not perform in
practice, and visuals sit far below the engineering substrate's quality (34 of 43
bodies untextured, no atmosphere scattering, no shadows/eclipses, no audio). v2.0
re-aims the game layer and presentation around that finding without reopening the
physics core. The approved design is
`docs/superpowers/specs/2026-08-14-v2-free-flight-design.md`; its implementation
plan is `docs/superpowers/plans/2026-08-14-v2-free-flight.md`. T0102 generalized
`releaseReadiness` so v2 task files can land incrementally without blocking on
v1's "every task DONE" rule (ADR-033); this task (T0103) is the first v2 docs
task and needs one ADR that (a) anchors what v2 is and is not scoped to do,
(b) settles the rendering-stack question before any render work starts, and
(c) states, once, the budget-revision policy every later budget-raising commit
cites instead of re-litigating it per task.

## Decision

1. **Scope.** v2.0 is a targeted transformation of the existing v1 foundation
   (`core`/`sim` stay pure and nearly frozen; new gameplay lives in `game/`;
   `render/`+`ui/` gain new systems) around five pillars, in priority order:
   1. **The ship is the protagonist** — always visible in third person (default),
      beautiful up close, with engine/RCS VFX; piloting must feel like flying.
   2. **Point-and-fly, physics-honest** — continuous proper-acceleration
      torchship flight (up to ~10 g cruise) plus automatic time compression
      makes any destination minutes away with zero physics cheating; relativity
      is a feature, not an obstacle.
   3. **Visually stunning at every scale** — four visual fronts, all committed:
      close-up planets (all 43 bodies), a sublime Sun, ship + engine VFX, deep
      sky + sense of motion.
   4. **Honest data, no lessons** — real values, correct units, visible physics
      (dual clocks, γ, energy in Wh); no tutorial-lecture content or "teacher
      mode" — the simulation itself is the lesson.
   5. **Sandbox + exploration diary** — total freedom from the first second; the
      game notices and records natural milestones (first orbit of each body,
      ring crossing, solar polar overflight, 0.9 c, twin-paradox return) with a
      local photo album.
2. **Non-goals for v2.0 (explicitly out of scope):**
   - Landing / surface operations (terrain, contact physics). **Collision
     detection and low flybys ARE in scope** — only touchdown is excluded.
   - The 2D Alcântara launch phase — `T0060`–`T0062` stay `BLOCKED`; the spec
     is preserved in the repo for a later expansion.
   - Docking, stations, multiple ships, missions/contracts, multiplayer, other
     star systems, mobile/touch.
   - WebGPU migration (see point 3 below).
   - Localized UI — game text stays English (existing repo convention).
3. **Rendering stack reaffirmed.** v2 continues to render with three.js
   `WebGLRenderer` (WebGL2), per ADR-008, unchanged. WebGPU migration stays
   deferred: ADR-008's decision point 4 already pre-authorizes "a dedicated ADR"
   for that migration whenever it is undertaken — v2 does not spend or narrow
   that authorization, it simply does not exercise it. Any future WebGPU work
   still requires its own dedicated ADR, written when that migration is
   actually scheduled, not implied by this one.
4. **Budget-revision policy (binding for every v2 task).** Budgets — bundle
   gzip, `public/assets`, repo size, draw calls/triangles, heap growth — are
   revised deliberately, never silently, and never merely to make a feature
   pass:
   - A task that legitimately moves a golden (draw calls, tris, heap, bundle)
     lands the change and the new golden in **separate commits within the same
     PR**: `feat(...): [T####] ...` then
     `golden(perf): [T####] re-baseline <metric>: <old> -> <new> (<reason>)`.
   - The PR description shows before/after numbers from the bench harness
     (`docs/bench/T####-summary.md`).
   - Raising a **budget ceiling** (not just a golden) additionally cites *this*
     ADR and gets explicit maintainer sign-off in review.
   - A gate weakening is never combined with an unrelated red-CI fix (the v1
     T0101 lesson: product deadlines and CI-runner-headroom fixes are separate
     commits).

## Consequences

- The five pillars and non-goal list are the scope boundary for every v2 task;
  reopening a non-goal (e.g. docking, landing) needs a new ADR and maintainer
  sign-off, not a task-level judgment call.
- Collision and low-flyby work (T0111, ADR-036) is confirmed in-scope by this
  ADR and needs no separate scope justification.
- `docs/roadmap.md`'s v2.0 section and every v2 task's `spec:` field point back
  to the design/plan docs named above as the spec of record; this ADR does not
  duplicate their content, only ratifies scope, rendering stack, and the
  budget policy.
- Every subsequent budget-ceiling raise in v2 (bundle, assets, repo, draw
  calls/tris, heap) cites this ADR per decision point 4, instead of each task
  inventing its own justification.
- WebGPU stays out of scope; nothing here changes the renderer contract or
  `docs/performance-spec.md` §2.

## Alternatives considered

- **Silent per-task budget increases:** rejected — the v1 budgets are
  CI-gated invariants (`docs/coding-standards.md` "Performance"); ungoverned
  drift across an estimated 55–70 v2 tasks would erase the discipline that
  made v1's perf gates trustworthy.
- **Revisiting WebGPU now:** rejected — the three.js WebGPU/TSL ecosystem
  still forces rewrites of already-specified components (unchanged rationale
  from ADR-008); v2 is scoped to the game layer and presentation, not a
  renderer migration, and reaffirming keeps the release's shader work
  portable rather than blocked on a platform switch mid-release.
- **No dedicated kickoff ADR (fold scope into the roadmap only):** rejected —
  non-goals that block real, frequently-requested features (docking, landing)
  need the higher bar of an ADR to reopen, and a single citable budget policy
  is only useful if every task can point at one stable document.
