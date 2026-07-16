# Parameterized planet builder design

## Goal

Replace the bespoke Earth script with `build_planet.py --id <catalog-id>`, using
the shared T0030 helpers and catalogued shape data, while reproducing the approved
Earth source/runtime asset deterministically.

## Catalog contract

ADR-021 adds `visual.polarRadiusRatio` to catalog schema v2. The builder accepts
only `kind: planet`, creates equatorial radius 1, scales the Blender Z axis so
the exported glTF Y pole uses the ratio, and never uses physical kilometer units
inside the mesh. Texture tiers remain governed by MODELING-GUIDE, not old sizes
embedded in T0032.

## Builder contract

The CLI requires `--id`; an optional output root supports smoke review. It reads
the body and validates that its authoring directory contains role-named textures.
Earth uses the approved 128x64 surface and 1.004 cloud shell, `mat_surface` and
`mat_clouds`, night emission, macro normal, and external texture delivery. Shared
helpers own reset, geometry, materials, canonical GLB export, and manifest.

Source texture preparation remains T0031 and runtime publication remains T0035.
The builder does not encode KTX2 or Draco.

## Reproducibility and acceptance

Two clean Blender 5.1 processes must emit byte-identical Earth GLBs. The manifest
must report normalized equatorial radius, polar ratio, triangles, textures, and
bytes. A focused T0035 ingest with installed KTX must reproduce a runtime hash
tree below the current 20 MiB hero budget. Existing approved Earth appearance,
cloud shell, detail maps, and attribution are preserved.
