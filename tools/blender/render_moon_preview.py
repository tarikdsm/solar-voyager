"""Render a repeatable review image from an authored Moon GLB."""

import argparse
import math
import pathlib
import sys

import bpy
import mathutils


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    return parser.parse_args(arguments)


def point_at(obj, target=(0.0, 0.0, 0.0)):
    direction = mathutils.Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def wire_external_textures(model):
    material = bpy.data.materials.get("mat_surface")
    if material is None:
        raise RuntimeError("Moon preview requires mat_surface")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    albedo = nodes.new("ShaderNodeTexImage")
    albedo.image = bpy.data.images.load(str(model.with_name("moon_albedo.jpg")))
    links.new(albedo.outputs["Color"], principled.inputs["Base Color"])
    normal_image = bpy.data.images.load(str(model.with_name("moon_normal.png")))
    normal_image.colorspace_settings.name = "Non-Color"
    normal = nodes.new("ShaderNodeTexImage")
    normal.image = normal_image
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.65
    links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])


def render(model, output):
    model = pathlib.Path(model).resolve()
    output = pathlib.Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    wire_external_textures(model)

    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.002, 0.003, 0.008, 1.0)
    background.inputs["Strength"].default_value = 0.05
    bpy.context.scene.world = world

    light_data = bpy.data.lights.new("preview_sun", type="SUN")
    light_data.energy = 4.0
    light_data.angle = math.radians(3.0)
    light = bpy.data.objects.new("preview_sun", light_data)
    bpy.context.collection.objects.link(light)
    light.rotation_euler = (math.radians(28), math.radians(-18), math.radians(-38))

    camera_data = bpy.data.cameras.new("preview_camera")
    camera_data.lens = 58
    camera = bpy.data.objects.new("preview_camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (2.65, -2.65, 1.35)
    point_at(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output)
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.ops.render.render(write_still=True)
    if not output.is_file():
        raise RuntimeError(f"Blender did not write preview: {output}")


if __name__ == "__main__":
    arguments = parse_arguments(arguments_after_separator(sys.argv))
    render(arguments.model, arguments.output)
