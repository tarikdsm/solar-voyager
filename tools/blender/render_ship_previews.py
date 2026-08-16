"""Render repeatable review images of the authored ship GLB.

The chase camera in v2 sits between roughly 2 and 50 ship lengths, so the
previews are framed at that range rather than as a catalogue turntable: a
three-quarter hero at ~2.5 lengths, a close nose/canopy view, and an aft view
looking into the nozzle. Textures are re-wired from the sibling PNGs because the
authored GLB deliberately carries no embedded images.
"""

import argparse
import math
import pathlib
import sys

import bpy
import mathutils


SHIP_LENGTH_METERS = 26.12

VIEWS = (
    ("hero", (46.0, -52.0, 21.0), (0.0, 0.0, 0.6), 62.0),
    ("nose", (16.5, -13.0, 6.2), (7.6, 0.0, 1.2), 70.0),
    ("engine", (-32.0, -16.0, 7.0), (-9.5, 0.0, 0.0), 62.0),
)


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", default="T0121-ship")
    parser.add_argument("--resolution", type=int, default=960)
    return parser.parse_args(arguments)


def point_at(obj, target):
    direction = mathutils.Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _wire_hull_textures(model):
    """Re-attach the external maps the strict export boundary leaves behind."""
    hull = bpy.data.materials.get("mat_hull")
    if hull is None:
        raise RuntimeError("Ship preview requires mat_hull")
    nodes = hull.node_tree.nodes
    links = hull.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")

    albedo = nodes.new("ShaderNodeTexImage")
    albedo.image = bpy.data.images.load(str(model.with_name("ship_mat_hull__albedo.png")))
    links.new(albedo.outputs["Color"], principled.inputs["Base Color"])

    normal_image = bpy.data.images.load(str(model.with_name("ship_mat_hull__normal.png")))
    normal_image.colorspace_settings.name = "Non-Color"
    normal_texture = nodes.new("ShaderNodeTexImage")
    normal_texture.image = normal_image
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])

    metallic_image = bpy.data.images.load(str(model.with_name("ship_mat_hull__metallic.png")))
    metallic_image.colorspace_settings.name = "Non-Color"
    metallic_texture = nodes.new("ShaderNodeTexImage")
    metallic_texture.image = metallic_image
    separate = nodes.new("ShaderNodeSeparateColor")
    links.new(metallic_texture.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], principled.inputs["Roughness"])
    links.new(separate.outputs["Blue"], principled.inputs["Metallic"])

    glow = bpy.data.materials.get("mat_engine_glow")
    if glow is not None:
        glow_nodes = glow.node_tree.nodes
        glow_links = glow.node_tree.links
        glow_principled = next(node for node in glow_nodes if node.type == "BSDF_PRINCIPLED")
        emissive = glow_nodes.new("ShaderNodeTexImage")
        emissive.image = bpy.data.images.load(
            str(model.with_name("ship_mat_engine_glow__emissive.png"))
        )
        emission_input = glow_principled.inputs.get("Emission Color")
        if emission_input is not None:
            glow_links.new(emissive.outputs["Color"], emission_input)


def render(model, output_dir, prefix, resolution):
    model = pathlib.Path(model).resolve()
    output_dir = pathlib.Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    _wire_hull_textures(model)

    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    # A dim sky stands in for the ambient environment `shipVisual.ts` gives the
    # hull at runtime; without it a 0.9-metalness hull renders black.
    background.inputs["Color"].default_value = (0.03, 0.04, 0.06, 1.0)
    background.inputs["Strength"].default_value = 0.35
    bpy.context.scene.world = world

    light_data = bpy.data.lights.new("preview_sun", type="SUN")
    light_data.energy = 5.0
    light_data.angle = math.radians(0.53)
    light = bpy.data.objects.new("preview_sun", light_data)
    bpy.context.collection.objects.link(light)
    light.rotation_euler = (math.radians(58), math.radians(-8), math.radians(-42))

    camera_data = bpy.data.cameras.new("preview_camera")
    camera = bpy.data.objects.new("preview_camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution * 9 // 16
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"

    written = []
    for name, location, target, lens in VIEWS:
        camera_data.lens = lens
        camera.location = location
        point_at(camera, target)
        output = output_dir / f"{prefix}-{name}.png"
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        if not output.is_file():
            raise RuntimeError(f"Blender did not write preview: {output}")
        distance = mathutils.Vector(location).length / SHIP_LENGTH_METERS
        print(f"rendered {output.name} at {distance:.2f} ship lengths", flush=True)
        written.append(output)
    return tuple(written)


if __name__ == "__main__":
    parsed = parse_arguments(arguments_after_separator(sys.argv))
    render(parsed.model, parsed.output_dir, parsed.prefix, parsed.resolution)
