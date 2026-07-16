# Star Catalog Bake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake the pinned Yale BSC into a 254,688-byte interleaved Float32 catalog and provide a validated zero-copy render-layer loader.

**Architecture:** A standard-library Python tool verifies the compressed CDS source hash, parses fixed-width J2000/photometry fields, transforms directions into the game's ecliptic frame, and atomically writes raw little-endian records. A render-layer TypeScript module validates an `ArrayBuffer` once at startup and returns its original interleaved `Float32Array` for T0042.

**Tech Stack:** Python 3.9+, `certifi` for a pinned CA bundle, `unittest`, TypeScript 6, Vitest 4, Vite 8.

## Global Constraints

- Source URL: `https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz`.
- Source SHA-256: `3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`.
- Emit exactly 9,096 source-ordered stars and 254,688 bytes.
- Record layout is little-endian Float32 `(dirX, dirY, dirZ, Vmag, red, green, blue)` with stride 28 bytes.
- Directions are ecliptic J2000 unit vectors; RGB is bounded `[0, 1]`; missing B-V is neutral white.
- The loader validates once at startup and performs no payload copy.
- Do not add star work to the frame loop or instantiate Three.js resources in this task.

---

### Task 1: Build the deterministic Python conversion core

**Files:**
- Create: `tools/bake_stars.py`
- Create: `tools/tests/test_bake_stars.py`
- Create: `tools/requirements-stars.txt`

**Interfaces:**
- Consumes: CDS `V/50/catalog.gz` bytes or a local pinned gzip.
- Produces: `StarRecord`, `parse_record(line)`, `bv_to_rgb(bv)`, `components_for_star(record)`, `build_payload(lines)`, `verify_and_decode_source(compressed)`, and `atomic_write_bytes(path, payload)`.

- [ ] **Step 1: Write failing fixed-width parser and spot-check tests**

Import `tools/bake_stars.py` with the same `importlib.util` pattern as
`test_bake_ephemerides.py`. Embed the exact 197-byte HR 2326 and HR 2491 lines from
the design exploration. Assert:

```python
canopus = bake.parse_record(CANOPUS_LINE)
sirius = bake.parse_record(SIRIUS_LINE)
self.assertEqual(canopus.hr, 2326)
self.assertEqual(sirius.hr, 2491)
self.assertAlmostEqual(canopus.visual_magnitude, -0.72)
self.assertAlmostEqual(sirius.visual_magnitude, -1.46)
self.assertAlmostEqual(canopus.bv, 0.15)
self.assertAlmostEqual(sirius.bv, 0.0)
self.assertGreater(
    10 ** (-0.4 * sirius.visual_magnitude),
    10 ** (-0.4 * canopus.visual_magnitude),
)
```

Blank bytes 76-90 must return `None`; a malformed 196-byte line and a
coordinate-bearing line with blank V magnitude must raise `ValueError` naming HR.

Run:

```powershell
python -m unittest tools.tests.test_bake_stars -v
```

Expected: FAIL because `tools/bake_stars.py` does not exist.

- [ ] **Step 2: Implement parsing and immutable records**

Define exact constants and record shape:

```python
SOURCE_URL = "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz"
SOURCE_SHA256 = "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed"
EXPECTED_SOURCE_RECORDS = 9_110
EXPECTED_STAR_COUNT = 9_096
STRIDE_FLOATS = 7
BYTES_PER_STAR = STRIDE_FLOATS * 4
J2000_OBLIQUITY_RAD = math.radians(23.439291111)

@dataclass(frozen=True)
class StarRecord:
    hr: int
    ra_rad: float
    declination_rad: float
    visual_magnitude: float
    bv: float | None
```

Use one-based inclusive `_field(line, first, last)` slices. Require 197 bytes,
parse RA bytes 76-83, declination bytes 84-90, Vmag 103-107, B-V 110-114, and
validate the declination sign. Return `None` only when every J2000 coordinate field
is blank; partial coordinates are errors.

- [ ] **Step 3: Write failing direction and color tests**

Assert the design values to 12 decimal places before Float32 packing:

```python
self.assert_tuple_almost_equal(
    bake.components_for_star(canopus)[:3],
    (-0.06322197015050315, 0.23659913080721862, -0.9695482627448504),
)
self.assert_tuple_almost_equal(
    bake.components_for_star(sirius)[:3],
    (-0.18745405323332234, 0.7473028927370847, -0.6374945995325638),
)
self.assertEqual(bake.bv_to_rgb(None), (1.0, 1.0, 1.0))
self.assertEqual(bake.bv_to_rgb(-10.0), bake.bv_to_rgb(-0.4))
self.assertEqual(bake.bv_to_rgb(10.0), bake.bv_to_rgb(2.0))
```

