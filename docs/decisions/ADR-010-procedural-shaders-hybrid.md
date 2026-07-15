# ADR-010: Procedural shading policy — "textures for identity, shaders for life"

**Status:** accepted (2026-07-15)

## Decision

Procedural (shader-based) generation is adopted as a **hybrid layer**, never a replacement for real survey data:

- **Tier A — fully procedural, animated:** the Sun (convective granulation noise, limb darkening, animated prominences/corona), comet comas & tails, engine plume, atmosphere rim scattering. No large static textures for these.
- **Tier B — real texture base + procedural animation/detail:** gas giants (domain-warped band flow + storm rotation over the real mosaic), Earth cloud drift, and the close-range detail layer of every tier-3 body (rendering-spec §11 — already specified).
- **Tier C — texture-dominant:** every body with known real geography (Earth, Mars, Moon, all mapped moons/dwarfs) keeps its NASA/USGS/SolarSystemScope map as the identity layer; procedural contributes only close-range detail and roughness variation.

Two performance rules bind all tiers:
1. **Bake-at-load when animation isn't needed:** static procedural content is rendered once to a texture during the loading screen (tiny download AND zero per-frame ALU) — the default unless the effect must animate.
2. **Noise octave counts are a governor rung** (performance-spec §3 knob ladder): animated procedural shaders must implement a low-octave fallback; the 60 fps floor wins over shader beauty.

All procedural shaders are written TSL-portable (ADR-008 WebGPU migration path) and seeded deterministically (per-body seed from `bodies.json`).

## Why

- Procedural buys exactly what real scale needs: infinite resolution up close (no texel blur), life/motion (a static Sun or frozen Jupiter reads as dead), and near-zero download weight (helps the 8 MB critical path and 150 MB asset budget).
- But procedural cannot produce *real* geography — Mars must be Mars. Realism is a core requirement (game-design), so survey maps stay the identity layer wherever they exist.
- Per-pixel fbm is ALU-heavy on integrated GPUs; without the bake-at-load rule and governor rung, this feature would fight the 60 fps contract (ADR-008).

## Consequences

- The Sun's 4k emissive texture (asset-pipeline table) becomes optional/a fallback — the procedural Sun is the primary path (task T0084).
- Gas giant base textures stay in the pipeline; their shaders animate them (task T0085).
- MODELING-GUIDE unchanged for modelers except: Sun delivery may omit textures; gas giants must deliver the base map as before.
- New governor rung: "procedural octaves" inserted between AA and star-cap in the ladder.
