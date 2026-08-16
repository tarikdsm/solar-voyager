# Sources — Ship

- `ship.glb` — `tools/blender/build_ship.py` + `tools/blender/ship_config.py` — Solar Voyager original asset; all rights reserved for project distribution — deterministic Blender 5.1 hard-surface model: lathed fuselage with stepped plating, nose cap, canopy, four RCS quads, nozzle assembly with a lined bell, radiators and running-light housings.
- `ship_mat_hull__albedo.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 sRGB hull plating: irregular bay layout, panel grooves, rivet rows, painted service panels and aft engine soot.
- `ship_mat_hull__normal.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 tangent-space normal, central-differenced from the same height field as the albedo, seamless in U.
- `ship_mat_hull__metallic.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 glTF metallic-roughness map (G roughness, B metalness).
- `ship_mat_engine_glow__emissive.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 photon-drive throat emission, mapped radially (U is the glow-disc radius fraction).

Regenerate the maps with `npm run textures:ship` (they are written to
`assets/textures-src/ship/`, which carries the full authoring recipe), then
rebuild the model with `build_ship.py`; the builder copies them here verbatim.

## Authoring contract

One Blender unit equals one metre. Length: 26.12 m; nose and drive axis point toward local +X per ADR-025. Applied geometry: 23,580 triangles (budget ≤30,000).

### Node names consumed by other code (API — do not rename)

| Node | Meaning |
| --- | --- |
| `hull_tip` | Nose marker; `src/render/shipVisual.ts` dots its world offset from the model root against the physics forward vector. |
| `engine_nozzle` | Plume attachment (T0122). Origin at the throat; the bell opens aft to the tail extreme. |
| `rcs_pod_1` … `rcs_pod_4` | RCS puff emitters (T0122): 1 forward port, 2 forward starboard, 3 aft port, 4 aft starboard. |
| `light_nav_l` / `light_nav_r` | Port (red) and starboard (green) navigation lights, at the radiator tips. |
| `light_beacon` | Dorsal anti-collision beacon on the spine. |
| `cockpit_eye` | Meshless marker at the pilot eye point for the T0124 cockpit camera. |
| `canopy` | The glass shell, kept separate so the cockpit view can treat it as the frame silhouette. |

Exported nodes: `hull`, `hull_tip`, `hull_frame`, `drive_ring`, `engine_skirt`, `engine_assembly`, `engine_nozzle`, `engine_glow_disc`, `radiator_P`, `radiator_S`, `canopy`, `rcs_pod_1`, `rcs_pod_2`, `rcs_pod_3`, `rcs_pod_4`, `light_nav_l`, `light_nav_r`, `light_beacon`, `cockpit_eye`.

Material names are the engine's attachment convention: `mat_engine_glow` receives
the emissive animation, `mat_hull` carries the three authored maps, and the three
`mat_light_*` materials are the running lights T0122 drives.