Run the focused module. Expected: FAIL because conversion functions are absent.

- [ ] **Step 4: Implement coordinate and B-V conversion**

Implement the exact equations from the design. Clamp B-V before the piecewise RGB
mapping and assert each returned component remains within `[0, 1]`. Return seven
components from `components_for_star`, with V magnitude at index 3.

- [ ] **Step 5: Write failing deterministic packing/source-integrity tests**

For two fixture lines, assert `build_payload` equals concatenated
`struct.pack('<7f', *components)` records and emits Canopus then Sirius. Assert
duplicate/non-increasing HR ids fail. Gzip a small fixture and assert
`verify_and_decode_source` rejects it with the actual and expected SHA-256. Patch
`SOURCE_SHA256` to the fixture hash and assert the decoded lines round-trip.

For `atomic_write_bytes`, write twice into `TemporaryDirectory`, assert exact final
bytes, and assert no sibling `*.tmp` remains.

- [ ] **Step 6: Implement packing, pinned decoding, download, and atomic publish**

`build_payload(lines)` must preserve input/HR order, skip only `None` records, and
append `struct.pack('<7f', ...)`. `verify_and_decode_source` verifies compressed
bytes before `gzip.decompress`, decodes ASCII, and requires 9,110 lines only in the
full-catalog CLI path. Download with `urllib.request.urlopen` using
`ssl.create_default_context(cafile=certifi.where())`; import `certifi` inside the
network function so offline unit tests stay dependency-free.

CLI arguments:

```text
--source PATH   read the pinned catalog.gz locally instead of downloading
--output PATH   default: <repo>/data/stars.bin
--url URL       default: SOURCE_URL (review/testing override only)
```

Before publish, require 9,096 stars and 254,688 bytes. Print source hash, star count,
payload bytes, and output SHA-256. Put `certifi==2026.4.22` in
`tools/requirements-stars.txt`.

- [ ] **Step 7: Verify and commit the Python core**

```powershell
python -m unittest tools.tests.test_bake_stars -v
npm run test:tools
```

Expected: star tests and the complete Python suite pass.

Commit:

```powershell
git add tools/bake_stars.py tools/tests/test_bake_stars.py tools/requirements-stars.txt
git commit -m "feat(tools): [T0022] bake pinned Yale star catalog"
```

### Task 2: Implement the validated zero-copy loader

**Files:**
- Create: `src/render/starCatalog.ts`
- Create: `tests/render/starCatalog.test.ts`

**Interfaces:**
- Consumes: an `ArrayBuffer` containing raw seven-float records.
- Produces: `STAR_STRIDE_FLOATS`, `STAR_BYTES_PER_RECORD`, `StarCatalog`, `parseStarCatalog(buffer)`, and `loadStarCatalog(url, fetcher)`.

- [ ] **Step 1: Write the failing happy-path loader test**

Create a two-record `Float32Array` with unit directions, valid magnitudes, and RGB.
Assert:

```ts
const buffer = source.buffer as ArrayBuffer;
const catalog = parseStarCatalog(buffer);
expect(catalog.starCount).toBe(2);
expect(catalog.strideFloats).toBe(7);
expect(catalog.data.buffer).toBe(buffer);
expect(catalog.data).toEqual(source);
```

Run `npm test -- tests/render/starCatalog.test.ts`. Expected: FAIL because the
module does not exist.

- [ ] **Step 2: Implement constants and zero-copy parse result**

```ts
export const STAR_STRIDE_FLOATS = 7;
export const STAR_BYTES_PER_RECORD = STAR_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export interface StarCatalog {
  readonly starCount: number;
  readonly strideFloats: typeof STAR_STRIDE_FLOATS;
  readonly data: Float32Array;
}
```

Reject empty or non-28-byte-aligned buffers. Detect host little-endianness once at
module initialization and reject unsupported hosts. Construct exactly one
`Float32Array(buffer)` and return it in an immutable wrapper object.

- [ ] **Step 3: Write failing validation tests**

Use `it.each` cases for NaN, direction squared length outside `1 ± 1e-4`, magnitude
below -2 or above 8, and RGB below 0 or above 1. Also test empty and 4-byte payloads.
Each case must assert an error message containing record index and field name where
applicable.

- [ ] **Step 4: Implement setup-time payload validation**

Use an indexed `for` loop over the interleaved view. Validate all seven values are
finite, then direction norm, magnitude, and color ranges. Do not slice, map, spread,
or allocate per record. This code runs only during startup but the returned payload
must remain zero-copy.

- [ ] **Step 5: Write failing async fetch tests**

