# assets/ — Asset Source Workspace

This is where 3D models and their source textures LIVE and are WORKED ON — by humans and by any agent (Blender headless scripts, blender-mcp sessions, hand-authoring).

- `models/<category>/<body-id>/` — authored deliverables per body: `.glb` + external textures. **Read [models/MODELING-GUIDE.md](models/MODELING-GUIDE.md) before creating anything.**
- `blender/` — committed `.blend` sources for hand-authored hero assets (ship, tweaked planets). Keep textures external (linked), never packed.
- `textures-src/` — downloaded/processed source textures (equirectangular maps, ring scans). Prefer documenting the download in `tools/fetch_textures.py`; commit here only when no stable URL exists.

**This directory is the source of truth. `public/assets/` is a build output** — produced by `npm run assets:ingest` (validation → Draco compression → KTX2 texture encoding → budget check). Never edit `public/assets/` by hand; never load the game from `assets/`.

Flow: author here → `npm run assets:ingest` → optimized artifacts land in `public/assets/` → commit both.
