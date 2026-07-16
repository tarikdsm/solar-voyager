"""Build the normalized Sun authoring asset with shared Blender helpers."""

import argparse
import pathlib
import shutil
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from common import (  # noqa: E402
    REPOSITORY_ROOT,
    asset_category,
    body_by_id,
    build_manifest,
    create_pbr_material,
    create_uv_sphere,
    export_glb,
    print_manifest,
    reset_scene,
    canonicalize_ellipsoid_normals,
)


MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
SOURCE_DIRECTORY = MODELS_ROOT / "sun"


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    return parser.parse_args(arguments)


def build(output_root):
    body = body_by_id("sun")
    output_dir = pathlib.Path(output_root).resolve() / body["id"]
    output_dir.mkdir(parents=True, exist_ok=True)
    source_record = SOURCE_DIRECTORY / "SOURCES.md"
    destination_record = output_dir / "SOURCES.md"
    if source_record.resolve() != destination_record.resolve():
        shutil.copyfile(source_record, destination_record)

    reset_scene()
    sun = create_uv_sphere("sun", segments=128, rings=64)
    material = create_pbr_material(
        "mat_surface",
        base_color=(0.02, 0.01, 0.0, 1.0),
        roughness=1.0,
        emissive_color=(1.0, 0.83, 0.55, 1.0),
        emissive_strength=10.0,
    )
    sun.data.materials.append(material)
    glb_path = export_glb((sun,), output_dir / "sun.glb")
    canonicalize_ellipsoid_normals(glb_path, 1.0)
    manifest = build_manifest(body["id"], asset_category(body), (sun,), glb_path)
    print_manifest(manifest)

    if manifest["triangles"] > 50_000:
        raise RuntimeError("Sun exceeds its 50,000 triangle authoring budget")
    if abs(manifest["radius"] - 1.0) > 1e-6:
        raise RuntimeError(f'Sun radius is {manifest["radius"]}, expected 1.0')
    return manifest


def main(argv=None):
    arguments = parse_arguments(arguments_after_separator(sys.argv) if argv is None else argv)
    build(arguments.output_root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Sun build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
