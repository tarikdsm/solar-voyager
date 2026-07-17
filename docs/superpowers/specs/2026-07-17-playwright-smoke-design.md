# T0059 Playwright application smoke — design

## Goal

Add one production-build smoke contract that proves the deployed application can
start in Chromium, render non-blank canvas pixels, mount the HUD, and remain free
of browser console/runtime errors. The same detector must demonstrably fail when
a committed fixture injects a runtime error.

## Decisions

- Exercise `dist/` through Vite preview under the real `/solar-voyager/` base.
  Existing render regressions keep their focused development-server fixtures;
  this smoke covers the assembled production application.
- Keep the runner as a small Node script using the repository's existing
  `playwright` and `vite` dependencies. Do not add a second Playwright test
  framework or browser installation path.
- Wait for the production readiness contract already published by `main.ts`:
  `#space-canvas[data-renderer-ready="true"][data-camera-ready="true"]`.
- Verify pixels directly from the live WebGL framebuffer after a rendered frame.
  The RGB probe must have meaningful luminance range and multiple lit pixels, so
  a mounted but blank WebGL canvas cannot pass without waiting for an animated
  element to become screenshot-stable.
- Verify the HUD with stable semantic/DOM anchors: `.app-overlay`, orbit readout,
  simulation clocks, time-warp controls, and the session/settings panel.
- Collect `pageerror`, error-level console messages, and page crashes from before
  navigation until after the readiness and pixel probes.
- Commit browser init-script fixtures for both immediate and framebuffer-probe
  runtime errors. The default smoke first proves both injected pages are
  rejected, then probes a clean page. CLI flags run either injected fixture and
  exit nonzero for direct red-path verification.

## CI order

Chromium installation remains shared by all browser checks. The production build
moves before the application smoke; the smoke runs immediately after that build.
The existing focused browser regressions and remaining checks keep their current
order, with no duplicate build step.

## Failure behavior

The runner owns browser and Vite preview lifecycle cleanup in `finally`. A failure reports the
collected browser errors or the specific missing readiness, HUD, or pixel
contract. The negative-control pass is accepted only when the unique fixture
message is present; unrelated failures are never swallowed.
