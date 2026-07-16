# Asset Pipeline — Solar Voyager

## Principle (updated by ADR-009)

Assets are authored **one per body, at normalized scale**, in the `assets/` source workspace — by versioned Python builders (`tools/blender/`, preferred for anything parameterizable/procedural) **or** hand/MCP-authored in Blender following [`assets/models/MODELING-GUIDE.md`](../assets/models/MODELING-GUIDE.md) (hero assets; commit the `.blend` to `assets/blender/`). Either way, **`npm run assets:ingest` is the only path into the game**: it validates the guide's contract (naming, scale, budgets, SOURCES.md), Draco-compresses meshes, encodes KTX2 textures, and emits runtime artifacts to `public/assets/` (build output — never hand-edited; CI does not run Blender).

## Toolchain

- **Blender 4+** headless. This machine: `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`.
- Headless acceptance: `npm run test:blender` builds a disposable normalized Sun
  under `build/blender-smoke/`, checks the authored GLB contract, and proves that
  runtime ingest accepts it. Set `BLENDER_PATH` when Blender is not installed at
  the documented Windows path or available on `PATH`.
- Run: `blender --background --python tools/blender/build_all.py -- --only earth` (or `--all`) — builders write to `assets/models/`.
- Ingest: `npm run assets:ingest` — validate (guide contract, SOURCES.md, budgets) → Draco → KTX2 (KTX-Software 4.4.x) → `public/assets/`.
- **blender-mcp** (in `.mcp.json`, runs via `uvx blender-mcp`) for interactive sessions. Requires the blender-mcp addon installed and enabled in Blender's preferences (see the addon's README; one-time manual setup per machine).

## Script conventions

- One parameterized builder per category: `build_planet.py`, `build_moon.py`, `build_asteroid.py`, `build_comet.py`, `build_ship.py`; shared helpers in `tools/blender/common/` (export settings, material setup, UV sphere generation).
- Deterministic: procedural scripts take an explicit `seed`; same inputs → same output bytes (modulo Blender version).
- Idempotent: each script starts from an empty scene (`bpy.ops.wm.read_factory_settings(use_empty=True)`).
- Each run prints an **asset manifest** (name, tris, texture sizes, byte size) that must fit the budget table below.
- Parameters come from `data/bodies.json` (radius, oblateness, ring geometry, procedural seed) — one source of truth shared with the sim.

`tools/blender/common/` is the shared authoring boundary for scene reset,
normalized UV/quad spheres, Principled PBR materials, strict GLB export, catalog
identity, and stable JSON manifests. Builders use those helpers instead of
copying export settings. `build_all.py` discovers implemented `build_<id>.py`
scripts whose ids exist in the catalog; pass exactly one of `--all` or one or more
`--only <id>` flags. Execution order is stable by id.
The strict exporter canonicalizes triangle order after Blender writes the GLB,
removing process-dependent index ordering while preserving triangle winding.
Quad spheres receive longitude/latitude UVs compatible with the required 2:1
equirectangular surface maps, including per-loop seam and pole handling.

## glTF export settings

- Format: `.glb` (glTF-Binary), +Y up, apply modifiers, no lights/cameras/animations.
- **No Draco at export** — ingest compresses (position quantization 14 bit, normal 10, texcoord 12).
- Textures NOT embedded — referenced externally as JPEG/PNG; ingest encodes complete-mip KTX2 (ETC1S for color maps, UASTC for normal maps). Color output is tagged sRGB/BT.709; normals are linear. Hero cloud/emissive sources above 4k are downsampled to their 4096×2048 runtime tier.
- Runtime GLBs require `KHR_texture_basisu` and point to the emitted external KTX2 files. Standard albedo, normal, emissive, metallic-roughness, occlusion, cloud, and ring slots are wired by the material/filename conventions; detail-map URIs are recorded in `mat_surface.extras.solarVoyagerTextures` for the close-range shader.

### Ingest commands

Install KTX-Software 4.4.x and make `ktx` available on `PATH`, or set `KTX_BIN`
to the executable. Node dependencies include the pinned Draco WASM encoder.

```powershell
npm install
$env:KTX_BIN = 'C:\path\to\KTX-Software\bin\ktx.exe'
npm run assets:ingest
npm run assets:verify  # real Earth, budget, headers, two-run SHA-256 equality
```

