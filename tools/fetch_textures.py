"""Fetch, verify, cache and normalize licensed planetary source textures.

ADR-039 (docs/decisions/ADR-039-source-texture-fetch.md): source imagery is
**fetched on demand and never committed**. Every source is one manifest entry
pinning `url`, `sha256`, `license` and `dest`; the verified bytes live in a
content-addressed cache outside version control, and `dest` is the working-tree
path the Blender builders read.

Adding a body: append a `TextureRecipe` to `RECIPES` and run
`npm run textures:fetch -- --only <id>`. The full checklist is in
`agents/skills/add-celestial-body.md`.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.request


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"
OUTPUT_ROOT_RELATIVE = DEFAULT_OUTPUT_ROOT.relative_to(REPOSITORY_ROOT).as_posix()
PROCESSOR_PATH = REPOSITORY_ROOT / "tools" / "textures" / "processImage.mjs"
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

# ADR-039: the verified-source cache is deliberately outside `assets/` and
# outside every directory a build writes to, so `git clean` and a stale-output
# purge cannot silently cost a multi-gigabyte re-download. It is gitignored and
# excluded from the repo-content budget in tools/checks/assetBudgets.mjs.
CACHE_ENVIRONMENT_VARIABLE = "SOLAR_VOYAGER_TEXTURE_CACHE"
DEFAULT_CACHE_ROOT = REPOSITORY_ROOT / ".texture-cache"
CACHE_ROOT_RELATIVE = DEFAULT_CACHE_ROOT.relative_to(REPOSITORY_ROOT).as_posix()

CACHE_HIT = "cache"
DOWNLOADED = "download"

IMAGE_KIND = "image"
FILE_KIND = "file"
SOURCE_KINDS = (IMAGE_KIND, FILE_KIND)

MANIFEST_SCHEMA_VERSION = 1
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

EXIT_FAILED = 2
EXIT_SOURCE_UNAVAILABLE = 3


class ChecksumMismatchError(ValueError):
    """Fetched bytes do not match the pinned SHA-256. Never silently retried."""

    def __init__(self, message, *, expected=None, measured=None):
        super().__init__(message)
        self.expected = expected
        self.measured = measured


class SourceUnavailableError(RuntimeError):
    """A pinned source is neither cached nor reachable; the message says what to do."""


class TextureRecipe:
    """One manifest entry: where the bytes come from, and where they must land.

    The four fields ADR-039 pins are `url`, `sha256`, `license` and `dest`.
    `kind` selects what happens to the verified bytes:

    - ``"image"`` — normalized by `tools/textures/processImage.mjs` (Sharp) into
      the declared `width`/`height`/`output_format`.
    - ``"file"`` — copied byte-for-byte. Use this for non-image sources such as
      published shape models (`.tab`, `.obj`), which have no Sharp pipeline.
    """

    def __init__(
        self,
        *,
        id,
        body_id,
        role,
        source_url,
        product_url,
        license,
        credit,
        sha256,
        width,
        height,
        output_name,
        output_format="png",
        kind=IMAGE_KIND,
        quality=90,
        contrast=1.0,
        grayscale=False,
        normalize=False,
        blur=0.0,
        max_bytes=MAX_DOWNLOAD_BYTES,
    ):
        self.id = id
        self.body_id = body_id
        self.role = role
        self.source_url = source_url
        self.product_url = product_url
        self.license = license
        self.credit = credit
        self.sha256 = sha256.lower()
        self.width = width
        self.height = height
        self.output_name = output_name
        self.output_format = output_format
        self.kind = kind
        self.quality = quality
        self.contrast = contrast
        self.grayscale = grayscale
        self.normalize = normalize
        self.blur = blur
        self.max_bytes = max_bytes

    @classmethod
    def test(cls, id, source_url="https://example.test/texture.png", output_name=None):
        return cls(
            id=id,
            body_id="earth",
            role="albedo",
            source_url=source_url,
            product_url="https://example.test/product",
            license="CC BY 4.0",
            credit="Example texture author",
            sha256="1" * 64,
            width=8192,
            height=4096,
            output_name=output_name or f"{id}.png",
        )

    @property
    def url(self):
        """Manifest field: the exact HTTPS bytes this entry pins."""
        return self.source_url

    @property
    def dest(self):
        """Manifest field: repo-relative path of the file the builders read."""
        return f"{OUTPUT_ROOT_RELATIVE}/{self.body_id}/{self.output_name}"

    def validate(self):
        if not self.source_url.startswith("https://") or not self.product_url.startswith("https://"):
            raise ValueError(f'Recipe "{self.id}" source and product URLs must use HTTPS')
        if SHA256_PATTERN.fullmatch(self.sha256) is None:
            raise ValueError(f'Recipe "{self.id}" must pin a lowercase SHA-256')
        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", self.body_id) is None:
            raise ValueError(f'Recipe "{self.id}" body id must be a lowercase slug')
        if self.kind not in SOURCE_KINDS:
            raise ValueError(f'Recipe "{self.id}" kind must be one of {", ".join(SOURCE_KINDS)}')
        if not isinstance(self.max_bytes, int) or self.max_bytes <= 0:
            raise ValueError(f'Recipe "{self.id}" must cap its download at a positive byte count')
        if pathlib.Path(self.output_name).name != self.output_name or not self.output_name:
            raise ValueError(f'Recipe "{self.id}" output name must be a bare file name')
        if self.kind == FILE_KIND:
            # A verified copy has no image contract to enforce.
            return self
        if self.width <= 0 or self.height <= 0 or self.width != self.height * 2:
            raise ValueError(f'Recipe "{self.id}" must target a positive 2:1 image')
        if self.output_format not in {"png", "jpeg"}:
            raise ValueError(f'Recipe "{self.id}" has unsupported output format')
        expected_extensions = {"png": {".png"}, "jpeg": {".jpg", ".jpeg"}}
        if pathlib.Path(self.output_name).suffix.lower() not in expected_extensions[self.output_format]:
            raise ValueError(f'Recipe "{self.id}" output extension does not match its format')
        if not 1 <= self.quality <= 100 or self.contrast <= 0 or self.blur < 0:
            raise ValueError(f'Recipe "{self.id}" has invalid processing options')
        return self


RECIPES = {
    "earth-albedo": TextureRecipe(
        id="earth-albedo",
        body_id="earth",
        role="albedo",
        source_url="https://genesis-horizon.solarsystemscope.com/textures/download/8k_earth_daymap.jpg",
        product_url="https://genesis-horizon.solarsystemscope.com/textures/",
        license="CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        credit="Earth textures: Solar System Scope (solarsystemscope.com), CC BY 4.0.",
        sha256="88ab060b6e7d241cfc590c69f528fab2b3247b738d40124cb590999a6fe44abc",
        width=8192,
        height=4096,
        output_name="earth_albedo.png",
    ),
    "moon-albedo": TextureRecipe(
        id="moon-albedo",
        body_id="moon",
        role="albedo",
        source_url="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_8k.tif",
        product_url="https://svs.gsfc.nasa.gov/4720",
        license="NASA/US Government work; see NASA media usage guidelines",
        credit="Moon color map: NASA Scientific Visualization Studio; LROC data, NASA/GSFC/Arizona State University.",
        sha256="4af8b0cd4d50c30851359d98e7e72040240dd8d03256b58b345b5b76e9edb4ef",
        width=4096,
        height=2048,
        output_name="moon_albedo.jpg",
        output_format="jpeg",
        quality=88,
        contrast=1.08,
    ),
    "moon-height": TextureRecipe(
        id="moon-height",
        body_id="moon",
        role="height",
        source_url="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif",
        product_url="https://svs.gsfc.nasa.gov/4720",
        license="NASA/US Government work; see NASA media usage guidelines",
        credit="Moon elevation map: NASA Scientific Visualization Studio; LOLA data, NASA/GSFC/MIT.",
        sha256="45a2b32d56e81ed30db07fead8abc842b249b6511219d9ca2c53f81bc2dc5d62",
        width=2048,
        height=1024,
        output_name="moon_height.png",
        grayscale=True,
        normalize=True,
        blur=8.0,
    ),
    "jupiter-albedo": TextureRecipe(
        id="jupiter-albedo",
        body_id="jupiter",
        role="albedo",
        source_url="https://genesis-horizon.solarsystemscope.com/textures/download/8k_jupiter.jpg",
        product_url="https://genesis-horizon.solarsystemscope.com/textures/",
        license="CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        credit="Jupiter texture: Solar System Scope (solarsystemscope.com), CC BY 4.0.",
        sha256="0bd844bf20822c4e3e80882b077859833c0dac44c7e4e1e0cd63d1b1b6d43085",
        width=4096,
        height=2048,
        output_name="jupiter_albedo.jpg",
        output_format="jpeg",
        quality=90,
    ),
    "uranus-albedo": TextureRecipe(
        id="uranus-albedo",
        body_id="uranus",
        role="albedo",
        source_url="https://genesis-horizon.solarsystemscope.com/textures/download/2k_uranus.jpg",
        product_url="https://genesis-horizon.solarsystemscope.com/textures/",
        license="CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        credit="Uranus texture: Solar System Scope (solarsystemscope.com), CC BY 4.0.",
        sha256="d15239d46f82d3ea13d2b260b5b29b2a382f42f2916dae0694d0387b1204a09d",
        width=4096,
        height=2048,
        output_name="uranus_albedo.jpg",
        output_format="jpeg",
        quality=92,
    ),
    "neptune-albedo": TextureRecipe(
        id="neptune-albedo",
        body_id="neptune",
        role="albedo",
        source_url="https://genesis-horizon.solarsystemscope.com/textures/download/2k_neptune.jpg",
        product_url="https://genesis-horizon.solarsystemscope.com/textures/",
        license="CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        credit="Neptune texture: Solar System Scope (solarsystemscope.com), CC BY 4.0.",
        sha256="cb42ea82709741d28b0af44d8b283cbc6dbd0c521a7f0e1e1e010ade00977df6",
        width=4096,
        height=2048,
        output_name="neptune_albedo.jpg",
        output_format="jpeg",
        quality=92,
    ),
    # The one non-body recipe: the deep-sky panorama consumed by
    # `npm run assets:ingest` as the "sky" category (T0126). `body_id` is only an
    # output-directory slug here, so it deliberately has no data/bodies.json entry.
    "milkyway-panorama": TextureRecipe(
        id="milkyway-panorama",
        body_id="milkyway",
        role="panorama",
        source_url="https://cdn.eso.org/images/large/eso0932a.jpg",
        product_url="https://www.eso.org/public/images/eso0932a/",
        license="CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        credit="Milky Way panorama: ESO/S. Brunier, CC BY 4.0.",
        sha256="60400c92c54b7c1bd12299c69e83b16e5b6256e7dabacc478c021758ecd28179",
        width=4096,
        height=2048,
        output_name="milkyway_panorama.jpg",
        output_format="jpeg",
        quality=92,
    ),
}


def select_recipes(requested_ids, recipes=RECIPES):
    selected_ids = sorted(recipes) if not requested_ids else sorted(set(requested_ids))
    unknown = sorted(set(selected_ids) - set(recipes))
    if unknown:
        raise ValueError(
            f"unknown recipe id(s): {', '.join(unknown)}; supported: {', '.join(sorted(recipes))}"
        )
    return tuple(recipes[recipe_id].validate() for recipe_id in selected_ids)


def manifest_entry(recipe):
    """The `{url, sha256, license, dest}` record ADR-039 pins, plus attribution."""
    return {
        "id": recipe.id,
        "url": recipe.url,
        "sha256": recipe.sha256,
        "license": recipe.license,
        "dest": recipe.dest,
        "kind": recipe.kind,
        "bodyId": recipe.body_id,
        "role": recipe.role,
        "productUrl": recipe.product_url,
        "credit": recipe.credit,
        "maxBytes": recipe.max_bytes,
    }


def render_manifest(recipes):
    entries = sorted((manifest_entry(recipe) for recipe in recipes), key=lambda item: item["id"])
    document = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "cacheRoot": CACHE_ROOT_RELATIVE,
        "sources": entries,
    }
    return json.dumps(document, indent=2, sort_keys=False, ensure_ascii=False) + "\n"


def output_path(root, recipe):
    root = pathlib.Path(root).resolve()
    if pathlib.Path(recipe.output_name).name != recipe.output_name:
        raise ValueError(f'Recipe "{recipe.id}" output escapes the selected root')
    result = (root / recipe.body_id / recipe.output_name).resolve()
    try:
        result.relative_to(root)
    except ValueError as error:
        raise ValueError(f'Recipe "{recipe.id}" output escapes the selected root') from error
    return result


def resolve_cache_root(explicit=None, environment=None):
    """Explicit flag wins, then the environment override, then the repo default."""
    environment = os.environ if environment is None else environment
    if explicit is not None:
        return pathlib.Path(explicit).resolve()
    override = environment.get(CACHE_ENVIRONMENT_VARIABLE)
    if override:
        return pathlib.Path(override).resolve()
    return DEFAULT_CACHE_ROOT


def cache_path(cache_root, sha256):
    """Content-addressed cache slot; the file name *is* the verified digest."""
    digest = sha256.lower()
    if SHA256_PATTERN.fullmatch(digest) is None:
        raise ValueError(f"cache lookups need a lowercase 64-character SHA-256, got {sha256!r}")
    return pathlib.Path(cache_root) / digest[:2] / digest


def file_sha256(path, chunk_bytes=1024 * 1024):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        while True:
            chunk = stream.read(chunk_bytes)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def download_verified(url, destination, expected_sha256, max_bytes=MAX_DOWNLOAD_BYTES, opener=None):
    if not url.startswith("https://"):
        raise ValueError("Texture downloads must use HTTPS")
    destination = pathlib.Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.download.tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "SolarVoyagerAssetTool/1.0"})
    opener = urllib.request.urlopen if opener is None else opener
    digest = hashlib.sha256()
    total = 0
    try:
        with opener(request, timeout=60) as response, temporary.open("wb") as stream:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(f"Texture download exceeds {max_bytes} bytes")
                digest.update(chunk)
                stream.write(chunk)
        actual = digest.hexdigest()
        if actual != expected_sha256.lower():
            raise ChecksumMismatchError(
                f"Texture SHA-256 mismatch: expected {expected_sha256}, measured {actual}",
                expected=expected_sha256.lower(),
                measured=actual,
            )
        os.replace(temporary, destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def _describe_field(label, value):
    return f"  {label:<14} {value}"


def describe_unavailable_source(recipe, cache_file, reason):
    """Offline-friendly copy: which file, where it goes, and where it came from."""
    return "\n".join(
        (
            f'Source "{recipe.id}" is not cached and could not be fetched.',
            "",
            _describe_field("missing file", recipe.output_name),
            _describe_field("needed at", recipe.dest),
            _describe_field("cache slot", cache_file),
            _describe_field("download from", recipe.url),
            _describe_field("product page", recipe.product_url),
            _describe_field("sha-256", recipe.sha256),
            _describe_field("license", recipe.license),
            "",
            f"  reason: {reason}",
            "",
            "Offline recovery: download the file above on a connected machine, then run",
            f"  python tools/fetch_textures.py --only {recipe.id} --source <path-to-downloaded-file>",
            "which verifies the bytes against the pinned SHA-256 and installs them in the",
            "cache. Copying the file to the cache slot shown above works too.",
            f"Set {CACHE_ENVIRONMENT_VARIABLE} to share one cache between checkouts.",
        )
    )


def describe_checksum_mismatch(recipe, measured):
    return "\n".join(
        (
            f'Source "{recipe.id}" does not match its pinned checksum. Nothing was cached.',
            "",
            _describe_field("download from", recipe.url),
            _describe_field("expected", recipe.sha256),
            _describe_field("measured", measured),
            _describe_field("needed at", recipe.dest),
            "",
            "The upstream file changed, the transfer was corrupted, or the manifest entry is",
            "stale. Do not repin the SHA-256 without re-reviewing the licence and the image;",
            "a silently swapped upstream file is exactly what this check exists to catch.",
        )
    )


def ensure_cached(recipe, cache_root, *, opener=None, offline=False, downloader=None):
    """Fetch → verify → cache. Returns `(path, CACHE_HIT | DOWNLOADED)`.

    A cache entry is only ever published after its bytes verified, so a hit is
    a verified hit; the stored digest is re-measured anyway, because a cache
    that lies is worse than no cache.
    """
    target = cache_path(cache_root, recipe.sha256)
    if target.is_file():
        measured = file_sha256(target)
        if measured == recipe.sha256:
            return target, CACHE_HIT
        print(
            f'Cached bytes for "{recipe.id}" hash {measured}, not the pinned '
            f"{recipe.sha256}; discarding and refetching.",
            file=sys.stderr,
        )
        target.unlink()

    if offline:
        raise SourceUnavailableError(
            describe_unavailable_source(
                recipe, target, "offline mode is on and the cache has no verified entry"
            )
        )

    downloader = download_verified if downloader is None else downloader
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        downloader(recipe.url, target, recipe.sha256, max_bytes=recipe.max_bytes, opener=opener)
    except ChecksumMismatchError as error:
        raise ChecksumMismatchError(
            describe_checksum_mismatch(recipe, error.measured),
            expected=recipe.sha256,
            measured=error.measured,
        ) from error
    except OSError as error:  # URLError and every socket/filesystem failure
        raise SourceUnavailableError(
            describe_unavailable_source(recipe, target, error)
        ) from error
    return target, DOWNLOADED


def install_source(path, recipe, cache_root):
    """Verify a hand-downloaded file against the pin and adopt it into the cache."""
    source = pathlib.Path(path).resolve()
    measured = file_sha256(source)
    if measured != recipe.sha256:
        raise ChecksumMismatchError(
            describe_checksum_mismatch(recipe, measured),
            expected=recipe.sha256,
            measured=measured,
        )
    target = cache_path(cache_root, recipe.sha256)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.install.tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def _processing_description(recipe):
    if recipe.kind == FILE_KIND:
        return "verified byte-for-byte against the pinned SHA-256 and copied unmodified"
    operations = [f"resized to {recipe.width}×{recipe.height}"]
    if recipe.normalize:
        operations.append("normalized to the available luminance range")
    if recipe.blur:
        operations.append(f"Gaussian-filtered at sigma {recipe.blur:g}")
    if recipe.contrast != 1.0:
        operations.append(f"contrast scaled by {recipe.contrast:g} around midpoint 128")
    operations.append(f"encoded as metadata-free {recipe.output_format.upper()}")
    return ", ".join(operations)


def _changes_description(recipe):
    if recipe.kind == FILE_KIND:
        return "none; the published file is the pinned source bytes"
    if recipe.normalize or recipe.blur:
        return "resized, luminance-normalized and filtered, re-encoded, and stripped of metadata"
    if recipe.contrast != 1.0:
        return "resized, contrast-enhanced, re-encoded, and stripped of metadata"
    return "format normalization and metadata removal; image content is otherwise unchanged"


def render_sources(body_id, recipes):
    lines = [f"# Texture sources — {body_id}", ""]
    for recipe in sorted(recipes, key=lambda item: item.id):
        lines.extend(
            (
                f"## {recipe.id}",
                "",
                f"- Product page: {recipe.product_url}",
                f"- Exact download: {recipe.source_url}",
                f"- License: {recipe.license}",
                f"- Pinned source SHA-256: `{recipe.sha256}`",
                f"- Processing: {_processing_description(recipe)}.",
                f"- Output: `{recipe.output_name}` ({recipe.role})",
                f"- Required credit: {recipe.credit}",
                f"- Changes: {_changes_description(recipe)}.",
                "",
            )
        )
    lines.append("Generated by `tools/fetch_textures.py`; KTX2 encoding belongs to `npm run assets:ingest`.")
    return "\n".join(lines) + "\n"


def process_image(source, destination, recipe, node_executable=None, runner=subprocess.run):
    node = node_executable or shutil.which("node")
    if node is None:
        raise FileNotFoundError("Node.js is required for deterministic Sharp image processing")
    destination = pathlib.Path(destination)
    temporary = destination.with_name(f".{destination.name}.process.tmp")
    temporary.unlink(missing_ok=True)
    try:
        command = [
                node,
                str(PROCESSOR_PATH),
                "--input",
                str(pathlib.Path(source).resolve()),
                "--output",
                str(temporary),
                "--width",
                str(recipe.width),
                "--height",
                str(recipe.height),
                "--format",
                recipe.output_format,
                "--quality",
                str(recipe.quality),
                "--contrast",
                str(recipe.contrast),
            ]
        if recipe.grayscale:
            command.append("--grayscale")
        if recipe.normalize:
            command.append("--normalize")
        if recipe.blur:
            command.extend(("--blur", str(recipe.blur)))
        runner(
            command,
            cwd=REPOSITORY_ROOT,
            check=True,
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def copy_verified_source(source, destination, recipe):
    """Publisher for `kind="file"` sources; Sharp cannot open a shape model."""
    destination = pathlib.Path(destination)
    temporary = destination.with_name(f".{destination.name}.copy.tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copyfile(pathlib.Path(source), temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def write_sources(body_directory, body_id, recipes):
    destination = pathlib.Path(body_directory).resolve() / "SOURCES.md"
    temporary = destination.with_name(f".{destination.name}.tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(render_sources(body_id, recipes))
    os.replace(temporary, destination)
    return destination


def _publish_body(
    body_id,
    recipes,
    output_root,
    source_override,
    processor,
    recipe_catalog,
    cache_root,
    opener,
    offline,
):
    output_root = pathlib.Path(output_root).resolve()
    body_directory = (output_root / body_id).resolve()
    body_directory.relative_to(output_root)
    staging = output_root / f".{body_id}.texture-stage"
    backup = output_root / f".{body_id}.texture-backup"
    for temporary_directory in (staging, backup):
        if temporary_directory.exists():
            shutil.rmtree(temporary_directory)
    output_root.mkdir(parents=True, exist_ok=True)
    if body_directory.exists():
        shutil.copytree(body_directory, staging)
    else:
        staging.mkdir()

    try:
        for recipe in recipes:
            destination = staging / recipe.output_name
            if source_override is not None:
                install_source(source_override, recipe, cache_root)
            cached, status = ensure_cached(
                recipe, cache_root, opener=opener, offline=offline
            )
            print(f"{'Cached' if status == CACHE_HIT else 'Fetched'} {recipe.id}: {cached}")
            if recipe.kind == FILE_KIND:
                copy_verified_source(cached, destination, recipe)
            else:
                processor(cached, destination, recipe)
        attribution_recipes = {
            recipe.id: recipe
            for recipe in recipe_catalog.values()
            if recipe.body_id == body_id and (staging / recipe.output_name).is_file()
        }
        attribution_recipes.update({recipe.id: recipe for recipe in recipes})
        write_sources(staging, body_id, tuple(attribution_recipes.values()))

        if body_directory.exists():
            os.replace(body_directory, backup)
        try:
            os.replace(staging, body_directory)
        except BaseException:
            if backup.exists():
                os.replace(backup, body_directory)
            raise
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def execute(
    recipes,
    output_root,
    source_override=None,
    processor=process_image,
    recipe_catalog=RECIPES,
    cache_root=None,
    opener=None,
    offline=False,
):
    if source_override is not None and len(recipes) != 1:
        raise ValueError("--source requires exactly one selected recipe")
    cache_root = resolve_cache_root() if cache_root is None else pathlib.Path(cache_root)
    by_body = {}
    for recipe in recipes:
        by_body.setdefault(recipe.body_id, []).append(recipe)
    for body_id, body_recipes in sorted(by_body.items()):
        _publish_body(
            body_id,
            body_recipes,
            output_root,
            source_override,
            processor,
            recipe_catalog,
            cache_root,
            opener,
            offline,
        )
        for recipe in body_recipes:
            print(f"Prepared {recipe.id}: {output_path(output_root, recipe)}")
        print(f"Wrote attribution: {pathlib.Path(output_root).resolve() / body_id / 'SOURCES.md'}")


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", default=[], dest="recipe_ids")
    parser.add_argument("--output-root", type=pathlib.Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument(
        "--source",
        type=pathlib.Path,
        help="adopt a hand-downloaded file into the cache after verifying its SHA-256",
    )
    parser.add_argument(
        "--cache-root",
        type=pathlib.Path,
        default=None,
        help=f"verified-source cache (default {CACHE_ROOT_RELATIVE}, or ${CACHE_ENVIRONMENT_VARIABLE})",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="never download; a cache miss reports where to put the missing file",
    )
    parser.add_argument(
        "--print-manifest",
        action="store_true",
        help="write the pinned {url, sha256, license, dest} manifest as JSON and exit",
    )
    return parser.parse_args(argv)


def main(argv=None):
    # Credits and licences carry non-ASCII text ("©", accented author names) and
    # Windows still defaults stdio to CP1252, which would turn a printed manifest
    # into a UnicodeEncodeError rather than output.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
        selected = select_recipes(arguments.recipe_ids)
        if arguments.print_manifest:
            sys.stdout.write(render_manifest(selected))
            return 0
        execute(
            selected,
            arguments.output_root,
            source_override=arguments.source,
            cache_root=resolve_cache_root(arguments.cache_root),
            offline=arguments.offline,
        )
    except SourceUnavailableError as error:
        print(str(error), file=sys.stderr)
        return EXIT_SOURCE_UNAVAILABLE
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"Texture fetch failed: {error}", file=sys.stderr)
        return EXIT_FAILED
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
