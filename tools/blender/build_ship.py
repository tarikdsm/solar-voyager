"""Build the deterministic Solar Voyager ship authoring asset."""

import argparse
from array import array
import math
import pathlib
import sys

import bpy
from mathutils import Matrix, Vector


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from common import (  # noqa: E402
    REPOSITORY_ROOT,
    build_manifest,
    create_pbr_material,
    export_glb,
    print_manifest,
    reset_scene,
)


MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
EXPECTED_NOZZLE_NAME = "engine_nozzle"
TEXTURE_WIDTH = 1024
TEXTURE_HEIGHT = 512
TRIANGLE_LIMIT = 30_000
EXPECTED_LENGTH_METERS = 26.12
LENGTH_TOLERANCE_METERS = 0.02
TEXTURE_FILENAMES = (
    "ship_mat_engine_glow__emissive.png",
    "ship_mat_hull__albedo.png",
    "ship_mat_hull__metallic.png",
    "ship_mat_hull__normal.png",
)


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    return parser.parse_args(arguments)


def _write_texture(path, name, pixel_function, *, non_color=False):
    pixels = array("f", [0.0]) * (TEXTURE_WIDTH * TEXTURE_HEIGHT * 4)
    offset = 0
    for y in range(TEXTURE_HEIGHT):
        v = y / (TEXTURE_HEIGHT - 1)
        for x in range(TEXTURE_WIDTH):
            u = x / TEXTURE_WIDTH
            red, green, blue = pixel_function(x, y, u, v)
            pixels[offset] = red
            pixels[offset + 1] = green
            pixels[offset + 2] = blue
            pixels[offset + 3] = 1.0
            offset += 4

    image = bpy.data.images.new(
        name,
        width=TEXTURE_WIDTH,
        height=TEXTURE_HEIGHT,
        alpha=True,
        float_buffer=False,
    )
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.filepath_raw = str(path)
    image.save()
    bpy.data.images.remove(image)
    return path


def _panel_distance(value, period):
    position = value % period
    return min(position, period - position)


def _hull_albedo(x, y, u, v):
    panel_line = _panel_distance(x, 128) < 3 or _panel_distance(y, 128) < 2
    longitudinal = 0.035 * math.cos(2.0 * math.pi * u * 8.0)
    latitudinal = 0.02 * math.cos(2.0 * math.pi * v * 4.0)
    value = 0.66 + longitudinal + latitudinal - (0.16 if panel_line else 0.0)
    value = max(0.34, min(0.78, value))
    return value * 0.98, value, min(0.82, value * 1.025)


def _hull_normal(x, y, u, v):
    panel_x = math.sin(2.0 * math.pi * u * 8.0) * 0.035
    panel_y = math.sin(2.0 * math.pi * v * 4.0) * 0.025
    if _panel_distance(x, 128) < 3:
        panel_x *= 2.2
    if _panel_distance(y, 128) < 2:
        panel_y *= 2.2
    normal_z = math.sqrt(max(0.0, 1.0 - panel_x * panel_x - panel_y * panel_y))
    return 0.5 + panel_x * 0.5, 0.5 + panel_y * 0.5, normal_z


def _hull_metallic(x, y, u, v):
    del u, v
    panel_line = _panel_distance(x, 128) < 3 or _panel_distance(y, 128) < 2
    roughness = 0.47 if panel_line else 0.31
    metallic = 0.78 if panel_line else 0.9
    return 1.0, roughness, metallic


def _engine_emissive(x, y, u, v):
    del x, y
    pulse = 0.82 + 0.18 * math.cos(2.0 * math.pi * u * 12.0)
    axial = 0.88 + 0.12 * math.cos(2.0 * math.pi * v * 2.0)
    energy = pulse * axial
    return 0.04 * energy, 0.68 * energy, energy


