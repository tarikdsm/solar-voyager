# Modeling Guide — Solar Voyager

Instructions for ANY agent (or human) creating a 3D model for this game. Follow this exactly; the ingest pipeline (`npm run assets:ingest`) rejects deliverables that violate it. Strategy rationale: ADR-009 (one asset per body — never a whole-system scene).

## 1. Where files go

```
assets/models/<category>/<body-id>/
├── <body-id>.glb            # the model (required)
├── <body-id>_albedo.png     # external textures (see §5 for the full set)
├── <body-id>_normal.png
├── ...
└── SOURCES.md               # texture origins + licenses (required, see §8)
```

Categories: `sun/ planets/ moons/ dwarfs/ asteroids/ comets/ ship/ rings/`. Body ids are the lowercase catalog ids from `data/bodies.json` (`earth`, `io`, `67p`). Hand-authored `.blend` sources go in `assets/blender/` (textures linked, never packed).

## 2. File format

- **glTF 2.0 Binary (`.glb`)** — the only accepted model format. Blender: File → Export → glTF 2.0, format "glTF Binary".
- Textures **external** — the ingest pass converts to KTX2. Formats: **JPEG is acceptable (and preferred, for repo size) for photographic maps** (albedo, night lights, clouds — sources are lossy anyway); **PNG required for normal maps** (8- or 16-bit; lossy compression corrupts normals); EXR not accepted. Do NOT embed textures in the .glb, do NOT Draco-compress at authoring (ingest does it).
- Export settings: +Y up (glTF default), apply modifiers ON, no cameras, no lights, no animations (rotation/tilt are simulated by the engine from `bodies.json`), no vertex colors except asteroids (baked AO).

## 3. Units, scale, orientation — the normalization contract

| Asset type | Scale convention |
|---|---|
| Any celestial body | **Mesh radius = exactly 1.0 Blender unit** (equatorial). The engine multiplies by the real `radiusKm` from `bodies.json`. Oblateness (Jupiter/Saturn): model the true polar/equatorial ratio (e.g., Saturn polar radius 0.902 units). |
| Rings | Same normalized frame as the parent planet: **1.0 unit = parent equatorial radius**; ring inner/outer radii at true ratios (e.g., Saturn D-ring inner ≈ 1.11, F-ring ≈ 2.32). |
| Ship | **1 Blender unit = 1 meter, real dimensions** (the ship exists at real scale next to real planets; engine converts m → km). |

