# ADR-005: Preact + @preact/signals for the HUD

**Status:** accepted (2026-07-15)

## Decision

The HUD/UI layer is Preact with @preact/signals, rendered as a DOM overlay above the WebGL canvas. The system map is a three.js scene (viewport switch), not DOM.

## Why

- ~4 KB runtime — matters for the GitHub Pages critical path (<8 MB total).
- Declarative components keep three different agents writing uniform UI code; imperative DOM juggling across agents is a merge-conflict and bug machine.
- Signals give fine-grained updates without 60 fps re-render cost — right fit for HUD readouts fed by per-frame snapshots.
- DOM overlay = crisp text, trivial styling, accessibility for free.

## Alternatives

React (same model, 10x the bytes), plain DOM (uniformity risk across agents), canvas-drawn UI (text quality, a11y, cost).
