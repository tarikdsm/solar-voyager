# T0091 adaptive quality governor — implementation plan

1. Add red unit tests for the 15 immutable quality profiles and the pure control
   law: overload streak, three-second cooldown, ten-second headroom, limits,
   repeated telemetry snapshots, lock precedence, action logging, and synthetic
   recovery within three steps without oscillation.
2. Implement `render/perfGovernor.ts` and extend allocation-free render telemetry
   with the bounded numeric quality-action ring.
3. Add red integration tests for reusable SMAA/FXAA passes, half/off bloom,
   star caps, Sun octaves, deferred texture caps, model-threshold scaling, and
   renderer/composer resize consistency; implement the minimal knob APIs.
4. Implement `RenderQualityController`, wire it to startup/settings/frame
   orchestration, replace the T0090 placeholder scalars, and preserve the
   software-renderer fallback.
5. Build a deterministic Chromium quality fixture and regression covering the
   synthetic load, lock override, hot-path allocations, shader-program stability,
   actual visual knobs, console errors, and all 15 rung screenshots.
6. Record the screenshot index and before/after performance evidence under
   `docs/bench/`, then run every static, unit, browser, build, budget, task, and
   production-playtest gate before independent review.

