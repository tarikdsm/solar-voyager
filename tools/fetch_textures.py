"""Fetch, verify, and normalize licensed planetary source textures."""

import argparse
import hashlib
import os
import pathlib
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
        return self


RECIPES = {
    "earth-albedo": TextureRecipe(
        id="earth-albedo",
        body_id="earth",
        role="albedo",
        source_url="https://genesis-horizon.solarsystemscope.com/textures/download/8k_earth_daymap.jpg",
        product_url="https://genesis-horizon.solarsystemscope.com/textures/",
        license="CC BY 4.0",
        credit="Earth textures: Solar System Scope (solarsystemscope.com), CC BY 4.0.",
        sha256="88ab060b6e7d241cfc590c69f528fab2b3247b738d40124cb590999a6fe44abc",
        width=8192,
        height=4096,
        output_name="earth_albedo.png",
    )
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
                f"- Processing: decoded, converted to metadata-free RGB PNG, and normalized to {recipe.width}×{recipe.height}.",
                f"- Output: `{recipe.output_name}` ({recipe.role})",
                f"- Required credit: {recipe.credit}",
                "- Changes: format normalization and metadata removal; image content is otherwise unchanged.",
                "",
            )
        )
    lines.append("Generated by `tools/fetch_textures.py`; KTX2 encoding belongs to `npm run assets:ingest`.")
    return "\n".join(lines) + "\n"


def process_image(source, destination, recipe, node_executable=None):
    node = node_executable or shutil.which("node")
    if node is None:
        raise FileNotFoundError("Node.js is required for deterministic Sharp image processing")
    destination = pathlib.Path(destination)
    temporary = destination.with_name(f".{destination.name}.process.tmp")
    temporary.unlink(missing_ok=True)
    try:
        subprocess.run(
            (
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
            ),
            cwd=REPOSITORY_ROOT,
            check=True,
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def write_sources(output_root, body_id, recipes):
    destination = pathlib.Path(output_root).resolve() / body_id / "SOURCES.md"
    temporary = destination.with_name(f".{destination.name}.tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(render_sources(body_id, recipes))
    os.replace(temporary, destination)
    return destination


def execute(recipes, output_root, source_override=None):
    if source_override is not None and len(recipes) != 1:
        raise ValueError("--source requires exactly one selected recipe")
    by_body = {}
    for recipe in recipes:
        destination = output_path(output_root, recipe)
        destination.parent.mkdir(parents=True, exist_ok=True)
        raw_path = destination.with_name(f".{recipe.id}.source")
        if source_override is None:
            download_verified(recipe.source_url, raw_path, recipe.sha256)
        else:
            source = pathlib.Path(source_override).resolve()
            actual = hashlib.sha256(source.read_bytes()).hexdigest()
            if actual != recipe.sha256:
                raise ValueError(f"Texture SHA-256 mismatch: expected {recipe.sha256}, measured {actual}")
            shutil.copyfile(source, raw_path)
        try:
            process_image(raw_path, destination, recipe)
        finally:
            raw_path.unlink(missing_ok=True)
        by_body.setdefault(recipe.body_id, []).append(recipe)
        print(f"Prepared {recipe.id}: {destination}")
    for body_id, body_recipes in sorted(by_body.items()):
        print(f"Wrote attribution: {write_sources(output_root, body_id, body_recipes)}")


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
