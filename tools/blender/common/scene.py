"""Deterministic Blender scene lifecycle and selection."""

import bpy


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.frame_set(1)
    scene.render.fps = 60
    return scene


def select_only(objects, active=None):
    objects = tuple(objects)
    if not objects:
        raise ValueError("At least one object is required for selection")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0] if active is None else active
    return objects

