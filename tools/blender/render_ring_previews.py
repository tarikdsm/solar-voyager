"""Render repeatable review views from one authored ringed-planet GLB."""

import argparse
import math
import pathlib
import sys

import bpy
import mathutils


VIEWS = (
    ("lit", (4.6, -4.6, 2.8), (4.0, -4.0, 5.0)),
    ("edge", (0.0, -6.8, 0.24), (3.0, -4.0, 4.0)),
    ("backlit", (4.8, -4.8, 1.8), (-4.0, 4.0, -1.0)),
)


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    return parser.parse_args(arguments)


def point_at(obj, target=(0.0, 0.0, 0.0)):
    direction = mathutils.Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def require_authored_scene():
    meshes = tuple(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    if len(meshes) != 2:
        raise RuntimeError(f"Ring preview requires exactly two meshes, found {len(meshes)}")
    material_names = {
        material.name
        for obj in meshes
        for material in obj.data.materials
        if material is not None
    }
    if not {"mat_surface", "mat_rings"}.issubset(material_names):
        raise RuntimeError(f"Ring preview requires mat_surface and mat_rings: {material_names}")
    forbidden = tuple(
        obj.name for obj in bpy.context.scene.objects if obj.type in {"CAMERA", "LIGHT"}
    )
    if forbidden:
        raise RuntimeError(f"Authored GLB unexpectedly contains review objects: {forbidden}")


def image_texture(nodes, image_path, *, non_color=False):
    image = bpy.data.images.load(str(image_path), check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    return texture


def wire_external_textures(model):
    body_id = model.stem
    surface = bpy.data.materials.get("mat_surface")
    rings = bpy.data.materials.get("mat_rings")
    if surface is None or rings is None:
        raise RuntimeError("Ring preview requires mat_surface and mat_rings")

    surface.use_nodes = True
    surface_nodes = surface.node_tree.nodes
    surface_links = surface.node_tree.links
    surface_principled = next(
        node for node in surface_nodes if node.type == "BSDF_PRINCIPLED"
    )
    albedo = image_texture(surface_nodes, model.with_name(f"{body_id}_albedo.jpg"))
    surface_links.new(albedo.outputs["Color"], surface_principled.inputs["Base Color"])

    rings.use_nodes = True
    ring_nodes = rings.node_tree.nodes
    ring_links = rings.node_tree.links
    ring_principled = next(node for node in ring_nodes if node.type == "BSDF_PRINCIPLED")
    ring_texture = image_texture(ring_nodes, model.with_name(f"{body_id}_rings.png"))
    ring_links.new(ring_texture.outputs["Color"], ring_principled.inputs["Base Color"])
    ring_links.new(ring_texture.outputs["Alpha"], ring_principled.inputs["Alpha"])
    ring_principled.inputs["Roughness"].default_value = 1.0
    if hasattr(rings, "surface_render_method"):
        rings.surface_render_method = "DITHERED"
    elif hasattr(rings, "blend_method"):
        rings.blend_method = "BLEND"


def configure_world():
    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.001, 0.002, 0.006, 1.0)
    background.inputs["Strength"].default_value = 0.018
    bpy.context.scene.world = world


def create_camera():
    camera_data = bpy.data.cameras.new("review_camera")
    camera_data.lens = 60
    camera = bpy.data.objects.new("review_camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    return camera


def create_key_light():
    light_data = bpy.data.lights.new("review_key", type="AREA")
    light_data.energy = 900.0
    light_data.shape = "DISK"
    light_data.size = 4.0
    light = bpy.data.objects.new("review_key", light_data)
    bpy.context.collection.objects.link(light)
    return light


def render_views(model, output_dir):
    model = pathlib.Path(model).resolve()
    output_dir = pathlib.Path(output_dir).resolve()
    if not model.is_file():
        raise FileNotFoundError(f"Missing authored GLB: {model}")
    output_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    require_authored_scene()
    wire_external_textures(model)
    configure_world()
    camera = create_camera()
    key = create_key_light()

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"

    for view_name, camera_location, light_location in VIEWS:
        camera.location = camera_location
        point_at(camera)
        key.location = light_location
        point_at(key)
        output = output_dir / f"{model.stem}-{view_name}.png"
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        if not output.is_file():
            raise RuntimeError(f"Blender did not write preview: {output}")


if __name__ == "__main__":
    arguments = parse_arguments(arguments_after_separator(sys.argv))
    render_views(arguments.model, arguments.output_dir)
