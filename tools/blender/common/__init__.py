"""Shared authoring contract for Solar Voyager Blender builders."""

from .catalog import REPOSITORY_ROOT, asset_category, body_by_id
from .export import export_glb
from .geodesic import DEFAULT_FREQUENCY, geodesic_sphere
from .geometry import (
    create_anchor,
    create_displaced_body,
    create_quad_sphere,
    create_uv_sphere,
)
from .glb import canonicalize_ellipsoid_normals, canonicalize_mesh_normals, read_gltf_json
from .manifest import build_manifest, print_manifest
from .materials import create_pbr_material
from .procedural_shape import ProceduralShape, equirectangular_direction, shade_field
from .rings import create_ring_annulus, create_ring_material
from .scene import reset_scene, select_only
from .shape_model import load_shape_model, normalize_unit_radius

__all__ = [
    "DEFAULT_FREQUENCY",
    "REPOSITORY_ROOT",
    "ProceduralShape",
    "asset_category",
    "body_by_id",
    "build_manifest",
    "canonicalize_ellipsoid_normals",
    "canonicalize_mesh_normals",
    "create_anchor",
    "create_displaced_body",
    "create_pbr_material",
    "create_quad_sphere",
    "create_ring_annulus",
    "create_ring_material",
    "create_uv_sphere",
    "equirectangular_direction",
    "export_glb",
    "geodesic_sphere",
    "load_shape_model",
    "normalize_unit_radius",
    "print_manifest",
    "read_gltf_json",
    "reset_scene",
    "select_only",
    "shade_field",
]