Orientation: **north pole along +Y** (after glTF's +Y-up export), prime meridian facing **+X**. Axial tilt is applied by the engine — author the body "upright". Pivot/origin at the body's center.

## 4. Geometry

| Category | Mesh | Budget (tier-3 close model) |
|---|---|---|
| Planets, Sun, major moons | Quad sphere (subdivided cube, poles-free UVs preferred) or UV sphere ≥ 128×64 segments | ≤ 50k tris |
| Dwarfs, small moons | UV sphere 64×32 | ≤ 15k tris |
| Asteroids/comets | Displaced icosphere (seeded noise + craters) or decimated real shape model (Eros, Bennu, 67P have published meshes) | ≤ 5k tris |
| Rings | Flat annulus, 128+ radial segments, **double-sided material** | ≤ 5k tris |
| Ship | Hard-surface model, PBR, named node `engine_nozzle` (renderer attaches the plume there) | ≤ 30k tris |

Normals smooth-shaded; no n-gons in the export; UVs must not stretch at poles (quad sphere solves this — check with a checker texture).

## 5. Textures — resolution tiers, maps, close-range strategy

**Real scale means a 4k map on Earth ≈ 10 km/pixel** — fine from 2,000 km, mush from low orbit. The game solves this in layers (rendering-spec §12); your job as the modeler is to deliver the layers:

| Map | Planets hero (Earth, Mars, Moon) | Other planets/major moons | Small bodies | Notes |
|---|---|---|---|---|
| Albedo (equirectangular 2:1) | **8k** (8192×4096) | 4k | 1k–2k | sRGB |
| Normal | 4k | 2k | baked into mesh | tangent-space, 16-bit PNG preferred |
| Roughness (or packed ORM) | 2k | 2k | – | linear |
| Emissive | Earth night lights 4k; Sun 4k emissive | – | comet nucleus 1k | sRGB |
| **Detail maps** (tiling, close-range) | 1k tiling albedo-noise + 1k tiling normal, seamless | same set can be shared per surface class | – | see below |
| Clouds (Earth) | 4k separate layer with alpha | – | – | rendered as a slightly larger shell |

**Detail maps are mandatory for tier-3 bodies**: a seamless 1k tiling normal+albedo-variation pair per surface class (rock, ice, gas banding, regolith), blended in by the shader below ~5 body-radii distance. This is what keeps a real-size planet crisp when the ship is close — resolution comes from tiling detail + macro normal map, not from impossible 100k textures. Deliver them in the body folder (or reference a shared set in `assets/models/_shared-detail/`).

Rings (Saturn, Uranus, Jupiter's faint ring, Neptune's arcs): **1D radial strips stretched to 2048×64** — color+alpha (transmission) from real ring scans (solarsystemscope / NASA PDS derived). Alpha is optical depth; the shader uses it for both transparency and the planet's shadow on the ring.

## 6. Materials

PBR metal-rough only (glTF standard): baseColor, normal, roughness, emissive. No custom shader graphs in the export — engine-side shaders (atmosphere rim, ring shading, detail blending) attach by material NAME convention:

- `mat_surface` — the body surface (gets detail-map blending)
- `mat_atmosphere` — optional inner shell for Venus/Titan haze (engine replaces it)
- `mat_rings` — ring annulus
- `mat_clouds` — cloud shell
- Ship: any names, but `mat_engine_glow` gets emissive animation.

## 7. Recommended workflow (Blender)

1. Check `data/bodies.json` for radius/oblateness/seed of your body (or add the entry first — see `agents/skills/add-celestial-body.md`).
2. Build at normalized scale (§3). For scripted/procedural bodies use `tools/blender/` builders; for hand/MCP authoring save the `.blend` to `assets/blender/`.
3. Textures: download equirectangular maps (see §8), place working copies in `assets/textures-src/<body-id>/`, wire as EXTERNAL images.
4. Export `.glb` per §2 into `assets/models/<category>/<body-id>/`.
5. Write `SOURCES.md` (§8). Run `npm run assets:ingest` — it validates naming/scale/budgets, encodes KTX2, Draco-compresses, and emits to `public/assets/`. Fix anything it flags.
6. Commit `assets/` sources AND the generated `public/assets/` artifacts together.

## 8. Texture sources & licensing (SOURCES.md is required)

Approved sources:
- **Solar System Scope textures** (https://www.solarsystemscope.com/textures/) — CC BY 4.0, based on NASA elevation/imagery. **Attribution required**: your SOURCES.md must name them, and the game credits screen aggregates all SOURCES.md files.
- NASA SVS / Blue Marble, USGS Astrogeology, NASA JPL/PDS — public domain (still record the exact page/product in SOURCES.md).

SOURCES.md format (one line per file): `<filename> — <source name + URL> — <license> — <processing done (resize/reproject/levels)>`. Deliverables without SOURCES.md fail ingest.

## 9. Per-body total budgets (glb + all KTX2 textures, post-ingest)

Hero planets (Earth/Mars/Moon) ≤ 20 MB · other planets ≤ 12 MB · major moons ≤ 6 MB · dwarfs/small moons ≤ 4 MB · asteroids/comets ≤ 1 MB · ship ≤ 8 MB · ring set ≤ 2 MB. The ingest budget gate enforces these (`docs/rendering-spec.md` §8 totals still apply).

## 10. Checklist before you're done

- [ ] Radius exactly 1.0 (bodies) / real meters (ship); pole +Y; prime meridian +X; origin centered
- [ ] .glb, external PNG textures, no lights/cameras/animations/embedded images
- [ ] Tri budget met; UVs clean at poles; equirectangular 2:1 maps
- [ ] Detail-map pair present (tier-3 bodies); clouds/rings/night-lights where the body calls for them
- [ ] Rings at true radial ratios, 2048×64 strip, alpha = optical depth
- [ ] SOURCES.md complete with licenses
- [ ] `npm run assets:ingest` passes; artifacts in `public/assets/` regenerated; both committed
