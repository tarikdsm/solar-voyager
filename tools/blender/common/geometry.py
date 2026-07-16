"""Normalized body geometry constructors."""

import bpy


def _finish_body_object(obj, name):
    obj.name = name
    obj.location = (0.0, 0.0, 0.0)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def create_uv_sphere(name, segments=128, rings=64, radius=1.0):
    if segments < 3 or rings < 3 or radius <= 0:
        raise ValueError("UV sphere requires segments/rings >= 3 and radius > 0")
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        radius=radius,
        calc_uvs=True,
        location=(0.0, 0.0, 0.0),
    )
    return _finish_body_object(bpy.context.active_object, name)


def create_quad_sphere(name, subdivisions=5, radius=1.0):
    if subdivisions < 1 or radius <= 0:
        raise ValueError("Quad sphere requires subdivisions >= 1 and radius > 0")
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    modifier = obj.modifiers.new(name="quad_sphere_subdivision", type="SUBSURF")
    modifier.subdivision_type = "SIMPLE"
    modifier.levels = subdivisions
    modifier.render_levels = subdivisions
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    for vertex in obj.data.vertices:
        vertex.co.normalize()
        vertex.co *= radius
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15192, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    return _finish_body_object(obj, name)
