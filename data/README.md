# Baked data

- `bodies.json` — versioned runtime catalog at J2026. Validate with
  `bodies.schema.json`.
- `ephemerides-check.json` — heliocentric ecliptic J2000 state vectors at the
  epoch, +30 days, and +365 days for rails regression tests.
- `stars.bin` — future packed bright-star catalog from T0022.

Regenerate the body files with `python tools/bake_ephemerides.py`; see
`tools/README.md` for environment, frame, center, and source details. Never
hand-edit query-derived elements or check vectors.
