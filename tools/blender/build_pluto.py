"""Build the deterministic normalized Pluto authoring asset.

Run headless:
  blender --background --python tools/blender/build_pluto.py

The approved appearance uses the NASA/JPL PIA11707 albedo on a dwarf-tier
64×32 UV sphere. Runtime detail textures are published alongside the source GLB
and wired by the canonical ingest pipeline.
"""

import argparse
import pathlib
import shutil
import sys

import bpy
from mathutils import Vector


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from common import (  # noqa: E402
    build_manifest,
    canonicalize_ellipsoid_normals,
    create_pbr_material,
    create_uv_sphere,
    export_glb,
    print_manifest,
    reset_scene,
)
from pluto_config import MODELS_ROOT, REPOSITORY_ROOT, pluto_config  # noqa: E402


SEGMENTS = 64
RINGS = 32
EXPECTED_TRIANGLES = 3_968
DEFAULT_BLEND_OUTPUT = REPOSITORY_ROOT / "assets" / "blender" / "pluto.blend"
DEFAULT_PREVIEW_OUTPUT = REPOSITORY_ROOT / "assets" / "blender" / "previews" / "pluto_preview.png"
DEFAULT_VIEWPORT_OUTPUT = REPOSITORY_ROOT / "assets" / "blender" / "previews" / "pluto_viewport.png"


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    parser.add_argument("--blend-output", type=pathlib.Path, default=DEFAULT_BLEND_OUTPUT)
    parser.add_argument("--preview-output", type=pathlib.Path, default=DEFAULT_PREVIEW_OUTPUT)
    parser.add_argument("--viewport-output", type=pathlib.Path, default=DEFAULT_VIEWPORT_OUTPUT)
    return parser.parse_args(arguments)


def _publish_files(config, output_dir):
    texture_paths = []
    published = []
    for item in config.publish_files:
        destination = output_dir / item.output_name
        if item.source_path.resolve() != destination.resolve():
            shutil.copyfile(item.source_path, destination)
        published.append(destination)
        if item.role != "provenance":
            texture_paths.append(destination)
    return tuple(texture_paths), tuple(published)


def _add_review_environment():
    light_data = bpy.data.lights.new(name="sun_preview", type="SUN")
    light_data.energy = 3.0
    light = bpy.data.objects.new("sun_preview", light_data)
    bpy.context.collection.objects.link(light)
    light.rotation_euler = (0.785, 0.3, 0.5)

    fill_data = bpy.data.lights.new(name="sun_preview_fill", type="SUN")
    fill_data.energy = 1.1
    fill = bpy.data.objects.new("sun_preview_fill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.rotation_euler = (2.2, -0.3, -2.6)

    world = bpy.data.worlds.new("world_space")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.01, 0.01, 0.02, 1.0)
    background.inputs["Strength"].default_value = 0.3


def _point_camera(camera, location):
    camera.location = location
    camera.rotation_euler = (-Vector(location)).to_track_quat("-Z", "Y").to_euler()


def _render_review(preview_output, viewport_output):
    camera_data = bpy.data.cameras.new("camera_preview")
    camera_data.lens = 55.0
    camera = bpy.data.objects.new("camera_preview", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    fill_data = bpy.data.lights.new("camera_preview_fill", type="AREA")
    fill_data.energy = 550.0
    fill_data.shape = "DISK"
    fill_data.size = 4.0
    fill = bpy.data.objects.new("camera_preview_fill", fill_data)
    bpy.context.collection.objects.link(fill)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    outputs = (
        (pathlib.Path(preview_output).resolve(), (0.0, -4.1, 0.0)),
        (pathlib.Path(viewport_output).resolve(), (0.0, -3.5, -2.4)),
    )
    for path, location in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        _point_camera(camera, location)
        _point_camera(fill, tuple(component * 0.9 for component in location))
        scene.render.filepath = str(path)
        result = bpy.ops.render.render(write_still=True)
        if "FINISHED" not in result or not path.is_file():
            raise RuntimeError(f"Blender failed to render Pluto review image {path}: {result}")
    return tuple(path for path, _ in outputs)


def build(output_root, blend_output, preview_output, viewport_output):
    config = pluto_config(models_root=output_root)
    output_dir = config.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()
    surface = create_uv_sphere(
        config.body_id,
        segments=SEGMENTS,
        rings=RINGS,
        radius=1.0,
    )
    material = create_pbr_material(
        "mat_surface",
        roughness=0.78,
        metallic=0.0,
        albedo_path=config.preview_albedo_path,
    )
    surface.data.materials.append(material)
    _add_review_environment()

    glb_path = export_glb((surface,), output_dir / "pluto.glb", active=surface)
    canonicalize_ellipsoid_normals(glb_path, config.polar_radius_ratio)
    textures, published = _publish_files(config, output_dir)
    review_images = _render_review(preview_output, viewport_output)

    blend_path = pathlib.Path(blend_output).resolve()
    blend_path.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=True, copy=True)
    if "FINISHED" not in result or not blend_path.is_file():
        raise RuntimeError(f"Blender failed to save review scene {blend_path}: {result}")

    manifest = build_manifest(
        config.body_id,
        config.category,
        (surface,),
        glb_path,
        textures,
    )
    manifest["meanRadiusKm"] = config.mean_radius_km
    manifest["polarRadiusRatio"] = config.polar_radius_ratio
    manifest["proceduralSeed"] = config.procedural_seed
    manifest["publishedFiles"] = [path.name for path in published]
    manifest["reviewBlend"] = blend_path.name
    manifest["reviewImages"] = [path.name for path in review_images]
    print_manifest(manifest)

    if manifest["triangles"] != EXPECTED_TRIANGLES:
        raise RuntimeError(
            f'Pluto emitted {manifest["triangles"]} triangles, expected {EXPECTED_TRIANGLES}'
        )
    if abs(manifest["radius"] - 1.0) > 1e-6:
        raise RuntimeError(f'Pluto radius is {manifest["radius"]}, expected 1.0')
    return manifest


def main(argv=None):
    arguments = parse_arguments(arguments_after_separator(sys.argv) if argv is None else argv)
    build(
        arguments.output_root,
        arguments.blend_output,
        arguments.preview_output,
        arguments.viewport_output,
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        print(f"Pluto build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
