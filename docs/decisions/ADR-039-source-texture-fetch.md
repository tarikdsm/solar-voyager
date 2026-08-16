# ADR-039: Source-texture fetch policy

**Status:** accepted (2026-08-16)

**Supersedes:** the "hand-downloaded files may be committed under
`assets/textures-src/<body-id>/`" allowance in `docs/asset-pipeline.md`, for new
bodies only. Sources committed before this ADR stay committed (see §5).

## Context

V2M4 adds 34 bodies. Their source imagery cannot enter the repository.

The numbers are not close. Measured on this branch:

| Measurement | Value |
| --- | ---: |
| Repo content today (`npm run check:budgets`) | 177.60 MiB |
| Repo budget (spec §13, unchanged in v2) | 300.00 MiB |
| Headroom | 122.40 MiB |
| `assets/textures-src/` today, 7 bodies | 72 MiB |
| `assets/textures-src/earth/` alone | 52 MiB |

Earth is 52 MiB of committed sources for **one** body: an 8K day map, an 8K
night map, an 8K cloud layer, an 8K normal TIFF and the 24.8 MiB normalized PNG
derived from them. Thirty-four more bodies at even a fifth of Earth's sourcing
would consume the entire remaining headroom, and the hero bodies T0133–T0139
schedule (Mercury, Mars, Venus, Titan, the Galileans) are explicitly specified at
8K albedo plus 4K normal — Earth-class, not a fifth of it.

Nor is the budget the only cost. Committed source imagery is paid by every clone
forever, is paid again in full whenever a source is re-fetched at a different
compression level, and is paid by GitHub Pages CI on every checkout — for bytes
that are **inputs to a local Blender step CI never runs**. `assets/textures-src/`
is consumed only by `tools/blender/*_config.py`; `npm run assets:ingest` reads
`assets/models/`, and CI runs neither.

The existing `tools/fetch_textures.py` already pinned URLs and SHA-256 digests,
which is most of the mechanism. Three things were missing:

1. **No cache.** The raw download went to a temp file inside the staging
   directory and was `unlink`ed in a `finally` block after processing. Every
   re-run re-downloaded the full source. For a 34-body lane run repeatedly across
   seven worktrees, that is the difference between a policy and a tax.
2. **No offline story.** A failed download surfaced as
   `Texture fetch failed: <urlopen error ...>` — no file name, no destination,
   no URL. On a machine that cannot reach `svs.gsfc.nasa.gov` there was nothing
   to act on.
3. **Nothing stopped a commit.** The policy was a sentence in a doc. `git add -A`
   after a fetch committed 52 MiB of Earth sources without complaint.

## Decision

### 1. One manifest entry per source, pinning `{url, sha256, license, dest}`

`RECIPES` in `tools/fetch_textures.py` is the manifest. Each `TextureRecipe`
carries the four policy fields plus attribution and processing options:

| Field | Meaning |
| --- | --- |
| `url` | the exact HTTPS bytes (`source_url`; HTTPS is enforced in `validate()`) |
| `sha256` | 64 lowercase hex; **also the cache key** |
| `license` | licence text recorded verbatim into `SOURCES.md` |
| `dest` | repo-relative path of the file the Blender builders read, derived as `assets/textures-src/<body_id>/<output_name>` |

`--print-manifest` emits the whole thing as canonical JSON
(`schemaVersion: 1`, entries sorted by id), so the pinned set is inspectable
without reading Python, and a future check can diff it.

`dest` is **derived, not stored**. A stored `dest` is a second place for the body
id to be wrong, and `output_path()` already resolved the same location from
`body_id` + `output_name` with a path-escape guard that a free-text field would
bypass.

### 2. `kind` distinguishes a normalized image from a verified copy

`kind: "image"` (default) sends the verified bytes through
`tools/textures/processImage.mjs` (Sharp) into the declared
`width`/`height`/`output_format`. `kind: "file"` copies them byte-for-byte and
skips the 2:1 / format / quality validation entirely.