def _publish_textures(output_dir):
    generators = (
        ("ship_mat_engine_glow__emissive.png", _engine_emissive, False),
        ("ship_mat_hull__albedo.png", _hull_albedo, False),
        ("ship_mat_hull__metallic.png", _hull_metallic, True),
        ("ship_mat_hull__normal.png", _hull_normal, True),
    )
    paths = []
    for filename, generator, non_color in generators:
        paths.append(
            _write_texture(
                output_dir / filename,
                filename.removesuffix(".png"),
                generator,
                non_color=non_color,
            )
        )
    return tuple(paths)


def _wire_metallic_roughness(material, path):
    image = bpy.data.images.load(str(path.resolve()), check_existing=True)
    image.colorspace_settings.name = "Non-Color"
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "external_metallic"
    texture.label = "external_metallic"
    texture.image = image
    separate = nodes.new("ShaderNodeSeparateColor")
    links.new(texture.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], principled.inputs["Roughness"])
    links.new(separate.outputs["Blue"], principled.inputs["Metallic"])


def _materials(output_dir):
    hull = create_pbr_material(
        "mat_hull",
        base_color=(0.72, 0.73, 0.75, 1.0),
        roughness=0.35,
        metallic=0.85,
        albedo_path=output_dir / "ship_mat_hull__albedo.png",
        normal_path=output_dir / "ship_mat_hull__normal.png",
    )
    _wire_metallic_roughness(hull, output_dir / "ship_mat_hull__metallic.png")
    return {
        "canopy": create_pbr_material(
            "mat_canopy", base_color=(0.01, 0.02, 0.03, 1.0), roughness=0.08
        ),
        "engine_glow": create_pbr_material(
            "mat_engine_glow",
            base_color=(0.02, 0.05, 0.08, 1.0),
            roughness=0.2,
            emissive_path=output_dir / "ship_mat_engine_glow__emissive.png",
            emissive_strength=2.0,
        ),
        "hull": hull,
        "hull_dark": create_pbr_material(
            "mat_hull_dark",
            base_color=(0.13, 0.14, 0.16, 1.0),
            roughness=0.45,
            metallic=0.8,
        ),
        "nozzle": create_pbr_material(
            "mat_nozzle",
            base_color=(0.18, 0.18, 0.2, 1.0),
            roughness=0.3,
            metallic=1.0,
        ),
        "radiator": create_pbr_material(
            "mat_radiator",
            base_color=(0.09, 0.02, 0.02, 1.0),
            roughness=0.65,
            metallic=0.2,
        ),
    }


def _finish_object(obj, name, material, *, bevel=0.0, smooth=False):
    obj.name = name
    obj.data.name = f"mesh_{name}"
    obj.data.materials.append(material)
    if bevel > 0.0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def _cone(
    name,
    *,
    radius_a,
    radius_b,
    depth,
    location,
    material,
    bevel=0.04,
    capped=True,
):
    bpy.ops.mesh.primitive_cone_add(
        vertices=64,
        radius1=radius_a,
        radius2=radius_b,
        depth=depth,
        end_fill_type="NGON" if capped else "NOTHING",
        location=location,
        rotation=(math.radians(-90.0), 0.0, 0.0),
    )
    return _finish_object(
        bpy.context.object, name, material, bevel=bevel, smooth=True
    )


