# T0054 HUD Framework Implementation Plan

1. Add failing tests for HUD signal publication, sampling cadence, exact
   osculating values, formatting, and leaf-level reactivity.
2. Implement the allocation-conscious HUD signal store and presentation
   formatters under `src/ui/`.
3. Build the orbit-readout and dual-clock Preact panels, then integrate them into
   `App` with contained responsive styling.
4. Wire the canonical new-game simulation and sampled HUD publisher into the
   measured main animation loop while preserving the stable render position
   buffer.
5. Run focused tests, full quality/performance gates, browser regressions, and a
   live Playwright playtest. Document evidence, request independent exact-head
   review, and merge only after CI and review pass.

