"""Shared authoring contract for Solar Voyager Blender builders."""

from .catalog import REPOSITORY_ROOT, asset_category, body_by_id
from .export import export_glb
from .geometry import create_quad_sphere, create_uv_sphere
from .glb import canonicalize_ellipsoid_normals
from .manifest import build_manifest, print_manifest
from .materials import create_pbr_material
from .rings import create_ring_annulus, create_ring_material
from .scene import reset_scene, select_only

__all__ = [
    "REPOSITORY_ROOT",
    "asset_category",
    "body_by_id",
    "build_manifest",
    "canonicalize_ellipsoid_normals",
    "create_pbr_material",
    "create_quad_sphere",
    "create_ring_annulus",
    "create_ring_material",
    "create_uv_sphere",
    "export_glb",
    "print_manifest",
    "reset_scene",
    "select_only",
]
