# T0059 Playwright application smoke — implementation plan

1. Add committed immediate and framebuffer-probe runtime-error init fixtures and
   the smoke runner's negative controls first. Run each fixture-only mode and
   confirm it exits nonzero for the injected error.
2. Implement production preview lifecycle and the clean application probe:
   readiness markers, HUD anchors, framebuffer pixel range, console errors,
   runtime errors, and crash collection.
3. Add `test:smoke` to `package.json`; make the default command validate both
   expected-red timing paths and the expected-green production page.
4. Reorder CI so `npm run build` precedes `npm run test:smoke`, after Chromium is
   installed, and remove the later duplicate build step.
5. Verify fixture-only red behavior, default smoke green behavior, lint,
   typecheck, formatting, unit tests, build, task schema, budgets, and the complete
   browser regression matrix. Playtest the production page once more before
   review.
