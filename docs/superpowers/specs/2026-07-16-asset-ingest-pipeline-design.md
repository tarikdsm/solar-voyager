# T0035 Asset Ingest Pipeline Design

## Goal

Provide the only supported path from authored assets under `assets/models/` to
runtime artifacts under `public/assets/`. The ingest command validates the
modeling contract before producing deterministic Draco-compressed GLBs, KTX2
textures, and a canonical manifest.

## Source discovery and identity

The source tree is traversed in Unicode code-point order. Ordinary celestial
assets use `assets/models/<category>/<id>/<id>.glb`; the singleton `sun` and
`ship` categories use `assets/models/<category>/<category>.glb`. Empty category
directories and `.gitkeep` files are ignored. Every discovered asset must have a
matching `SOURCES.md`, a known category, and only guide-approved deliverable file
names. IDs must be lowercase catalog-style slugs and must be unique.

Each validation diagnostic begins with the asset-relative path and cites the
relevant `MODELING-GUIDE.md` section. Validation completes before any published
output changes, and all findings are reported in one run.

## Validation boundary

The raw GLB JSON is inspected before decoding so authoring violations cannot be
normalized away. The validator rejects malformed GLBs, data-URI or buffer-view
images, cameras, animations, `KHR_lights_punctual`, pre-existing Draco payloads,
and missing external resources. It counts indexed and non-indexed triangles and
enforces the category limit from guide section 4.

Decoded positions are evaluated in scene/world space. Celestial bodies must be
centered at the origin and have equatorial radius 1.0 within a documented
floating-point tolerance; the root transform must preserve the glTF +Y-up frame.
The primary body node is identified by the catalog id. Named adjunct geometry,
including cloud shells and rings, contributes to triangle/byte budgets but not to
the primary body's unit-radius measurement.
That transform check is the mechanically verifiable part of the pole contract.
Prime-meridian appearance and texture semantics cannot be derived reliably from
mesh bytes and remain authoring checks in the guide. Rings and ships have their
own guide scale contracts and skip the unit-sphere test.

External JPEG/PNG textures are decoded for dimensions. Equirectangular body maps
must be 2:1, normal maps must be PNG, dimensions must stay within the guide tiers,
and unsupported aspect ratios or formats fail with section 5 diagnostics.
`SOURCES.md` must name every delivered texture.

## Processing

glTF-Transform 4.4.1 loads each validated document and applies Draco using the
specified quantization: position 14 bits, normal 10 bits, and texture coordinates
12 bits. The Node package uses the pinned `draco3dgltf` WASM encoder so CI and
developer machines do not depend on a system Draco binary.

KTX-Software performs texture encoding through a small command adapter. Albedo,
emissive, cloud, and other color maps use ETC1S; normal maps use UASTC. Every
texture gets a complete mip chain. The adapter prefers the current `ktx create`
interface. It explicitly assigns sRGB/BT.709 metadata to color maps and
linear/no-primary metadata to normals, so authoring ICC profiles cannot change or
block the result. Hero cloud and emissive layers are downsampled to the guide's 4k
runtime tier while the 8k hero albedo and 4k normal remain unchanged. It records no
timestamps and forces one worker for reproducibility. A missing or unsupported
KTX executable fails before publication with an installation command and the
expected version family.

Textures are staged as deterministic PNG input where the encoder requires it.
Runtime GLBs reference the generated `.ktx2` files through
`KHR_texture_basisu`; authored JPEG/PNG bytes are never copied to public output.

## Publication and manifest

All files are built in a sibling staging directory. Per-asset byte totals are
checked after compression against guide section 9. Only after every asset passes
does ingest replace `public/assets/` with the staging tree. A failed run leaves
the last valid published tree untouched.

`public/assets/manifest.json` has schema version 1 and a sorted `assets` array.
Each entry contains only the fields already accepted by the repository budget
gate: `id`, normalized `category`, `triangles`, and sorted repository-relative
`files`. JSON uses two-space indentation, LF endings, and a final newline. No
clock time, machine path, random identifier, or host-specific metadata is emitted.

## Determinism

Dependencies and KTX version are pinned, traversal and manifest entries are
sorted, compression runs single-threaded where required, and publication uses
fully regenerated staging output. The acceptance test hashes every output file,
runs ingest again, and requires the same path/hash map. Determinism is guaranteed
for the supported tool versions on the same target platform; KTX-Software does
not promise cross-architecture bit identity.

## Test strategy

Unit fixtures exercise discovery, raw GLB rejection, geometry/triangle checks,
texture rules, attribution coverage, budgets, canonical manifests, and atomic
publication. The required violating fixture combines wrong scale, missing
`SOURCES.md`, and an embedded texture and must report all three guide sections.

An integration test ingests the repository Earth fixture with the real pinned
Draco and KTX encoders, requires a total below the 20 MiB hero budget, verifies
the resulting GLB and KTX2 headers, and compares two complete output hash maps.
The normal repository test suite uses a deterministic fake KTX adapter so CI can
exercise orchestration without an undeclared native executable; a dedicated
`assets:verify` command runs the real encoder acceptance path when KTX-Software
is installed.
