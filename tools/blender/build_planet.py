"""Build a normalized planet authoring asset from the body catalog.

Run headless:
  blender --background --python tools/blender/build_planet.py -- --id earth
"""

import argparse
import math
import pathlib
import shutil
import sys

import bpy


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from common import (  # noqa: E402
    build_manifest,
    canonicalize_ellipsoid_normals,
    create_pbr_material,
    create_ring_annulus,
    create_ring_material,
    create_uv_sphere,
    export_glb,
    print_manifest,
    reset_scene,
)
from planet_config import MODELS_ROOT, planet_config  # noqa: E402
from ring_config import RINGED_PLANET_IDS, ring_planet_config  # noqa: E402


CLOUD_SHELL_RATIO = 1.004
SUPPORT_FILENAMES = ("SOURCES.md", "earth_detail_albedo.jpg", "earth_detail_normal.png")


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    return parser.parse_args(arguments)


def _apply_polar_ratio(obj, ratio):
    for vertex in obj.data.vertices:
        vertex.co.z *= ratio


def _cloud_material(path):
    material = bpy.data.materials.new("mat_clouds")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    principled.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    principled.inputs["Roughness"].default_value = 1.0
    image = bpy.data.images.load(str(path.resolve()), check_existing=True)
    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "external_clouds"
    texture.image = image
    links.new(texture.outputs["Color"], principled.inputs["Alpha"])
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"
    return material


def _texture_by_role(config, role):
    return next(texture for texture in config.textures if texture.role == role)