def _cube(name, *, size, location, scale, material, rotation=(0.0, 0.0, 0.0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(
        size=size, location=location, rotation=rotation
    )
    obj = bpy.context.object
    obj.scale = scale
    return _finish_object(obj, name, material, bevel=bevel)


def _sphere(name, *, radius, location, scale, material):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=24, ring_count=12, radius=radius, location=location
    )
    obj = bpy.context.object
    obj.scale = scale
    return _finish_object(obj, name, material, smooth=True)


def _build_geometry(materials):
    objects = [
        _cone(
            "hull_main",
            radius_a=2.0,
            radius_b=2.0,
            depth=14.0,
            location=(0.0, 0.0, 0.0),
            material=materials["hull"],
        ),
        _cone(
            "hull_nose",
            radius_a=2.0,
            radius_b=0.7,
            depth=5.0,
            location=(0.0, 9.5, 0.0),
            material=materials["hull"],
        ),
        _sphere(
            "hull_tip",
            radius=0.7,
            location=(0.0, 12.0, 0.0),
            scale=(1.0, 1.6, 1.0),
            material=materials["hull"],
        ),
        _cone(
            "engine_skirt",
            radius_a=2.4,
            radius_b=2.0,
            depth=3.0,
            location=(0.0, -8.5, 0.0),
            material=materials["hull_dark"],
        ),
        _cone(
            EXPECTED_NOZZLE_NAME,
            radius_a=2.0,
            radius_b=1.1,
            depth=3.0,
            location=(0.0, -11.5, 0.0),
            material=materials["nozzle"],
            capped=False,
        ),
    ]

    bpy.ops.mesh.primitive_circle_add(
        vertices=32,
        radius=1.7,
        fill_type="NGON",
        location=(0.0, -12.4, 0.0),
        rotation=(math.radians(90.0), 0.0, 0.0),
    )
    objects.append(
        _finish_object(
            bpy.context.object, "engine_glow_disc", materials["engine_glow"]
        )
    )

    bpy.ops.mesh.primitive_torus_add(
        major_segments=48,
        minor_segments=16,
        major_radius=3.4,
        minor_radius=0.35,
        location=(0.0, -4.0, 0.0),
        rotation=(math.radians(90.0), 0.0, 0.0),
    )
    objects.append(
        _finish_object(
            bpy.context.object,
            "drive_ring",
            materials["hull_dark"],
            smooth=True,
        )
    )

    pylon_scales = (
        (1.4, 0.5, 0.22),
        (0.22, 0.5, 1.4),
        (1.4, 0.5, 0.22),
        (0.22, 0.5, 1.4),
    )
    for index, angle in enumerate((0.0, 90.0, 180.0, 270.0)):
        radians = math.radians(angle)
        objects.append(
            _cube(
                f"pylon_{index}",
                size=1.0,
                location=(2.6 * math.cos(radians), -4.0, 2.6 * math.sin(radians)),
                scale=pylon_scales[index],
                material=materials["hull_dark"],
            )
        )

    objects.extend(
        (
            _cube(
                "radiator_P",
                size=1.0,
                location=(-4.2, 2.0, 0.0),
                scale=(3.6, 2.6, 0.05),
                material=materials["radiator"],
                bevel=0.04,
            ),
            _cube(
                "radiator_S",
                size=1.0,
                location=(4.2, 2.0, 0.0),
                scale=(3.6, 2.6, 0.05),
                material=materials["radiator"],
                bevel=0.04,
            ),
            _sphere(
                "canopy",
                radius=0.9,
                location=(0.0, 6.6, 1.55),
                scale=(0.75, 1.8, 0.55),
                material=materials["canopy"],
            ),
        )
    )

    for longitudinal in (5, -6):
        for angle in (45, 135, 225, 315):
            radians = math.radians(angle)
            objects.append(
                _cube(
                    f"rcs_{longitudinal}_{angle}",
                    size=0.5,
                    location=(
                        2.05 * math.cos(radians),
                        float(longitudinal),
                        2.05 * math.sin(radians),
                    ),
                    scale=(0.9, 1.4, 0.9),
                    material=materials["hull_dark"],
                    rotation=(0.0, -radians, 0.0),
                )
            )

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12,
        radius=0.06,
        depth=1.92,
        location=(0.0, -1.5, 2.9),
    )
    objects.append(
        _finish_object(
            bpy.context.object, "antenna_mast", materials["hull_dark"]
        )
    )
    bpy.ops.mesh.primitive_cone_add(
        vertices=24,
        radius1=0.55,
        radius2=0.1,
        depth=0.35,
        end_fill_type="NGON",
        location=(0.0, -1.7, 4.25),
        rotation=(math.radians(135.0), 0.0, 0.0),
    )
    dish = bpy.context.object
    dish.scale = (0.7, 0.7, 0.45)
    objects.append(
        _finish_object(dish, "antenna_dish", materials["hull_dark"], smooth=True)
    )
    return tuple(objects)