This exists for T0131. Its handoff note asks to "pin URLs+SHA256 via T0132's
fetch mechanism" for NASA PDS shape models — which are `.tab`/`.obj` files that
Sharp cannot open. Without `kind` the asteroid lane would have grown a second,
parallel fetch-and-verify implementation, and two checksum policies that must
agree forever is the failure mode this ADR is trying to prevent.

For a `"file"` source `SOURCES.md` records "Changes: none; the published file is
the pinned source bytes", which is also the legally accurate statement.

### 3. A content-addressed cache, outside version control and outside `build/`

```
.texture-cache/<first two hex>/<full sha256>
```

The file **name is the verified digest**, and an entry is only ever published
into that name by `os.replace` *after* its bytes hashed correct. A cache entry
therefore cannot be a partial download. `ensure_cached()` returns
`(path, CACHE_HIT | DOWNLOADED)`; a hit skips the network entirely.

The digest is nonetheless re-measured on every hit. A cache that lies is worse
than no cache, and the cost is noise: re-hashing is a small fraction of the Sharp
pass over the same 8K image. A cached file whose bytes no longer match is
reported on stderr, deleted, and re-fetched rather than trusted.

**Location.** `.texture-cache/` at the repo root, overridable per-run with
`--cache-root` and per-machine with `SOLAR_VOYAGER_TEXTURE_CACHE`.

- *Rejected: `build/texture-cache/`.* `build/` is gitignored but is **not** in
  `assetBudgets.mjs`'s `REPO_EXCLUDED_DIRECTORIES`, so a cache there would be
  measured against the 300 MiB repo budget — the check would fail for the exact
  reason this ADR exists to prevent. `build/` is also what a stale-output purge
  deletes first, which is the worst possible property for multi-gigabyte
  downloads.
- *Rejected: a platform cache directory (`~/.cache`, `%LOCALAPPDATA%`).* Correct
  for a published tool, wrong for this one: the error copy has to name a path a
  human can act on, and a repo-root sibling is findable. The environment override
  covers the case that motivates a platform directory — the seven V2M4 worktrees
  sharing one download.

### 4. Offline-friendly failure is a first-class output

Every unreachable source raises `SourceUnavailableError` carrying:

```
Source "jupiter-albedo" is not cached and could not be fetched.

  missing file   jupiter_albedo.jpg
  needed at      assets/textures-src/jupiter/jupiter_albedo.jpg
  cache slot     D:\...\.texture-cache\0b\0bd844bf...
  download from  https://.../8k_jupiter.jpg
  product page   https://.../textures/
  sha-256        0bd844bf...
  license        CC BY 4.0 (...)

  reason: offline mode is on and the cache has no verified entry

Offline recovery: download the file above on a connected machine, then run
  python tools/fetch_textures.py --only jupiter-albedo --source <path>
...
```

`--offline` makes that the deterministic path rather than something only a
network failure produces, which is also how the tests reach it without mocking
sockets.

`--source` now **verifies against the pin and installs into the cache** instead
of bypassing it. Previously it was a separate code path that hashed a local file
and copied it past the cache; now the recovery instructions the error prints and
the normal fetch path converge on the same cache slot, so "did the manual
placement work?" is answerable by re-running with `--offline`.

A checksum failure is a **different** class and stays loud:
`ChecksumMismatchError` names the id, the URL, both digests and the destination,
says nothing was cached, and says not to repin without re-reviewing the licence.
It subclasses `ValueError` so the existing CLI trap and tests still catch it.
Exit codes: `2` for a failure, `3` for an unavailable source, so the asset lane
can tell "I am offline" from "something is wrong".

### 5. Enforcement is structural, and no history is rewritten

`.gitignore` gains:

```
.texture-cache/
assets/textures-src/**
!assets/textures-src/**/
!assets/textures-src/**/SOURCES.md
!assets/textures-src/.gitkeep
```

