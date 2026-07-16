# T0030 Blender Common Helpers Design

## Goal

Make scripted Blender assets reproducible through one small helper API and one
headless entry point. Builders remain one-body-per-file and always emit authored
sources under the modeling-guide contract; runtime optimization remains T0035.

## Common package

`tools/blender/common/` contains Blender-only modules with no import-time scene
mutation:

- `scene.py`: reset to an empty factory scene and deterministic selection helpers;
- `geometry.py`: normalized UV sphere and quad-sphere constructors, smooth normals,
  centered origin, +Y-up authoring frame;
- `materials.py`: Principled PBR creation and optional external albedo, normal, and
  emissive image-node wiring with correct color spaces;
- `export.py`: selection-only GLB export with modifiers applied, animations,
  cameras, and lights disabled, no Draco, and no embedded authoring textures;
- `manifest.py`: evaluated triangle count, texture dimensions, file bytes, normalized
  radius, and stable human-readable manifest output;
- `catalog.py`: repository paths and read-only lookup in `data/bodies.json`.

Helpers validate arguments and raise actionable errors rather than relying on
Blender context silently. Builders own artistic parameters; shared code owns the
mechanical export contract.

## Headless orchestration

`tools/blender/build_all.py` runs inside Blender and parses arguments after the
standard `--` separator. Exactly one of `--all` or one-or-more `--only <id>` is
required. Supported ids are discovered from `build_<id>.py` files, excluding the
orchestrator and smoke builder, then cross-checked against `data/bodies.json` plus
the special `ship` id. Requested builders run in sorted id order through
`runpy.run_path`; each builder resets its own scene. Unknown/missing builders fail
before any builder runs and print the supported ids.

`--all` means every implemented builder, not every catalog body. This keeps the
entry point honest while the catalog is filled incrementally.

## Builder migration

Migrate `build_sun.py` fully to the common helpers as the reference implementation.
Existing Earth, Saturn, and Pluto builders remain behavior-compatible and are
invoked by the orchestrator; deeper artistic refactors are outside T0030 and can
adopt the helpers incrementally without changing generated assets unexpectedly.

## Headless acceptance fixture

`tools/blender/build_test_sphere.py` uses only the common API. It accepts
`--output-root`, creates a singleton `sun/` source directory, writes `sun.glb` and
`SOURCES.md`, and prints the manifest. The fixture uses a 128×64 unit UV sphere,
`mat_surface`, no textures, and no camera/light/animation.

The real acceptance flow writes only under `build/blender-smoke/`, then runs:

```text
Blender --background --python tools/blender/build_test_sphere.py -- --output-root build/blender-smoke/assets/models
npm run assets:ingest -- --models build/blender-smoke/assets/models --output build/blender-smoke/public/assets --only sun
```

The ingest validator must report zero findings, the authored GLB must have radius
1.0, and the runtime GLB must require Draco. Temporary acceptance output is never
committed.

## Testing

Standard-library tests cover deterministic builder discovery, catalog checks,
argument parsing, duplicate/unknown ids, and run order without importing `bpy`.
Blender-resident smoke assertions cover geometry radius, triangle count, material,
manifest, and raw GLB contract. The task is delivered only after the real Blender
5.1 headless build and T0035 ingest both pass on this machine.

