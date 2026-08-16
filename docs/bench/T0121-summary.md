# T0121 — Ship remodel (build_ship.py v2)

Visual-check and measurement record for the ship rebuild. Design doc:
`docs/superpowers/specs/2026-08-16-ship-remodel-design.md`.

This task changes an authored asset, not `src/render/` or the frame loop, so
there is no paired `npm run bench` run here; the numbers that move are the asset
budgets and the render workload the resolved ship represents.

## Visual check

Rendered from the committed `assets/models/ship/ship.glb` by
`tools/blender/render_ship_previews.py`, framed at chase-camera range:

| Image                   | Range            | What it shows                                                       |
| ----------------------- | ---------------- | ------------------------------------------------------------------- |
| `T0121-ship-hero.png`   | 2.8 ship lengths | Silhouette, plating, drive ring, radiators, pods, nav light         |
| `T0121-ship-nose.png`   | 0.8 ship lengths | Canopy blister and frame, panel grooves, rivet rows, docking collar |
| `T0121-ship-engine.png` | 1.4 ship lengths | Lined bell interior, recessed glow well, stiffener hoops, skirt     |

Regenerate with:

```bash
blender --background --python tools/blender/render_ship_previews.py -- \
  --model assets/models/ship/ship.glb --output-dir docs/bench
```

## Asset measurements

| Measurement                           | v1 (T0034) | v2 (T0121) |
| ------------------------------------- | ---------: | ---------: |
| Triangles                             |      5,538 |     23,580 |
| Share of the 30,000 budget            |        18% |        79% |
| Exported nodes                        |         24 |         19 |
| Mesh nodes (draw calls when resolved) |         24 |         18 |
| Materials                             |          6 |          9 |
| Hull texture tier                     |   1024x512 |  2048x1024 |
| Authored `ship.glb`                   |  174,332 B |  823,936 B |
| Length                                |    26.12 m |    26.12 m |

## Determinism

`npm run test:blender` regenerates the authored maps from nothing, builds the
ship twice into separate roots and compares SHA-256 for `ship.glb` and all four
PNGs. Manual confirmation of the same, before the gate existed:

```
ship.glb                           B24FD4E0CCC8DD485CF80B804A8F8497ED2E066D578F5A341BDD9584A45A2448
ship.glb                           B24FD4E0CCC8DD485CF80B804A8F8497ED2E066D578F5A341BDD9584A45A2448
ship_mat_engine_glow__emissive.png 225A8C6C59CF4049360414E1B4237D9126C197D98CFE023A6E9E373811F9B275
ship_mat_engine_glow__emissive.png 225A8C6C59CF4049360414E1B4237D9126C197D98CFE023A6E9E373811F9B275
ship_mat_hull__albedo.png          16624C75F6D3006FB24F395423ED803B8AC616067591C9EB4B4B7A86C0EA2E4D
ship_mat_hull__albedo.png          16624C75F6D3006FB24F395423ED803B8AC616067591C9EB4B4B7A86C0EA2E4D
ship_mat_hull__metallic.png        A86C125EEBA33C3169E739A8B0638D92EABA979DFD338900D2FF9436690F02CD
ship_mat_hull__metallic.png        A86C125EEBA33C3169E739A8B0638D92EABA979DFD338900D2FF9436690F02CD
ship_mat_hull__normal.png          516266344B787267024170E969FB0E3D3C129B2780F1CC48A0AEB59161EAB90A
ship_mat_hull__normal.png          516266344B787267024170E969FB0E3D3C129B2780F1CC48A0AEB59161EAB90A
SOURCES.md                         2452BCA02DB83D198FD84361B07A35F163163C98FBA831D2F90311760A9D1450
SOURCES.md                         2452BCA02DB83D198FD84361B07A35F163163C98FBA831D2F90311760A9D1450
```

Determinism is structural, not lucky: geometry, UVs and normals are pure
arithmetic in `ship_geometry.py`, the textures are hashed per pixel with no RNG
and no clock, the builder installs analytic split normals so Blender never
computes one, and `common/export.py` canonicalises triangle order and rounds
texcoords.
