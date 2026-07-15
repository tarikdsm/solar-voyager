# ADR-008: WebGL2 renderer with forced hardware acceleration + adaptive quality governor

**Status:** accepted (2026-07-15)

## Decision

1. v1 renders with three.js **`WebGLRenderer` (WebGL2)**, created with `powerPreference: 'high-performance'` and a `failIfMajorPerformanceCaveat: true` first attempt to force real GPU acceleration; software-rasterizer detection (caveat flag + `WEBGL_debug_renderer_info` heuristics) triggers a user-facing warning banner with fix instructions.
2. Depth: **`reversedDepthBuffer` when `EXT_clip_control` is available** (faster — keeps early-Z — and more precise), falling back to `logarithmicDepthBuffer`. This supersedes the log-depth-only wording of rendering-spec §2.
3. A runtime **adaptive quality governor** (p75 frame time, hysteresis, ordered knob ladder starting with render scale) holds the 60 fps floor; full contract in `docs/performance-spec.md`.
4. **WebGPU is a planned post-v1 migration**, not a v1 target: three's `WebGPURenderer` auto-falls-back to WebGL2 and its API is near-drop-in, so we keep custom shader code minimal and portable, and revisit with a dedicated ADR after v1.

## Why

- WebGL2 is the mature path for everything this game already specifies (UnrealBloomPass chain, KTX2/Draco loaders, log/reversed depth) and runs everywhere GitHub Pages reaches; WebGPU in 2026 is broadly available but its three.js ecosystem (TSL post-processing) would force rewrites of specified components mid-project with three agents.
- `failIfMajorPerformanceCaveat` is the only standard mechanism to *refuse* software rendering; pairing it with a retry + banner keeps the game runnable while making degraded environments impossible to miss — satisfying "force the browser to use 3D acceleration" as far as the web platform allows.
- A measured governor (not static presets) is the only honest way to promise "minimum 60 fps" across unknown hardware; ordering the knob ladder by perceptual-cost-per-ms makes degradation invisible-first.

## Consequences

- Two depth paths must both be tested (CI z-artifact scenes).
- Custom shaders stay small and TSL-portable; heavy visual features (relativistic pass, atmosphere scattering) are written with the WebGPU migration in mind.
- The governor owns quality settings at runtime; the settings menu exposes tier lock (user override always wins).
