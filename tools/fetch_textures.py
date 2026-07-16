"""Fetch, verify, and normalize licensed planetary source textures."""

import argparse
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.request


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"
PROCESSOR_PATH = REPOSITORY_ROOT / "tools" / "textures" / "processImage.mjs"
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024


class TextureRecipe:
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
        quality=90,
        contrast=1.0,
        grayscale=False,
        normalize=False,
        blur=0.0,
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
        self.quality = quality
        self.contrast = contrast
        self.grayscale = grayscale
        self.normalize = normalize
        self.blur = blur

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

    def validate(self):
        if not self.source_url.startswith("https://") or not self.product_url.startswith("https://"):
            raise ValueError(f'Recipe "{self.id}" source and product URLs must use HTTPS')
        if len(self.sha256) != 64 or any(character not in "0123456789abcdef" for character in self.sha256):
            raise ValueError(f'Recipe "{self.id}" must pin a lowercase SHA-256')
        if self.width <= 0 or self.height <= 0 or self.width != self.height * 2:
            raise ValueError(f'Recipe "{self.id}" must target a positive 2:1 image')
        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", self.body_id) is None:
            raise ValueError(f'Recipe "{self.id}" body id must be a lowercase slug')
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
}


def select_recipes(requested_ids, recipes=RECIPES):
    selected_ids = sorted(recipes) if not requested_ids else sorted(set(requested_ids))
    unknown = sorted(set(selected_ids) - set(recipes))
    if unknown:
        raise ValueError(
            f"unknown recipe id(s): {', '.join(unknown)}; supported: {', '.join(sorted(recipes))}"
        )
    return tuple(recipes[recipe_id].validate() for recipe_id in selected_ids)


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
            raise ValueError(f"Texture SHA-256 mismatch: expected {expected_sha256}, measured {actual}")
        os.replace(temporary, destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def _processing_description(recipe):
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


def write_sources(body_directory, body_id, recipes):
    destination = pathlib.Path(body_directory).resolve() / "SOURCES.md"
    temporary = destination.with_name(f".{destination.name}.tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(render_sources(body_id, recipes))
    os.replace(temporary, destination)
    return destination


def _publish_body(body_id, recipes, output_root, source_override, processor, recipe_catalog):
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
            raw_path = staging / f".{recipe.id}.source"
            if source_override is None:
                download_verified(recipe.source_url, raw_path, recipe.sha256)
            else:
                source = pathlib.Path(source_override).resolve()
                actual = hashlib.sha256(source.read_bytes()).hexdigest()
                if actual != recipe.sha256:
                    raise ValueError(
                        f"Texture SHA-256 mismatch: expected {recipe.sha256}, measured {actual}"
                    )
                shutil.copyfile(source, raw_path)
            try:
                processor(raw_path, destination, recipe)
            finally:
                raw_path.unlink(missing_ok=True)
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
):
    if source_override is not None and len(recipes) != 1:
        raise ValueError("--source requires exactly one selected recipe")
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
        )
        for recipe in body_recipes:
            print(f"Prepared {recipe.id}: {output_path(output_root, recipe)}")
        print(f"Wrote attribution: {pathlib.Path(output_root).resolve() / body_id / 'SOURCES.md'}")


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", default=[], dest="recipe_ids")
    parser.add_argument("--output-root", type=pathlib.Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--source", type=pathlib.Path)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
        execute(
            select_recipes(arguments.recipe_ids),
            arguments.output_root,
            source_override=arguments.source,
        )
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"Texture fetch failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
