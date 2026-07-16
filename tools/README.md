# Tools

Build and bake scripts are source code. Generated assets and catalogs must be
reproducible from the commands documented here.

## J2026 ephemerides bake

`bake_ephemerides.py` queries JPL Horizons through Astroquery and writes the
versioned runtime catalog plus independent regression vectors.

### Setup

Python 3.9 or newer is required. Install the pinned network dependency:

```powershell
python -m pip install -r tools/requirements-ephemerides.txt
```

### Commands

```powershell
# Full 43-body v1 bake, using Astroquery's response cache
python tools/bake_ephemerides.py

# Force fresh Horizons requests
python tools/bake_ephemerides.py --no-cache

# Replace selected bodies in an existing complete bake
python tools/bake_ephemerides.py --only earth --only moon

# Write to a review directory
python tools/bake_ephemerides.py --output-dir build/ephemerides-review

# Offline unit tests (no Astroquery import or network)
npm run test:tools
```

Partial bakes require existing complete `bodies.json` and
`ephemerides-check.json` files. The tool queries and validates every selected
body before writing sibling temporary files. Each file replacement is atomic;
if either replacement raises, backups restore both previous files. This is a
process-level transaction, not a claim of cross-file crash atomicity.
A backup is deliberately retained and named in the error if its restoration
also fails, allowing manual recovery without losing the previous bytes.
A query failure leaves the previous outputs unchanged.

### Frames, centers, and units

- Epoch: J2026, `JD 2461041.5 TDB`.
- Element center: Sun (`500@10`) for Sun children; parent body (`500@<parent Horizons id>`) for every moon.
- Check-vector center: Sun (`500@10`) for every non-Sun body.
- Reference plane: ecliptic, mean equinox of J2000.
- Horizons AU/degrees/AU-per-day values become km/radians/km-per-second.
- The Sun is the exact origin of the committed heliocentric check frame.

Numeric target IDs follow the [JPL Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html)
and avoid ambiguous planet/barycenter name resolution. Numbered small bodies use
Astroquery's `smallbody` resolver. Comets pin unique apparition records (`90000030`
for 1P and `90000702` for 67P) because their designations are ambiguous. The adapter follows the
[Astroquery JPL Horizons API](https://astroquery.readthedocs.io/en/stable/jplhorizons/jplhorizons.html).

### Physical metadata sources

GM, mean radius, rotation, axial tilt, and geometric albedo are versioned in the
ordered `BODY_DEFINITIONS` table. Sources are the
[JPL planetary physical parameters](https://ssd.jpl.nasa.gov/planets/phys_par.html),
[JPL satellite physical parameters](https://ssd.jpl.nasa.gov/sats/phys_par/),
and [NASA planetary fact sheets](https://nssdc.gsfc.nasa.gov/planetary/factsheet/).
Small-body metadata also uses the [JPL Small-Body Database API](https://ssd-api.jpl.nasa.gov/doc/sbdb.html).
Horizons solutions and published physical parameters can be revised upstream;
regenerate intentionally and review JSON diffs rather than treating a later
remote result as byte-stable forever.

## Yale bright-star catalog bake

`bake_stars.py` converts the public-domain Yale Bright Star Catalogue, fifth
revised edition ([CDS V/50](https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/V/50)),
into the render-ready `data/stars.bin` payload.

### Setup and commands

Python 3.9 or newer is required. The network path uses a pinned CA bundle because
some local Python installations do not inherit the operating system trust store:

```powershell
python -m pip install -r tools/requirements-stars.txt

# Download, verify, and bake the pinned CDS source
python tools/bake_stars.py

# Rebuild offline from the same pinned gzip bytes
python tools/bake_stars.py --source path/to/catalog.gz

# Write to a review location
python tools/bake_stars.py --output build/stars-review.bin
```

The source is
`https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz`, pinned at SHA-256
`3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`.
The tool rejects different bytes before decompression. CDS preserves the documented
fixed-width offsets but right-trims unused trailing fields; the parser consumes
bytes 1-114 and accepts those 160-197-byte physical records.

Fourteen historical entries without J2000 coordinates are omitted, leaving 9,096
stars in HR/source order. Directions are rotated from equatorial to ecliptic J2000.
V magnitude is preserved; B−V becomes bounded display RGB, and missing B−V is
neutral white. The raw little-endian payload uses seven Float32 values per star,
is exactly 254,688 bytes, and currently has output SHA-256
`91a8d2304001d3936a8dc69181c52af59c555d3fecd5546d0d2db9efa3f23cae`.
Publishing uses a same-directory temporary file and atomic replacement.

## Blender and other tools

Blender builders follow `docs/asset-pipeline.md`. Their Python scripts, not
hand-edited exported GLBs, are the source of truth.

## Runtime asset ingest

`tools/assets/ingestCli.mjs` is the only supported publisher from
`assets/models/` to `public/assets/`. Install Node dependencies and
KTX-Software 4.4.x, then run:

```powershell
$env:KTX_BIN = 'C:\path\to\KTX-Software\bin\ktx.exe'
npm run assets:ingest

# Optional focused output
npm run assets:ingest -- --only earth --output build/earth-review

# Real Draco/KTX2 acceptance: headers, 20 MiB budget, two identical hash trees
npm run assets:verify
```

Validation diagnostics cite the actionable section of
`assets/models/MODELING-GUIDE.md`. Ingest uses pinned glTF-Transform and Draco
packages, KTX's deterministic test mode, one encoder thread, sorted discovery,
canonical JSON, and transactional directory publication. A failed validation,
encoder, or byte-budget check leaves the previous output untouched.