Git does not apply `.gitignore` to **already-tracked** files, so the 72 MiB of
pre-ADR-039 sources stay tracked and unchanged; `git status` shows no deletions
and no history is rewritten. This was verified rather than assumed
(`git add -A --dry-run` after dropping a new body's files into the tree adds only
its `SOURCES.md`).

`SOURCES.md` is deliberately exempt. Attribution is a licence obligation that
must survive in the repository whether or not anyone has fetched the pixels;
CC BY 4.0 credit that only exists on the machine that ran the fetch is not
credit. The `!.../**/ ` line re-includes directories, without which git cannot
reach a negation inside an excluded directory.

**Rejected: a pre-commit hook or a CI size gate on `assets/textures-src/`.** The
budget check already fails when repo content crosses 300 MiB; a second gate that
fires on the same bytes adds a failure mode without adding protection. The
gitignore rule prevents the mistake instead of reporting it.

### 6. The repo-budget check documents the policy

`REPO_EXCLUDED_DIRECTORIES` in `tools/checks/assetBudgets.mjs` gains
`.texture-cache`, with a comment stating why, and
`assetBudgets.test.mjs` gains a case proving a cache twice the size of the entire
budget does not move `repoBytes`. Without the exclusion the budget would measure
*how many bodies this machine happens to have fetched*, which is not a property
of the repository and would make the gate fail on the developer machines that do
the most work.

## Consequences

- `npm run textures:fetch` is now re-runnable at the cost of a hash instead of a
  download. Re-processing Earth's 8K albedo from a warm cache is a local
  operation with no network at all (verified: `--offline` reproduces
  `earth_albedo.png` byte-identically, SHA-256
  `087c8055…09b1bc`, matching the committed artifact).
- The rewrite is output-compatible: the produced `earth_albedo.png` is
  byte-identical to the file committed before this change.
- Repo content is unchanged at 177.60 MiB — this ADR removes nothing. It changes
  the slope, not the intercept.
- Per-source `max_bytes` replaces the single 64 MiB global cap, so a body-adder
  can pin a large USGS mosaic without editing a global constant. The default is
  unchanged.
- `SOURCES.md` generation, the atomic per-body publish, the path-escape guards
  and the HTTPS-only rule are untouched; all eleven pre-existing Python tests
  pass unmodified except for two that now pass an explicit `cache_root` so the
  suite stops writing into the working tree.

### What this ADR does *not* solve

`assets/models/` is 64 MiB of **committed authored deliverables** (Earth alone
ships an 8K `earth_albedo.png`, an 8K clouds JPEG, night lights and normals — all
tracked). Those are ingest inputs, not fetch sources, and 34 more bodies of them
is the other half of the 300 MiB problem. This ADR is scoped to sources and does
not touch it. Whoever hits the repo budget first should read this as the known
next front, not as an oversight.

## Alternatives considered

- **Git LFS.** Moves the bytes rather than removing them, adds a hard dependency
  to every clone and to GitHub Pages CI, and the free bandwidth quota is
  consumed by exactly the CI checkouts that do not need the sources at all.
- **A separate assets repository / submodule.** Same bytes, worse ergonomics: a
  submodule pointer is one more thing that goes stale, and the sources are
  already published at stable URLs by NASA, USGS and Solar System Scope. Pinning
  a checksum against an upstream that already hosts the file is strictly less
  machinery than hosting a copy.
- **Committing downscaled sources and upscaling at build.** Destroys the detail
  the 8K tier exists for, and makes the committed file neither the source nor the
  deliverable.
- **Trusting the cache file name without re-hashing.** ~4 s saved on a full
  34-body run, against silently building the game from corrupted bytes. The
  Sharp pass over the same images costs far more than the hash.
- **Deleting the existing committed sources in this task.** Explicitly out of
  scope (T0132 handoff note). It would churn 72 MiB of history for a budget that
  is currently 122 MiB clear, and the risk is uncorrelated with the problem the
  task exists to solve.
