"""Build the normalized Sun authoring asset with shared Blender helpers."""

import pathlib
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
)


def main():
    body = body_by_id("sun")
    output_dir = REPOSITORY_ROOT / "assets" / "models" / body["id"]

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
    manifest = build_manifest(body["id"], asset_category(body), (sun,), glb_path)
    print_manifest(manifest)

    if manifest["triangles"] > 50_000:
        raise RuntimeError("Sun exceeds its 50,000 triangle authoring budget")
    if abs(manifest["radius"] - 1.0) > 1e-6:
        raise RuntimeError(f'Sun radius is {manifest["radius"]}, expected 1.0')


if __name__ == "__main__":
    main()
