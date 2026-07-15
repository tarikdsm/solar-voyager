# Skill: Blender Asset Authoring

How assets are made. Spec of record: `docs/asset-pipeline.md`. Iron rule: **scripts are the source of truth; exported .glb/.ktx2 are build artifacts.**

## Headless build (the normal path)

```bash
# Windows (this machine):
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --python tools/blender/build_all.py -- --only earth
# any body id from data/bodies.json, or --all
npm run assets:textures   # toktx pass: source textures → KTX2
npm run check:budgets     # must pass before committing assets
```

## Writing/editing a builder script

1. Start from `tools/blender/common/` helpers (empty-scene reset, UV-sphere generation, PBR material wiring, glTF export settings — Draco 14/10/12 quantization, +Y up, external textures).
2. Read all body parameters from `data/bodies.json` — never hardcode radii/seeds in the script.
3. Deterministic: seed every noise node/random call from the catalog seed.
4. Print the asset manifest at the end (name, tris, texture dims, bytes) — CI budget gate reads human-committed sizes, you read the manifest.
5. Commit script + regenerated artifacts together.

## Interactive tweaking via blender-mcp

- blender-mcp is configured in `.mcp.json` (`uvx blender-mcp`); it needs the blender-mcp addon enabled in Blender preferences (one-time per machine) and Blender running with the addon's server started.
- Use it to iterate on materials/shapes visually (e.g., the ship, ring shading).
- **Before the task is DONE:** back-port every kept tweak into the Python script, re-run the headless build, and confirm the output matches what you tweaked. If the script can't reproduce it, the tweak doesn't exist.

## Texture handling

- Source textures per the credit table in `docs/asset-pipeline.md` (NASA/USGS public domain only). `tools/fetch_textures.py` documents URL + processing for each; raw downloads are not committed.
- Albedo/emissive → KTX2 ETC1S; normal maps → KTX2 UASTC. Resolution tier per the table (4k Earth/Moon/Mars, 2k giants, 1k small).
