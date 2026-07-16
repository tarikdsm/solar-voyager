# T0022 Star Catalog Bake Design

## Goal

Produce a deterministic, compact J2000 bright-star catalog for the renderer and a
startup-only TypeScript loader that validates and exposes its interleaved Float32
payload without copying it.

## Source and reproducibility

Use the CDS VizieR archive of the Yale Bright Star Catalogue, fifth revised
edition, catalog `V/50`. The authoritative fixed-width description and source are:

- `https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/V/50`
- `https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz`

The compressed source contains 9,110 records and has pinned SHA-256
`3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`.
The bake must reject any other bytes so an upstream revision is an explicit review
event. A local `--source` option accepts the same pinned gzip for offline rebuilds.

The parser reads HR number, J2000 right ascension/declination, V magnitude, and B-V
from the documented byte ranges. Fourteen historical entries have blank J2000
coordinates and are skipped; all 9,096 coordinate-bearing entries have V
magnitudes and are emitted in ascending HR/source order.

## Coordinate and color conversion

Convert right ascension and declination to an equatorial J2000 unit vector, then
rotate it by the J2000 mean obliquity `23.439291111°` into the ecliptic coordinate
frame used by the body catalog:

```text
x_eq = cos(dec) cos(ra)
y_eq = cos(dec) sin(ra)
z_eq = sin(dec)

x_ecl = x_eq
y_ecl = cos(epsilon) y_eq + sin(epsilon) z_eq
z_ecl = -sin(epsilon) y_eq + cos(epsilon) z_eq
```

Map available B-V values to display RGB with the compact piecewise star-color
approximation after clamping B-V to `[-0.4, 2.0]`. Let
`t = (clamp(B-V) + 0.4) / 2.4`. For `t < 0.4`, use
`r = 0.61 + 0.11t + 0.1t²`, `g = 0.70 + 0.07t + 0.1t²`, `b = 1`. Otherwise let
`u = t - 0.4` and use `r = 0.83 + 0.17t`, `g = 0.87 + 0.11t`,
`b = 1 - 0.47u - 0.53u²`. This is a visual chromaticity mapping, not radiometric
temperature reconstruction. Missing B-V values produce neutral white `(1, 1, 1)`
rather than fabricated astrophysical data. RGB remains in `[0, 1]`; apparent
brightness continues to come exclusively from V magnitude.

## Binary contract

`data/stars.bin` is a raw little-endian stream with no header. Every star occupies
seven consecutive Float32 values:

```text
dirX, dirY, dirZ, visualMagnitude, red, green, blue
```

The stride is 28 bytes. The complete pinned catalog is exactly 254,688 bytes
(`9,096 * 28`), below the 300 KB acceptance ceiling. No ids or names enter the
runtime payload. The Python tool writes a sibling temporary file and atomically
replaces the destination only after the complete payload is validated.

## Loader boundary

`src/render/starCatalog.ts` owns the binary layout constants and exports:

- `parseStarCatalog(buffer: ArrayBuffer): StarCatalog`;
- `loadStarCatalog(url: string | URL, fetcher?: typeof fetch): Promise<StarCatalog>`.

`StarCatalog` contains `starCount`, `strideFloats`, and the original interleaved
`Float32Array`. Parsing rejects empty/misaligned payloads, unsupported host
endianness, non-finite values, directions whose squared length differs from 1 by
more than `1e-4`, magnitudes outside `[-2, 8]`, and RGB outside `[0, 1]`. Validation
happens once during loading; T0042
can create Three.js interleaved attributes directly from the returned view without
another data copy or any frame-loop work.

The async loader rejects non-success HTTP responses with the status and delegates
payload validation to the parser. It does not hardcode the Vite asset URL; the
future starfield module will import `data/stars.bin?url` and pass that URL in.

## Tests

Python unit tests cover fixed-width parsing, skipped blank coordinates, equatorial
to ecliptic conversion, B-V and missing-color behavior, checksum rejection,
deterministic little-endian packing, and atomic output.

Sirius (HR 2491) and Canopus (HR 2326) are catalog spot checks. Their baked
directions must match the conversion above, their magnitudes must remain `-1.46`
and `-0.72`, and `10^(-0.4 * magnitude)` must make Sirius approximately 1.977
times brighter.

TypeScript tests load the committed artifact, require 9,096 records and 254,688
bytes, verify Canopus at zero-based index 2,320 and Sirius at 2,484, exercise
zero-copy parsing, and reject malformed payloads/fetch failures.

## Documentation changes

Update `docs/rendering-spec.md` section 5 with the exact seven-float layout,
ecliptic J2000 frame, count, and size. Update `data/README.md` and
`tools/README.md` with source, setup, checksum, and regeneration commands. This
does not change any ADR-protected physics/runtime interface; the rendering spec
already assigns the catalog and loader to T0022.
