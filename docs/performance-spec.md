# Performance Specification — Solar Voyager

This is the performance contract. **60 fps is a floor, not a goal.** Every implementing agent writes code against these rules from the first line — performance is designed in, never patched in. If a task's acceptance criteria conflict with this spec, this spec wins.

## 1. Targets & budgets

| Metric | Budget |
|---|---|
| Frame rate | ≥ 60 fps sustained on reference hardware (mid-range 2023+ laptop, integrated GPU, 1080p) |
| Frame budget | 16.6 ms, split: sim ≤ 2 ms · render ≤ 10 ms · UI/HUD ≤ 1 ms · headroom ≥ 3 ms |
| Draw calls (typical view) | ≤ 150 |
| Triangles (typical view) | ≤ 500k |
| Main-thread task | no single task > 4 ms during gameplay (chunk or move to worker) |
| GC pressure | zero allocations in the frame loop (see §5) |
| Startup to interactive | ≤ 5 s on a 20 Mbps connection (ties to the 8 MB critical path) |
| `pixelRatio` | `min(devicePixelRatio, 2)`, further scaled by the governor (§3) |

Higher-refresh displays (120/144 Hz): render at display rate when there's headroom; the governor only intervenes below the 60 fps floor.

## 2. GPU context policy — forcing hardware acceleration

The game must run on the real GPU, and must *know* when it isn't:

