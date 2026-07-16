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
# Full Sun + planets + Moon bake, using Astroquery's response cache
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
- Element center: Sun (`500@10`) for planets; Earth (`500@399`) for Moon.
- Check-vector center: Sun (`500@10`) for every non-Sun body.
- Reference plane: ecliptic, mean equinox of J2000.
- Horizons AU/degrees/AU-per-day values become km/radians/km-per-second.
- The Sun is the exact origin of the committed heliocentric check frame.

Numeric target IDs follow the [JPL Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html)
and avoid ambiguous planet/barycenter name resolution. The adapter follows the
[Astroquery JPL Horizons API](https://astroquery.readthedocs.io/en/stable/jplhorizons/jplhorizons.html).

### Physical metadata sources

GM, mean radius, rotation, axial tilt, and geometric albedo are versioned in the
ordered `BODY_DEFINITIONS` table. Sources are the
[JPL planetary physical parameters](https://ssd.jpl.nasa.gov/planets/phys_par.html),
[JPL satellite physical parameters](https://ssd.jpl.nasa.gov/sats/phys_par/),
and [NASA planetary fact sheets](https://nssdc.gsfc.nasa.gov/planetary/factsheet/).
Horizons solutions and published physical parameters can be revised upstream;
regenerate intentionally and review JSON diffs rather than treating a later
remote result as byte-stable forever.

## Blender and other tools

Blender builders follow `docs/asset-pipeline.md`. Their Python scripts, not
hand-edited exported GLBs, are the source of truth.
