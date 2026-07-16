"""Normalized body geometry constructors."""

import math

import bpy


def _finish_body_object(obj, name):
    obj.name = name
    obj.location = (0.0, 0.0, 0.0)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def _apply_equirectangular_uv(obj):
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    uv_layer = obj.data.uv_layers.new(name="equirectangular")
    for polygon in obj.data.polygons:
        loop_records = []
        for loop_index in polygon.loop_indices:
            position = obj.data.vertices[obj.data.loops[loop_index].vertex_index].co.normalized()
            # Blender (X, Y, Z) exports to glTF (X, Z, -Y); its exporter also
            # flips V, placing the glTF north pole at the top of a 2:1 image.
            u = (0.5 + math.atan2(-position.y, position.x) / (2.0 * math.pi)) % 1.0
            v = 0.5 + math.asin(max(-1.0, min(1.0, position.z))) / math.pi
            loop_records.append([loop_index, u, v, math.hypot(position.x, position.y)])
        values = [record[1] for record in loop_records if record[3] > 1e-9]
        if values and max(values) - min(values) > 0.5:
            for record in loop_records:
                if record[1] < 0.5:
                    record[1] += 1.0
            values = [record[1] for record in loop_records if record[3] > 1e-9]
        pole_u = sum(values) / len(values) if values else 0.5
        for loop_index, u, v, horizontal_radius in loop_records:
            uv_layer.data[loop_index].uv = (pole_u if horizontal_radius <= 1e-9 else u, v)
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
    return _apply_equirectangular_uv(_finish_body_object(obj, name))
