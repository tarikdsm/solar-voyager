# Texture fetch toolchain design

## Goal

Make the licensed source and deterministic preparation of planetary textures
reproducible, starting with Solar System Scope's 8k Earth day map. The fetcher
owns source integrity, image normalization, and attribution; T0035 remains the
only KTX2/runtime publisher.

## Source decision

The first recipe uses the exact Solar System Scope 8k Earth Day Map download.
The project already ships that image and credits it under CC BY 4.0. The official
texture page explicitly describes the maps as equirectangular, links the 8k
download, and states the CC BY 4.0 license. The recipe pins the downloaded bytes
by SHA-256 so upstream replacement is a loud, reviewable event.

NASA/USGS public-domain recipes can be added through the same catalog later.
Every recipe must carry its product page, exact download URL, license, credit
line, expected SHA-256, output role, and target dimensions.

## Boundaries

- `tools/fetch_textures.py` is a standard-library Python CLI. It selects fixed
  recipes, downloads with time/size limits into a sibling temporary file,
  verifies SHA-256, invokes deterministic processing, and atomically publishes
  below `assets/textures-src/<body-id>/`.
- `tools/textures/processImage.mjs` uses the already pinned Sharp dependency to
  normalize orientation, dimensions, color channels, and metadata-free PNG
  encoding. KTX2 is deliberately out of scope.
- A stable `SOURCES.md` in each source body directory records the source page,
  exact URL, license, checksum, processing, and required attribution. The
  authoring-model `SOURCES.md` points back to the fetch recipe.
- `--output-root` and a local source override make review and offline tests safe;
  output paths remain recipe-controlled and cannot escape the selected root.

## Determinism and failure behavior

Downloads stream with a hard byte ceiling and HTTPS-only recipe URLs. A checksum
mismatch, decode failure, wrong aspect ratio, wrong dimensions, or processor
failure leaves the previous output and attribution untouched. Processing strips
metadata and writes a fixed RGB PNG configuration. Repeating the same recipe
must produce identical PNG and `SOURCES.md` bytes.

## Verification

Unit tests cover recipe selection, checksum rejection, size limits, deterministic
attribution, path containment, and atomic failure. A small offline image exercises
the Python-to-Sharp boundary twice. The real acceptance fetches the pinned Earth
8k source, emits an 8192x4096 PNG, then substitutes that PNG into a temporary
Earth authoring tree and runs T0035 ingest with the installed KTX executable.
The runtime Earth must remain below the 20 MiB hero budget.