Pass a fake fetcher returning `new Response(validBuffer)` and assert the same parsed
catalog. Return `new Response(null, { status: 503 })` and assert rejection with
`failed to load star catalog: HTTP 503`.

- [ ] **Step 6: Implement the async loader**

```ts
export type StarCatalogFetcher = (input: string | URL) => Promise<Response>;

export async function loadStarCatalog(
  url: string | URL,
  fetcher: StarCatalogFetcher = fetch,
): Promise<StarCatalog> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`failed to load star catalog: HTTP ${response.status}`);
  }
  return parseStarCatalog(await response.arrayBuffer());
}
```

- [ ] **Step 7: Verify and commit the loader**

```powershell
npm test -- tests/render/starCatalog.test.ts
npm run typecheck
npm run lint
```

Expected: focused test, typecheck, and lint pass.

Commit:

```powershell
git add src/render/starCatalog.ts tests/render/starCatalog.test.ts
git commit -m "feat(render): [T0022] load validated star catalog"
```

### Task 3: Generate and lock the real catalog artifact

**Files:**
- Create: `data/stars.bin`
- Modify: `tests/render/starCatalog.test.ts`

**Interfaces:**
- Consumes: the completed Python bake and TypeScript parser.
- Produces: the committed 9,096-star runtime artifact and cross-language spot checks.

- [ ] **Step 1: Add a failing committed-artifact test**

Read `../../data/stars.bin`, isolate its exact `ArrayBuffer`, and parse it. Require
254,688 bytes and 9,096 records. At zero-based index 2,320 assert Canopus direction
`(-0.0632219702, 0.2365991308, -0.9695482627)` and magnitude `-0.72`; at index 2,484
assert Sirius direction `(-0.1874540532, 0.7473028927, -0.6374945995)` and magnitude
`-1.46`, using Float32-appropriate `toBeCloseTo(..., 6)`. Assert the magnitude flux
ratio is close to 1.97697.

Run the focused test. Expected: FAIL with missing `data/stars.bin`.

- [ ] **Step 2: Run the real pinned bake**

```powershell
python -m pip install -r tools/requirements-stars.txt
python tools/bake_stars.py
```

Expected output includes source SHA, `9,096 stars`, and `254,688 bytes`. Confirm:

```powershell
(Get-Item data/stars.bin).Length
```

Expected: `254688`.

- [ ] **Step 3: Verify artifact checks and deterministic regeneration**

Run the focused TypeScript test. Save the SHA-256, bake again, and require the same
SHA-256 and a clean `git diff -- data/stars.bin` after staging the first result.

- [ ] **Step 4: Commit the artifact separately**

```powershell
git add data/stars.bin tests/render/starCatalog.test.ts
git commit -m "assets(data): [T0022] bake Yale bright-star catalog"
```

### Task 4: Document the catalog contract and deliver

**Files:**
- Modify: `docs/rendering-spec.md` section 5
- Modify: `data/README.md`
- Modify: `tools/README.md`
- Modify: `tasks/T0022-bake-stars.yaml`

**Interfaces:**
- Consumes: verified tool, loader, and artifact.
- Produces: reproducible operator instructions and a REVIEW-ready task.

- [ ] **Step 1: Document source, layout, and regeneration**

In rendering-spec section 5, state the 9,096 count, ecliptic J2000 frame, exact
seven-float little-endian layout, 28-byte stride, and 254,688-byte size. In the data
README cite V/50 and say the binary is generated, never hand-edited. In tools README
document setup, default/network and `--source` commands, pinned checksum, skipped
14 blank-coordinate entries, color fallback, and validation behavior.

- [ ] **Step 2: Run all repository gates sequentially**

```powershell
npm run lint
npm run typecheck
npm test
npm run test:tools
npm run format:check
npm run build
npm run check:tasks
npm run check:budgets
git diff --check
```

Expected: every command exits 0; only the known Vite 500 KB chunk warning is allowed.

- [ ] **Step 3: Commit docs, promote REVIEW, and publish PR**

Commit documentation, then set task status to REVIEW and record exact artifact
count/size/SHA, Sirius/Canopus evidence, deterministic regeneration, and gate counts
in `handoff_notes`.

```powershell
git add docs/rendering-spec.md data/README.md tools/README.md
git commit -m "docs(data): [T0022] document star catalog contract"
git add tasks/T0022-bake-stars.yaml
git commit -m "chore(tasks): [T0022] move star catalog bake to review"
git fetch origin
git rebase origin/main
git push -u origin task/T0022-bake-stars
gh pr create --base main --head task/T0022-bake-stars --title "[T0022] Yale bright-star catalog bake"
```

The PR body must map both acceptance criteria to the artifact tests and list every
verification command. Hand CI, DONE promotion, and merge to an independent reviewer.
