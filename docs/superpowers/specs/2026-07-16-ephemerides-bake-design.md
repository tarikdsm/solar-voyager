# T0020 Ephemerides Bake Design

## Scope

Create the first canonical Solar Voyager body catalog: the Sun, eight planets,
and the Moon at J2026 (`JD 2461041.5 TDB`). A Python bake tool queries JPL
Horizons through `astroquery.jplhorizons`, normalizes results to the game's
units and frame, and writes versioned catalog and regression data.

This task owns data generation and validation only. Rails propagation, runtime
catalog loading, the full 50-body roster, and visual assets remain in dependent
tasks.

## Source and query model

Pin `astroquery==0.4.11`, the current stable release that supports Python 3.9+
and discrete TDB Julian dates. Use numeric Horizons major-body identifiers to
avoid ambiguous name resolution:

```text
Sun 10, Mercury 199, Venus 299, Earth 399, Moon 301,
Mars 499, Jupiter 599, Saturn 699, Uranus 799, Neptune 899
```

Planet elements are queried relative to the Sun center (`500@10`); Moon
elements are queried relative to Earth center (`500@399`). All element and
vector queries request the ecliptic reference plane. Regression vectors for
every non-Sun body are independently queried relative to the Sun at the epoch,
+30 days, and +365 days. The Sun is the exact origin in this heliocentric
dataset and therefore receives explicit zero vectors.

Horizons returns element distances in AU, angles in degrees, positions in AU,
and velocities in AU/day. The bake converts these to km, radians, km, and km/s.
The canonical AU is `149597870.7 km`, matching `physics-spec.md` section 1.

Physical metadata not supplied by the element/vector tables is versioned in a
single ordered body definition table inside the script. Values carry source
comments and URLs for JPL/NASA fact sheets. SOI radius is derived during the
bake as `a * (mu_body / mu_parent)^(2/5)`; no mass conversion is needed because
the gravitational constant cancels.

## Catalog schema

Add `data/bodies.schema.json` and record its introduction in ADR-013. The
schema is closed with `additionalProperties: false` at every stable object
boundary. `data/bodies.json` has this shape:

```text
schemaVersion: 1
epoch: { name: "J2026", jdTdb: 2461041.5 }
frame: "heliocentric-ecliptic-j2000"
bodies: Body[]
```

Each `Body` contains:

- identity: `id`, English `name`, `kind`, numeric `horizonsId`, `parentId`;
- physics: `muKm3S2`, `meanRadiusKm`, signed `siderealRotationPeriodSec`,
  `axialTiltRad`, `geometricAlbedo`, and `soiRadiusKm`;
- orbital elements using the existing TypeScript names
  `semiMajorAxisKm`, `eccentricity`, `inclinationRad`,
  `longitudeAscendingNodeRad`, `argumentPeriapsisRad`, and
  `meanAnomalyRad`;
- `surface: { kind, atmosphereTopKm }` as a future-phase stub;
- `visual: { albedoColor, assetRef, proceduralSeed }` as an asset-lane stub.

The Sun has `parentId`, `soiRadiusKm`, and `elements` set to `null`. Other
bodies have complete elements and refer to an earlier parent in catalog order.
Rotation period is signed: negative means retrograde about the declared pole.

`data/ephemerides-check.json` is also versioned and stores three ordered
samples. Each sample contains `offsetDays`, `jdTdb`, and a state map for all ten
bodies, with three-component `positionKm` and `velocityKmS` arrays. Check
vectors are always heliocentric even though Moon elements are parent-relative.

## Tool structure and CLI

`tools/bake_ephemerides.py` separates pure normalization/build functions from
the lazy `astroquery` import so its local tests and `--help` do not require
network dependencies. Supported commands are:

```text
python tools/bake_ephemerides.py
python tools/bake_ephemerides.py --only earth
python tools/bake_ephemerides.py --no-cache
python tools/bake_ephemerides.py --output-dir data
```

The default performs a full ordered bake. `--only` may be repeated; it loads
the existing complete files and replaces selected entries, supporting the
future add-body workflow. It refuses a partial bake when the baseline files do
not exist. `--no-cache` bypasses Astroquery's request cache.

All remote rows and required columns are validated before output. Files are
serialized deterministically with stable ordering and a final newline, written
to sibling temporary files, and individually atomically replaced only after
the whole bake succeeds. Backups roll both files back if either replace fails;
this is process-level consistency rather than cross-file crash atomicity. A
network, target-resolution, unit, or validation failure leaves the committed
outputs unchanged and exits nonzero with body/query context.

`tools/README.md` documents environment setup, commands, data sources, center
semantics, units, and the fact that Horizons solutions may be revised upstream.
A pinned `tools/requirements-ephemerides.txt` makes the environment repeatable.

## Verification

Add pure Python unit tests for AU/unit conversion, SOI calculation, body order,
partial replacement, and malformed-query rejection. They run without
Astroquery or network access.

Add an Ajv-backed Vitest test that:

1. validates `bodies.json` against `bodies.schema.json`;
2. confirms the exact ten-body order and valid parent topology;
3. confirms every non-Sun body has finite elements and a positive SOI;
4. confirms all three ephemeris samples contain finite six-component states for
   every body and exact zero Sun states;
5. confirms Moon elements are parent-relative while Moon checks are marked by
   the global heliocentric frame.

The repository gates include the Python unit suite, existing Node tests, lint,
typecheck, build, task schema, formatting, and budgets. The network bake itself
is run manually during this task and its committed output is then validated
offline in CI.

## Alternatives considered

### Query elements and vectors directly (selected)

This preserves Horizons' osculating solution, minimizes custom astronomy code,
and independently supplies the future rails regression vectors.

### Query only vectors and derive elements in Python

This could cross-check the TypeScript conversion but would duplicate subtle
degeneracy handling and introduce another orbital-mechanics implementation.

### Call the Horizons HTTP API directly

This reduces dependency size but contradicts the task contract and recreates
identifier, caching, parsing, and error-handling behavior already maintained by
Astroquery.
