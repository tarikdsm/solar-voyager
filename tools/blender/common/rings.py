"""Blender adapters for deterministic annulus geometry and ring materials."""

import pathlib

import bpy

from ring_geometry import annulus_mesh_data


def create_ring_annulus(name, inner_radius, outer_radius, segments=256, radial_segments=4):
    data = annulus_mesh_data(inner_radius, outer_radius, segments, radial_segments)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(data.vertices, (), data.faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="radial_angular")
    for polygon, uv_face in zip(mesh.polygons, data.uv_faces):
        for loop_index, uv in zip(polygon.loop_indices, uv_face):
            uv_layer.data[loop_index].uv = uv
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def create_ring_material(name, texture_path):
    resolved = pathlib.Path(texture_path).resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Missing ring texture: {resolved}")
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    principled.inputs["Roughness"].default_value = 1.0
    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "external_rings"
    texture.image = bpy.data.images.load(str(resolved), check_existing=True)
    links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    links.new(texture.outputs["Alpha"], principled.inputs["Alpha"])
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"
    return material
