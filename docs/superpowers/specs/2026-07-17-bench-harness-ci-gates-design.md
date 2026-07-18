# T0092 Bench Harness and CI Performance Gates Design

## Goal

Add a reproducible production-build benchmark and CI gates for the deterministic performance invariants in `docs/performance-spec.md` section 6. Absolute FPS remains a reference-hardware measurement; CI enforces workload, retained heap, and bundle budgets that remain meaningful on SwiftShader.

## Production benchmark

`npm run bench` builds the application, starts a strict-port Vite preview, prefers the installed stable Chrome with hardware acceleration and precise heap metrics, and measures the real production page. On Windows it requests ANGLE/D3D11 explicitly; if stable Chrome is unavailable it falls back visibly to bundled Chromium, whose software-renderer identity remains recorded in the report. It applies the High quality lock before startup so the adaptive governor cannot change the workload during a run.

The scripted path contains 900 measured animation frames (300 percentile samples per leg) and represents 180 virtual seconds. This makes p99 robust to individual transition frames while keeping software-rasterizer runs practical without changing the route:

1. 0-60 s: low Earth orbit at 400 km altitude;
2. 60-120 s: Moon flyby at 1,000 km altitude;
3. 120-180 s: Jupiter approach at 150,000 km altitude.

A fixed seed (`0x5a17c0de`) creates a precomputed zoom/orbit input schedule. Canonical route checkpoints are generated through the real simulation constructors and validated for target-body dominance. The Playwright driver loads each checkpoint through the production session save/load path at t=0/60/120/180, verifies the persisted time and navigation target, and observes the expected dominant body in the rendered HUD. The simulation continues stepping normally between checkpoints, while camera target changes still use the real input path. The page driver allocates outside the application frame loop; production runtime code remains unchanged. The canonical 120-frame telemetry warm-up completes before measurement; the harness does not duplicate it. The JSON report records schema version, git SHA, environment, path definition, checkpoint evidence, median/p75/p99 rAF interval, median/p75/p99 in-frame game work, draw calls, triangles, console/page errors, and per-leg summaries under `docs/bench/`. The rAF interval preserves player-visible scheduler stalls; the game-work duration (`performance.now()` after the main callback minus the common rAF timestamp) isolates application work as descriptive evidence. Memory is split into the route delta, which exposes legitimate lazy asset loading, and a steady-state delta measured after 30 seconds of settling followed by another 30 measured seconds at Jupiter, with explicit out-of-frame-loop GC at each boundary.

Two-run mode first executes two unreported routes to prime lazy assets, shaders, browser code caches, and per-page startup paths, so both recorded routes start from the same warmed process state. It then compares the reported aggregate rAF median, p75, and p99 with a literal symmetric relative-difference calculation; every value must vary by less than 5%. The final steady-state heap footprint uses the same literal comparison, while retained heap growth remains governed by its fixed zero-growth tolerance. Exact workload counts are also required, and both raw runs are reported. Timestamp, SHA, GPU identity, per-leg values, route heap delta, and steady-state heap delta remain descriptive evidence rather than substitutes for the reported stability keys.

## CI performance contract

The performance gate also runs against the production build with the High quality lock.

The gate's page harness delivers the single production animation callback through a preallocated zero-delay macrotask. This does not skip frames or change workload counts; it prevents an uncapped software renderer from starving Playwright's telemetry and GC commands on Linux CI. The production application and reference-hardware benchmark retain native rAF scheduling.

- Draw calls and triangles are sampled from `RenderTelemetry` after four identical snapshots. Committed golden counts permit a symmetric ±10% range.
- Retained JS heap is measured after a 60-second late-initialization settling window over 30 seconds of animation frames, with explicit GC before and after. A fixed 192 KiB tolerance absorbs the repeatable ~181 KiB SwiftShader bookkeeping delta observed on Linux CI (less than 0.2% of its ~95 MB heap); the 256 KiB-per-frame fixture growth remains several times larger.
- Bundle sizes are measured from `dist/` after build. Entry JavaScript gzip size and total JavaScript/CSS gzip size have explicit committed ceilings, while the existing critical-path gate remains authoritative for WASM and startup assets.
- Browser console/page errors fail the gate.

The main CI command runs the positive production contract and two negative self-tests:

1. an init-script wraps `requestAnimationFrame` and retains a typed array per frame; the heap validator must reject it;
2. an init-script adds a fixed workload offset to exposed telemetry snapshots; the draw-call validator must reject it.

Fixture runs use a short duration because they only prove rejection. The production heap run always uses the required 30 seconds in CI.

## Structure

- `tools/perf/performanceGateUtils.mjs`: pure parsers, percentile/stability comparison, workload/heap/bundle validation.
- `tools/perf/performanceGateUtils.test.mjs`: TDD coverage including both injected failures.
- `tools/perf/performanceGate.mjs`: preview lifecycle, production measurement, fixtures, and CLI.
- `tools/bench/flightBench.mjs`: deterministic flight orchestration and committed JSON report.
- `tools/perf/performance-golden.json`: versioned workload and bundle contract.
- `.github/workflows/ci.yml`: one performance-gate step after the production build.

## Failure policy

Missing precise heap metrics, unstable workload snapshots, browser errors, occupied ports, fixture acceptance, or malformed golden/report documents fail closed. Gates are never auto-rebased from the current result; golden changes are explicit reviewable commits.