def _copy_support_files(source_dir, output_dir):
    missing = [name for name in SUPPORT_FILENAMES if not (source_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing Earth support files: {', '.join(missing)}")
    if source_dir.resolve() == output_dir.resolve():
        return
    for name in SUPPORT_FILENAMES:
        shutil.copyfile(source_dir / name, output_dir / name)


def _publish_textures(config, output_dir):
    output_paths = []
    for texture in config.textures:
        output_path = output_dir / texture.output_name
        if texture.resize_to is None:
            shutil.copyfile(texture.source_path, output_path)
        else:
            image = bpy.data.images.load(str(texture.source_path.resolve()), check_existing=True)
            image.scale(*texture.resize_to)
            image.file_format = "PNG"
            image.filepath_raw = str(output_path)
            image.save()
        output_paths.append(output_path)
    return tuple(output_paths)


def _surface_axes(obj):
    equatorial = max(math.hypot(vertex.co.x, vertex.co.y) for vertex in obj.data.vertices)
    polar = max(abs(vertex.co.z) for vertex in obj.data.vertices)
    return equatorial, polar


def _build_earth(body_id, output_root):
    config = planet_config(body_id)
    output_dir = pathlib.Path(output_root).resolve() / config.category / body_id
    output_dir.mkdir(parents=True, exist_ok=True)
    _copy_support_files(config.output_dir, output_dir)

    reset_scene()
    surface = create_uv_sphere(body_id, segments=128, rings=64, radius=1.0)
    _apply_polar_ratio(surface, config.polar_radius_ratio)
    surface_material = create_pbr_material(
        "mat_surface",
        roughness=0.85,
        albedo_path=_texture_by_role(config, "albedo").source_path,
        normal_path=_texture_by_role(config, "normal").source_path,
        emissive_path=_texture_by_role(config, "emissive").source_path,
        emissive_strength=1.0,
    )
    surface.data.materials.append(surface_material)

    clouds = create_uv_sphere(
        f"{body_id}_clouds", segments=128, rings=64, radius=CLOUD_SHELL_RATIO
    )
    _apply_polar_ratio(clouds, config.polar_radius_ratio)
    clouds.data.materials.append(_cloud_material(_texture_by_role(config, "clouds").source_path))

    glb_path = export_glb((surface, clouds), output_dir / f"{body_id}.glb", active=surface)
    canonicalize_ellipsoid_normals(glb_path, config.polar_radius_ratio)
    texture_paths = _publish_textures(config, output_dir)
    manifest = build_manifest(
        body_id, config.category, (surface, clouds), glb_path, texture_paths
    )
    manifest["equatorialRadius"] = 1.0
    manifest["polarRadiusRatio"] = config.polar_radius_ratio
    print_manifest(manifest)

    equatorial, polar = _surface_axes(surface)
    if manifest["triangles"] != 32_256:
        raise RuntimeError(f'Planet emitted {manifest["triangles"]} triangles, expected 32256')
    if abs(equatorial - 1.0) > 1e-6:
        raise RuntimeError(f"Planet equatorial radius is {equatorial}, expected 1.0")
    measured_ratio = polar / equatorial
    if abs(measured_ratio - config.polar_radius_ratio) > 1e-6:
        raise RuntimeError(
            f"Planet polar ratio is {measured_ratio}, expected {config.polar_radius_ratio}"
        )
    return manifest


def _build_ringed(body_id, output_root):
    config = ring_planet_config(body_id)
    output_dir = pathlib.Path(output_root).resolve() / config.category / body_id
    output_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()
    surface = create_uv_sphere(body_id, segments=128, rings=64, radius=1.0)
    _apply_polar_ratio(surface, config.polar_radius_ratio)
    source_by_role = {source.role: source for source in config.source_files}
    surface_material = create_pbr_material(
        config.surface_material_name,
        roughness=0.9,
        albedo_path=source_by_role["planet albedo"].path,
    )
    surface.data.materials.append(surface_material)

    rings = create_ring_annulus(
        f"{body_id}_rings",
        config.inner_radius_ratio,
        config.outer_radius_ratio,
        segments=config.angular_segments,
        radial_segments=config.radial_segments,
    )
    rings.data.materials.append(
        create_ring_material(config.ring_material_name, source_by_role["ring texture"].path)
    )

    glb_path = export_glb((surface, rings), output_dir / f"{body_id}.glb", active=surface)
    published = []
    for source in config.source_files:
        output_path = output_dir / source.output_name
        shutil.copyfile(source.path, output_path)
        if output_path.suffix.lower() in (".jpg", ".jpeg", ".png"):
            published.append(output_path)
    manifest = build_manifest(body_id, config.category, (surface, rings), glb_path, published)
    manifest["equatorialRadius"] = 1.0
    manifest["polarRadiusRatio"] = config.polar_radius_ratio
    manifest["ringInnerRadiusRatio"] = config.inner_radius_ratio
    manifest["ringOuterRadiusRatio"] = config.outer_radius_ratio
    print_manifest(manifest)

    equatorial, polar = _surface_axes(surface)
    expected_surface_triangles = 16_128
    expected_ring_triangles = config.angular_segments * config.radial_segments * 2
    if manifest["triangles"] != expected_surface_triangles + expected_ring_triangles:
        raise RuntimeError(
            f'Ringed planet emitted {manifest["triangles"]} triangles, '
            f"expected {expected_surface_triangles + expected_ring_triangles}"
        )
    if expected_ring_triangles > 5_000:
        raise RuntimeError(f"Ring annulus emitted {expected_ring_triangles} triangles")
    if abs(equatorial - 1.0) > 1e-6:
        raise RuntimeError(f"Planet equatorial radius is {equatorial}, expected 1.0")
    measured_ratio = polar / equatorial
    if abs(measured_ratio - config.polar_radius_ratio) > 1e-6:
        raise RuntimeError(
            f"Planet polar ratio is {measured_ratio}, expected {config.polar_radius_ratio}"
        )
    return manifest


def build(body_id, output_root):
    if body_id in RINGED_PLANET_IDS:
        return _build_ringed(body_id, output_root)
    return _build_earth(body_id, output_root)


def main(argv=None):
    arguments = parse_arguments(
        arguments_after_separator(sys.argv) if argv is None else argv
    )
    build(arguments.id, arguments.output_root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Planet build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
