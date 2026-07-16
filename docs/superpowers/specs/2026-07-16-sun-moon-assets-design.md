# Sun and Moon asset design

## Goal

Deliver deterministic, licensed Sun and Moon authoring assets and their
post-ingest runtime forms. The initial code, Sun, Earth, Moon, and star payload
must remain below the T0033 eight-mebibyte critical-path gate.

## Source and visual decisions

The Moon uses NASA Scientific Visualization Studio's CGI Moon Kit. Its color
map is assembled from the Lunar Reconnaissance Orbiter Camera wide-angle
mosaic; its elevation map comes from the Lunar Orbiter Laser Altimeter. Recipes
pin the exact source URLs and SHA-256 digests, then publish attribution and
processed authoring inputs without retaining the large upstream TIFF files.

The 8192x4096 source color map is reduced to a moderately contrast-enhanced
4096x2048 albedo. The elevation product becomes a normalized 2048x1024 height
field. A deterministic texture preparer separates scales:

- a softly filtered 2048x1024 macro normal preserves large lunar landforms;
- a periodic 1024x1024 detail normal uses seeded, isotropic regolith and
  microcraters rather than directional waves;
- a matching detail albedo adds only low-amplitude luminance variation.

The Moon builder creates a 128x64 UV sphere and displaces it from the normalized
LOLA height field. The highest sample is exactly normalized radius 1.0 and
relief extends inward, preserving the normalized-body contract. Radial base
normals keep the exported vertex basis deterministic; macro and detail normal
maps carry the resolved relief.

The Sun remains the emissive procedural sphere accepted by ADR-010. A baked SDO
map would duplicate the runtime procedural solar treatment and consume the
small startup budget. Its builder is made output-root aware and is regenerated
under the same reproducibility checks as the Moon.

## Budget decision

The already-built critical path consumes 6,535,970 bytes, leaving 1,852,638
bytes below 8 MiB. A real 8192x4096 albedo plus 4096x2048 normal prototype
produced 13,787,812 bytes of Moon KTX2 textures alone. A naive 4096x2048 plus
2048x1024 version still produced 3,170,822 bytes.

Separating macro and close-range detail produced a measured 1,504,870-byte
texture set: 1,224,510 bytes albedo, 95,268 bytes macro normal, 105,458 bytes
detail albedo, and 79,634 bytes detail normal. This leaves roughly 347 KiB for
the Moon mesh and manifest. ADR-022 therefore makes the original T0033 4k/2k
tier authoritative for the startup Moon while Earth and Mars retain the larger
hero tier.

## Components and boundaries

- `tools/fetch_textures.py` gains pinned Moon albedo and height recipes.
- `tools/textures/processImage.mjs` gains explicit, recipe-owned output format
  and moderate contrast controls; defaults remain backward compatible.
- `tools/textures/prepareMoonMaps.mjs` owns deterministic normal/detail
  generation and exposes pure helpers for unit tests.
- `tools/blender/build_moon.py` owns Moon geometry and material construction;
  all authored output stays below `assets/models/moons/moon/`.
- The asset validator treats the named major Moon as a 50,000-triangle body,
  while ordinary moons retain the 15,000-triangle limit. It enforces the
  startup Moon's 4k albedo and 2k macro-normal tier before the generic hero
  rules.
- No new runtime or physics contract is introduced. The source height map is
  authoring-only; normalized visual geometry does not change physical radius.

## Determinism and failure behavior

Source checksums, recipe-controlled paths, fixed Sharp operations, seeded
procedural detail, fixed Blender tessellation, canonical exported normals, and
stable manifests make every stage byte reproducible. Downloads and processors
publish transactionally. Missing or malformed maps, wrong dimensions, checksum
mismatches, relief outside the normalized envelope, texture-tier drift, or the
critical-path overage fail loudly.

## Verification

Tests are written first for recipe metadata, image options, procedural texture
determinism, isotropy bounds, Moon configuration, triangle policy, dimensions,
and normalized geometry. Acceptance then performs two clean source preparations,
two clean Blender builds, and two clean focused ingests and compares complete
tree hashes. A headless Blender render is visually inspected before ingest.
Finally, the full test/lint/typecheck/build suite, asset validation, manifest
validation, and the exact critical-path byte measurement must pass.

## Acceptance measurement

The final Moon runtime payload is 1,827,065 bytes: 33,024-byte Draco GLB,
1,104,138-byte albedo, 528,356-byte macro normal, 75,625-byte detail albedo,
and 85,922-byte detail normal. Two clean focused ingests emitted identical
hashes. The final production budget measurement is 8,361,095 bytes (7.97 MiB),
27,513 bytes below the strict 8 MiB critical-path limit. The complete published
asset tree is 10,535,954 bytes.

The accepted Blender preview uses the LROC albedo, LOLA geometry and macro
normal, controlled limb relief, no visible seam, and no strong quantization
contours. BlenderMCP reports that its server cannot run in background mode on
this machine, so the same Blender 5.1 installation produced the reproducible
headless review render through `render_moon_preview.py` before ingest.