def _orient_nose_to_positive_x(objects):
    rotation = Matrix.Rotation(math.radians(-90.0), 4, "Z")
    for obj in objects:
        obj.matrix_world = rotation @ obj.matrix_world
    bpy.context.view_layer.update()


def _ship_length(objects):
    x_values = []
    for obj in objects:
        for corner in obj.bound_box:
            x_values.append((obj.matrix_world @ Vector(corner)).x)
    return max(x_values) - min(x_values)


def _write_sources(output_dir, triangles):
    records = [
        "# Sources — Ship",
        "",
        "- `ship.glb` — `tools/blender/build_ship.py` — Solar Voyager original asset; all rights reserved for project distribution — deterministic Blender 5.1 hard-surface model back-ported from the approved interactive reference scene.",
        "- `ship_mat_hull__albedo.png` — `tools/blender/build_ship.py` — Solar Voyager original asset — deterministic 1024×512 seam-safe silver hull panel pattern.",
        "- `ship_mat_hull__normal.png` — `tools/blender/build_ship.py` — Solar Voyager original asset — deterministic 1024×512 tangent-space panel normal map.",
        "- `ship_mat_hull__metallic.png` — `tools/blender/build_ship.py` — Solar Voyager original asset — deterministic 1024×512 glTF metallic/roughness channel map.",
        "- `ship_mat_engine_glow__emissive.png` — `tools/blender/build_ship.py` — Solar Voyager original asset — deterministic 1024×512 cyan engine emission map.",
        "",
        "## Authoring contract",
        "",
        f"One Blender unit equals one metre. Length: {EXPECTED_LENGTH_METERS:.2f} m; nose and drive axis point toward local +X per ADR-025; `engine_nozzle` is the plume attachment node. Applied geometry: {triangles:,} triangles (budget ≤30,000).",
        "",
    ]
    (output_dir / "SOURCES.md").write_text(
        "\n".join(records), encoding="utf-8", newline="\n"
    )


def build(output_root):
    output_dir = pathlib.Path(output_root).resolve() / "ship"
    output_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()
    texture_paths = _publish_textures(output_dir)
    objects = _build_geometry(_materials(output_dir))
    _orient_nose_to_positive_x(objects)
    nozzle = next(
        (obj for obj in objects if obj.name == EXPECTED_NOZZLE_NAME), None
    )
    if nozzle is None:
        raise RuntimeError(f'Missing required node "{EXPECTED_NOZZLE_NAME}"')
    if len(nozzle.data.polygons) != 64:
        raise RuntimeError("engine_nozzle must remain open for the recessed glow disc")
    tip = next(obj for obj in objects if obj.name == "hull_tip")
    nose_axis = tip.matrix_world.translation - nozzle.matrix_world.translation
    if nose_axis.length <= 1e-6 or nose_axis.x / nose_axis.length < 0.999:
        raise RuntimeError("Ship nose must align with local +X per ADR-025")

    glb_path = export_glb(objects, output_dir / "ship.glb", active=objects[0])
    manifest = build_manifest("ship", "ship", objects, glb_path, texture_paths)
    ship_length = _ship_length(objects)
    manifest["lengthMeters"] = round(ship_length, 6)
    _write_sources(output_dir, manifest["triangles"])
    print_manifest(manifest)

    if manifest["triangles"] <= 0 or manifest["triangles"] > TRIANGLE_LIMIT:
        raise RuntimeError(
            f'Ship emitted {manifest["triangles"]} triangles; expected 1–{TRIANGLE_LIMIT}'
        )
    if abs(ship_length - EXPECTED_LENGTH_METERS) > LENGTH_TOLERANCE_METERS:
        raise RuntimeError(
            f"Ship length is {ship_length:.6f} m, expected {EXPECTED_LENGTH_METERS:.2f} m"
        )
    if tuple(path.name for path in texture_paths) != TEXTURE_FILENAMES:
        raise RuntimeError("Ship texture manifest is incomplete or not canonical")
    return manifest


def main(argv=None):
    arguments = parse_arguments(arguments_after_separator(sys.argv) if argv is None else argv)
    build(arguments.output_root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Ship build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