1. Create the WebGL2 context with `powerPreference: 'high-performance'` (requests the discrete GPU on dual-GPU machines) and `failIfMajorPerformanceCaveat: true` — this makes context creation FAIL if the browser would use a software rasterizer.
2. If step 1 throws/returns null, retry with `failIfMajorPerformanceCaveat: false` so the game still runs, but display a **non-dismissable-until-acknowledged warning banner**: "Hardware acceleration is disabled in your browser — the game will be slow", with per-browser instructions (Chrome: `Settings → System → Use graphics acceleration`; Firefox: `about:preferences` performance settings).
3. Additionally inspect `WEBGL_debug_renderer_info` (`UNMASKED_RENDERER_WEBGL`): if it matches `/SwiftShader|llvmpipe|Software|Basic Render/i`, show the same banner (belt and braces — some browsers don't honor the caveat flag).
4. Remaining context options: `antialias: false` (AA is the governor's job, §3), `stencil: false`, `alpha: false`, `preserveDrawingBuffer: false`, `desynchronized: true` (lower latency where supported), HalfFloat output buffer for the HDR pipeline.
5. Renderer identity, context flavor and effective options are recorded in the snapshot telemetry and shown in the perf HUD (§4).

**Depth strategy (updates rendering-spec §2):** prefer **`reversedDepthBuffer: true`** when `EXT_clip_control` is available — faster (keeps early-Z) and more precise than logarithmic depth; fall back to `logarithmicDepthBuffer: true` otherwise. The choice is made once at startup and reported in telemetry. Both paths must be CI-tested for z-artifacts (Earth from 200 km and from 1 AU).

## 3. Adaptive quality governor — the 60 fps contract

A small module (`render/perfGovernor.ts`) owns the quality/performance trade-off at runtime:

- **Measurement:** rolling window of the last 120 frame times (`performance.now()` deltas); the control signal is the **p75 frame time**. GPU timings via `EXT_disjoint_timer_query_webgl2` when available (telemetry only, not control — availability is spotty).
- **Control law:** if p75 > 15.5 ms for 2 consecutive windows → step DOWN one rung. If p75 < 11 ms for 10 s → step UP one rung. Cooldown of 3 s after any change; hysteresis prevents oscillation. Manual override in settings (lock to a tier) always wins.
- **Knob ladder** (ordered: most performance per least visual damage first):
  1. Render scale: 1.0 → 0.85 → 0.7 → 0.55 (internal resolution; canvas CSS size unchanged)
  2. Bloom: full-res → half-res → off
  3. AA: SMAA → FXAA → off
  4. Procedural shader octaves: full → half → minimum (ADR-010 — Sun granulation, gas-giant flow, detail noise)
  5. Star count cap: 9k → 4k → 2k
  6. Texture tier cap: full → 2k max → 1k max (applies on next lazy load)
  7. Tier-3 model threshold raised (bodies stay spheres longer)
- Every change is logged to telemetry and surfaced in the perf HUD as the current tier (e.g. `Q4/6`). The governor must never fight the user: a settings lock disables it.
- **Degradation is invisible-first:** the ladder was ordered so the player notices the FPS drop being fixed before they notice what paid for it.

## 4. Perf HUD (top-left, elegant)

`ui/hud/PerfPanel.tsx` + `render/telemetry.ts`. Two states:

- **Compact (default):** FPS (1 s average) + a 120-frame **frame-time sparkline** (reused Canvas 2D path, budget line at 16.6 ms) + render resolution (e.g. `1920×1080 @0.85`) + quality tier badge. One quiet row, monospace numerals, low-contrast until hovered — elegant, not a debug vomit.
- **Expanded (click/hotkey `F3`):** adds 1% low FPS, sim/render/UI ms split, draw calls & triangles (`renderer.info.render`), geometries/textures/programs counts (`renderer.info.memory`), JS heap (`performance.memory` where available), GPU name + context flavor (WebGL2/reversed-depth etc.), governor state and last action.
- Updates at 4 Hz (not 60) except the sparkline, which appends per frame into a preallocated ring buffer. The panel itself must cost < 0.2 ms/frame — a perf HUD that costs performance is a parody.

## 5. Mandatory code-level rules (enforced in review; violations block merge)

### Frame-loop hygiene (the golden rule)
- **Zero allocations per frame** in `sim/`, `render/`, and the rAF loop: no `new`, no array/object literals, no closures, no spread, no `.map/.filter/.slice`, no string building in hot paths. Use preallocated scratch objects (`const _v = vec3()` at module scope), object pools, and ring buffers. Exception: the immutable-per-frame `SimSnapshot` reuses double-buffered storage (write into buffer A while consumers read B — the "immutable" contract is per-frame, not per-allocation).
- Bulk state lives in **typed arrays, SoA layout** (`positionsX/Y/Z: Float64Array`), iterated with plain indexed `for` loops.
- No `try/catch`, `instanceof`, dynamic property access, or megamorphic call sites in hot loops; keep functions monomorphic so the JIT stays in optimized tiers.

### three.js-specific
- **Never create** materials, geometries, textures or render targets during gameplay — build at load/scene-setup; mutate uniforms, never rebuild.
- **Precompile shaders** during the loading screen (`renderer.compileAsync(scene, camera)`); zero runtime shader compilation (first-frame-near-Jupiter jank is a bug).
- Static objects: `matrixAutoUpdate = false`; update matrices manually only when moved. Flat scene graph — no deep Object3D chains.
- Asteroid belts / debris / markers: `InstancedMesh` or `THREE.Points`; one draw call per class, never one mesh per rock.
- Frustum culling stays ON; add distance culling (bodies below sprite threshold skip their mesh entirely — the tier ladder already guarantees this, verify with `renderer.info`).
- No `readPixels`, `getError`, or sync GPU queries in the loop (pipeline stalls).
- Textures: KTX2 (GPU-compressed, stays compressed in VRAM), mipmapped, anisotropy ≤ 4.
- Post chain: single half-float target chain, no redundant copies; bloom on a downscaled buffer.

### Workers & loading
- KTX2 transcoding and Draco decode run in three's workers (default — do not disable); trajectory prediction on its own worker (architecture.md).
- Decode images off-thread (`createImageBitmap`), fetch assets with `priority`/preload hints for the critical path; everything else lazy (rendering-spec §3).
- `data/initial-path.json` is the reviewed source of truth for runtime files fetched before interaction. The budget checker validates and sums those canonical files once, then adds all built code and WASM conservatively (ADR-023).
- Vite: code-split the map view and menus; no dependency > 50 KB gzip enters the bundle without an ADR (coding-standards).

### DOM / HUD
- Preact signals update leaf text nodes only — no re-render cascades; numeric readouts update at 10–20 Hz (imperceptible; FPS counter exempt), formatted via memoized formatters.
- Animate only `transform`/`opacity` (compositor-only); never touch layout-triggering properties per frame; `contain: strict` on HUD panels.

## 6. Measurement, regression, CI

- `render/telemetry.ts` is the single source of perf truth (frame times ring buffer, ms splits, renderer.info snapshots) — consumed by the perf HUD, the governor, and the bench harness. Sim exposes its own step time in the snapshot.
- **Bench harness (`npm run bench`):** deterministic scripted flight (fixed seed, fixed 3-minute path: LEO → Moon flyby → Jupiter approach) driven headlessly via Playwright; reports median/p75/p99 frame time, draw calls, triangles, JS heap growth (must be ~0 after warmup — the allocation rule, verified).
- **CI perf gates (every PR):** bundle-size budget; draw-call/triangle counts from the smoke test scene vs golden values (±10%); **heap-growth-zero check** on 30 s of simulated frames (catches frame-loop allocations mechanically, since CI GPUs are software and absolute fps is meaningless there).
- Absolute fps regressions are caught on reference hardware: the bench report is committed with perf-relevant PRs (`docs/bench/` history), and any PR touching `render/` or the frame loop must include before/after bench numbers in its description.

A production sample that exceeds the fixed heap ceiling by no more than 25% is
confirmed with one independent same-page window of the same duration. The
confirmation must meet the original ceiling; larger or repeated failures fail.
The known retained-allocation fixture is never eligible for confirmation.

## 7. Who enforces what

| Rule | Enforcement |
|---|---|
| Context policy, governor, HUD | Tasks T0090–T0092 acceptance criteria |
| Frame-loop allocation ban | CI heap-growth check + reviewer checklist (task-protocol review step) |
| Draw-call/triangle/bundle budgets | CI gates (`check:budgets`, smoke test) |
| Shader precompile, texture rules | rendering-spec + review |
| Bench before/after | PR template requirement for `render/`-touching PRs |
