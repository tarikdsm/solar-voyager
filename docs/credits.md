# Credits and third-party material

Solar Voyager was created by Tarik Della Santina Mohallem. Its source code is licensed under the
repository [MIT License](../LICENSE). Data, textures, models, and other media retain the license or
usage terms recorded in their source files.

## Runtime and build software

- [Three.js](https://threejs.org/) — WebGL renderer and loaders, MIT License. The deployed codec
  directory includes the required Three.js license copy.
- [Preact](https://preactjs.com/) and [@preact/signals](https://preactjs.com/guide/v10/signals/) — DOM
  interface and reactive presentation, MIT License.
- [Vite](https://vite.dev/), [TypeScript](https://www.typescriptlang.org/),
  [Vitest](https://vitest.dev/), and [Playwright](https://playwright.dev/) — build, language, tests, and
  browser validation under their respective open-source licenses.
- [Blender](https://www.blender.org/) — deterministic authored-model generation. Blender files and
  scripts are build inputs; Blender is not shipped as part of the web application.

The exact dependency versions are locked in `package-lock.json`; dependency packages retain their
own notices and licenses.

## Astronomical data

- Solar-system state vectors were baked from [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) with
  independent regression vectors. Physical metadata uses JPL planetary/satellite parameters, NASA
  planetary fact sheets, and the JPL Small-Body Database as documented in
  [tools/README.md](../tools/README.md).
- The visible star catalog is derived from the Yale Bright Star Catalog, catalog V/50 distributed by
  the [CDS](https://cdsarc.cds.unistra.fr/), with its pinned source checksum and bake procedure
  recorded in [tools/README.md](../tools/README.md).

## Textures and models

- Earth, Jupiter, Saturn, Uranus, and Neptune source textures credit Solar System Scope and are used
  under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Files are normalized, resized or
  encoded into deterministic runtime derivatives as recorded per asset.
- Moon color and elevation maps credit NASA Scientific Visualization Studio; LROC data credit
  NASA/GSFC/Arizona State University and LOLA data credit NASA/GSFC/MIT. Processing and derived-map
  details are recorded with the sources.
- Pluto imagery credits NASA/JHUAPL/SwRI New Horizons. Procedural surfaces, rings, gas detail, Sun,
  spacecraft, and remaining authored geometry use deterministic Solar Voyager generators where the
  corresponding source record says so.

The per-asset `SOURCES.md` files are the authoritative attribution, license, checksum, modification,
and generator records:

- [Earth texture sources](../assets/textures-src/earth/SOURCES.md)
- [Moon texture sources](../assets/textures-src/moon/SOURCES.md)
- [Jupiter texture sources](../assets/textures-src/jupiter/SOURCES.md)
- [Saturn texture sources](../assets/textures-src/saturn/SOURCES.md)
- [Uranus texture sources](../assets/textures-src/uranus/SOURCES.md)
- [Neptune texture sources](../assets/textures-src/neptune/SOURCES.md)
- [Pluto model sources](../assets/models/dwarfs/pluto/SOURCES.md)
- [Spacecraft model sources](../assets/models/ship/SOURCES.md)

Do not remove or replace those records when redistributing asset derivatives. NASA and other agency
names identify data sources and do not imply endorsement.
