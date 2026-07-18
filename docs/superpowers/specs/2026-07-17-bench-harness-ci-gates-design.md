# T0092 Bench Harness and CI Performance Gates Design

## Goal

Add a reproducible production-build benchmark and CI gates for the deterministic performance invariants in `docs/performance-spec.md` section 6. Absolute FPS remains a reference-hardware measurement; CI enforces workload, retained heap, and bundle budgets that remain meaningful on SwiftShader.

## Production benchmark

`npm run bench` builds the application, starts a strict-port Vite preview, prefers the installed stable Chrome with hardware acceleration and precise heap metrics, and measures the real production page. On Windows it requests ANGLE/D3D11 explicitly; if stable Chrome is unavailable it falls back visibly to bundled Chromium, whose software-renderer identity remains recorded in the report. It applies the High quality lock before startup so the adaptive governor cannot change the workload during a run.

The scripted path contains 900 measured animation frames (300 percentile samples per leg) and represents 180 virtual seconds. This makes p99 robust to individual transition frames while keeping software-rasterizer runs practical without changing the route:

1. 0-60 s: low Earth orbit view;
2. 60-120 s: Moon flyby, selected through the real camera input path;
3. 120-180 s: Jupiter approach, selected through the real camera input path.

A fixed seed (`0x5a17c0de`) creates a precomputed zoom/orbit input schedule. The page driver allocates outside the application frame loop; production code remains unchanged. The canonical 120-frame telemetry warm-up completes before measurement; the harness does not duplicate it. The JSON report records schema version, git SHA, environment, path definition, median/p75/p99 rAF interval, median/p75/p99 in-frame game work, draw calls, triangles, console/page errors, and per-leg summaries under `docs/bench/`. The rAF interval preserves player-visible scheduler stalls; the game-work duration (`performance.now()` after the main callback minus the common rAF timestamp) isolates application work for reproducibility checks. Memory is split into the route delta, which exposes legitimate lazy asset loading, and a steady-state delta measured after 30 seconds of settling followed by another 30 measured seconds at Jupiter, with explicit out-of-frame-loop GC at each boundary.

Two-run mode first executes two unreported routes to prime lazy assets, shaders, browser code caches, and per-page startup paths, so both recorded routes start from the same warmed process state. It then compares game-work median, p75, and p99 for each homogeneous flight leg with a symmetric relative difference below 5%, requires exact workload counts, and reports both raw runs. rAF intervals remain descriptive because OS scheduling is outside the workload and mixing the distinct Earth, Moon, and Jupiter distributions creates unstable aggregate quantile boundaries. Timestamp, SHA, GPU identity, route heap delta, and steady-state heap delta are evidence fields rather than stability keys.

## CI performance contract

The performance gate also runs against the production build with the High quality lock.

- Draw calls and triangles are sampled from `RenderTelemetry` after four identical snapshots. Committed golden counts permit a symmetric ±10% range.
- Retained JS heap is measured after warm-up over 30 seconds of animation frames, with explicit GC before and after. A small fixed tolerance absorbs Chromium measurement noise; fixture growth is orders of magnitude larger.
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
