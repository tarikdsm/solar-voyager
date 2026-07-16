"""Strict authored GLB export boundary."""

import pathlib

import bpy

from .scene import select_only


def export_glb(objects, output_path, active=None):
    objects = select_only(objects, active=active)
    output_path = pathlib.Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_image_format="NONE",
    )
    if "FINISHED" not in result or not output_path.is_file():
        raise RuntimeError(f"Blender failed to export {output_path}: {result}")
    return output_path

