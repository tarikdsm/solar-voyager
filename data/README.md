# Baked data

- `bodies.json` — versioned runtime catalog at J2026. Validate with
  `bodies.schema.json`.
- `ephemerides-check.json` — heliocentric ecliptic J2000 state vectors at the
  epoch, +30 days, and +365 days for rails regression tests.
- `stars.bin` — 9,096 source-ordered Yale Bright Star Catalog entries as raw
  little-endian Float32 records. Each record is
  `(ecliptic J2000 direction xyz, V magnitude, RGB)` with seven floats and a
  28-byte stride. The committed artifact is 254,688 bytes with SHA-256
  `91a8d2304001d3936a8dc69181c52af59c555d3fecd5546d0d2db9efa3f23cae`.

Regenerate the body files with `python tools/bake_ephemerides.py`; see
`tools/README.md` for environment, frame, center, and source details. Never
hand-edit query-derived elements or check vectors.

Regenerate `stars.bin` with `python tools/bake_stars.py`; see `tools/README.md`
for the pinned CDS V/50 source and conversion details. Never hand-edit the binary.
