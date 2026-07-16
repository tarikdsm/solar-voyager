"""Principled PBR material construction with external authoring images."""

import pathlib

import bpy


def _load_image(path, non_color=False):
    resolved = pathlib.Path(path).resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Missing material texture: {resolved}")
    image = bpy.data.images.load(str(resolved), check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def _image_node(nodes, image, label):
    node = nodes.new("ShaderNodeTexImage")
    node.name = label
    node.label = label
    node.image = image
    return node


def create_pbr_material(
    name,
    *,
    base_color=(0.8, 0.8, 0.8, 1.0),
    roughness=0.8,
    metallic=0.0,
    albedo_path=None,
    normal_path=None,
    emissive_path=None,
    emissive_color=None,
    emissive_strength=1.0,
):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    principled.inputs["Base Color"].default_value = base_color
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic

    if albedo_path is not None:
        albedo = _image_node(nodes, _load_image(albedo_path), "external_albedo")
        links.new(albedo.outputs["Color"], principled.inputs["Base Color"])
    if normal_path is not None:
        normal = _image_node(nodes, _load_image(normal_path, non_color=True), "external_normal")
        normal_map = nodes.new("ShaderNodeNormalMap")
        links.new(normal.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    if emissive_path is not None or emissive_color is not None:
        emission_input = principled.inputs.get("Emission Color")
        if emission_input is None:
            emission_input = principled.inputs.get("Emission")
        if emission_input is None:
            raise RuntimeError("Blender Principled BSDF has no emission color input")
        if emissive_path is not None:
            emissive = _image_node(nodes, _load_image(emissive_path), "external_emissive")
            links.new(emissive.outputs["Color"], emission_input)
        else:
            emission_input.default_value = emissive_color
        strength_input = principled.inputs.get("Emission Strength")
        if strength_input is not None:
            strength_input.default_value = emissive_strength
    return material
