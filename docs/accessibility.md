# Accessibility

Solar Voyager v1 is designed to make its menu, tutorial, settings, instruments, panels, and flight
commands operable with a keyboard. This document records shipped behavior and known gaps; it is not a
claim of formal WCAG conformance.

## Supported behavior

- The loading shell uses a native progress element and publishes truthful milestone text. Startup
  failures use an alert and expose a keyboard-operable Retry button.
- The main menu places New Game first, moves focus there when ready, uses native buttons, preserves a
  live status region, and supports compact scrolling without horizontal overflow.
- Settings, system map, burn log, tutorial, selectors, save/load, and import/export use semantic DOM
  controls with visible focus. Keyboard shortcuts are listed in [controls](controls.md).
- HUD values are text in definition lists or labeled panels rather than text painted only into the
  WebGL canvas. Important trajectory events pair color with labels and marker shapes.
- The interface honors `prefers-reduced-motion: reduce`; quality can be manually locked to reduce
  visual load. A detected software renderer produces a readable warning and conservative effects.
- Desktop and compact layouts retain keyboard reachability, contrast, and a minimum practical control
  height in automated browser regressions.

## Known limitations

The three-dimensional space scene itself has no complete nonvisual equivalent or live verbal
description. Spatial planning, body surface detail, trajectory geometry, and relativistic visual
effects therefore still depend on vision. The game has no touch-specific control scheme, captions are
not applicable because it ships no speech or essential audio, and extremely high browser zoom may
require additional panel scrolling.

Browser, operating-system, GPU-driver, or assistive-technology combinations vary. Please report a
reproducible accessibility defect with browser/version, operating system, viewport or zoom, input
method, and the affected control or screen.
