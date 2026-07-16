"""Stable authored-asset measurements and manifest output."""

import json
import math
import pathlib

import bpy


def _measure_objects(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    radius = 0.0
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            for vertex in mesh.vertices:
                position = evaluated.matrix_world @ vertex.co
                radius = max(radius, math.sqrt(position.x**2 + position.y**2 + position.z**2))
        finally:
            evaluated.to_mesh_clear()
    return triangles, radius


def _texture_record(path):
    path = pathlib.Path(path).resolve()
    image = bpy.data.images.load(str(path), check_existing=True)
    return {"file": path.name, "width": int(image.size[0]), "height": int(image.size[1]), "bytes": path.stat().st_size}


def build_manifest(body_id, category, objects, glb_path, texture_paths=()):
    triangles, radius = _measure_objects(tuple(objects))
    glb_path = pathlib.Path(glb_path).resolve()
    return {
        "body": body_id,
        "category": category,
        "triangles": triangles,
        "radius": round(radius, 9),
        "glb": {"file": glb_path.name, "bytes": glb_path.stat().st_size},
        "textures": [_texture_record(path) for path in sorted(texture_paths, key=lambda item: pathlib.Path(item).name)],
    }


def print_manifest(manifest):
    print("=== ASSET MANIFEST ===", flush=True)
    print(json.dumps(manifest, sort_keys=True, separators=(",", ":")), flush=True)
    print("======================", flush=True)