For focused review output, use
`npm run assets:ingest -- --only earth --output build/earth-review`. The command
validates every selected source before writing, builds in a sibling staging tree,
and atomically replaces the destination only after compression and per-body budget
checks pass. `manifest.json` contains sorted `id`, `category`, `triangles`, and
runtime file lists without timestamps or machine paths.
`src/render/assetManifest.ts` validates and loads this manifest at startup; unsafe
paths, duplicate ids/files, unknown categories, and malformed entries are rejected.

Color albedo/emissive/ring/cloud maps are sRGB. Normals, roughness, ORM, metallic,
AO, and occlusion maps are tagged linear with no color primaries. The source
validator enforces catalog id/category membership, unique flattened ids, approved
deliverables, per-role resolution tiers, and the required 1k detail albedo/normal
pair for planets, moons, and dwarfs.
- Scale/orientation contract: MODELING-GUIDE §3 (body radius = 1.0 unit, pole +Y, prime meridian +X, ship in real meters).

## Texture sourcing (keep this credit table current)

| Body | Source | Tier |
|---|---|---|
| Earth | Solar System Scope (CC BY 4.0) / NASA Blue Marble / NASA SVS | **8k** albedo + 4k normal + 4k night lights + 4k clouds |
| Moon | Solar System Scope / USGS Astrogeology / LRO | **8k** + 4k normal |
| Mars | Solar System Scope / USGS Astrogeology / Viking-MGS | **8k** + 4k normal |
| Mercury, Venus | Solar System Scope / USGS / NASA (MESSENGER, Magellan) | 4k |
| Jupiter, Saturn, Uranus, Neptune | Solar System Scope / NASA JPL mosaics | 4k (+ 2048×64 radial ring strips) |
| Galileans, Titan, major moons | USGS Astrogeology / Solar System Scope | 4k (Galileans/Titan), 2k others |
| Dwarf planets | NASA (New Horizons, Dawn) or procedural | 1k–2k |
| Sun | Solar System Scope / NASA SDO composite | 4k emissive |
| Detail maps (close range) | authored/procedural, per surface class | 1k tiling pairs (MODELING-GUIDE §5) |

**Licenses:** Solar System Scope textures are **CC BY 4.0** (attribution mandatory — every body folder carries a `SOURCES.md`, and the game credits screen aggregates them); NASA/USGS sources are public domain (still recorded in SOURCES.md).

The reproducible Earth albedo recipe uses Solar System Scope's official
`8k_earth_daymap.jpg`, pins source SHA-256
`88ab060b6e7d241cfc590c69f528fab2b3247b738d40124cb590999a6fe44abc`, and
records format normalization as a modification required by CC BY 4.0. Run
`npm run textures:fetch`; exact URLs and required credit are generated into the
source workspace `SOURCES.md`.

Source textures: prefer documenting download+processing in `tools/fetch_textures.py` (re-runnable by any agent); hand-downloaded files may be committed under `assets/textures-src/<body-id>/` when no stable scripted source exists. Only ingest-produced KTX2 goes in `public/assets/textures/`.

## Asteroids & comets (simple by design)

- `build_asteroid.py`: seeded icosphere, layered noise displacement + crater stamps, AO baked to vertex colors, ~3k tris.
- Real shape models where published (Eros/NEAR, Bennu/OSIRIS-REx, 67P/Rosetta): decimated to ≤5k tris.
- Comets get an emissive nucleus + the coma/tail handled in the renderer (sprites), not in the mesh.

## The ship

`build_ship.py`: original design, ~30k tris, PBR materials (albedo/metal-rough/normal/emissive for engine glow), separate node for the engine nozzle (renderer attaches plume). Modeled once, iterated via MCP sessions, always back-ported to script.

## Budgets (CI-gated, `npm run check:budgets`)

| Item | Limit |
|---|---|
| `public/assets/` total | < 150 MB |
| Hero planet (Earth/Mars/Moon: glb + all textures, post-ingest) | < 20 MB |
| Other planet | < 12 MB |
| Major moon | < 6 MB |
| Small moon/dwarf | < 4 MB |
| Asteroid/comet | < 1 MB |
| Ship | < 8 MB |
| Ring set (per planet) | < 2 MB |
| Initial critical path (Sun+Earth+Moon+ship+stars+code) | < 8 MB |

## Adding a new body (see agents/skills/add-celestial-body.md)

bodies.json entry → bake check vectors → builder script params → run build → manifest within budget → visual tier thresholds → regression vector test.
