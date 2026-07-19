"""Blender-free deterministic annulus topology."""

import math
from typing import NamedTuple, Tuple


class AnnulusMeshData(NamedTuple):
    vertices: Tuple[Tuple[float, float, float], ...]
    faces: Tuple[Tuple[int, int, int, int], ...]
    uv_faces: Tuple[Tuple[Tuple[float, float], ...], ...]


def annulus_mesh_data(inner_radius, outer_radius, angular_segments=256, radial_segments=4):
    if not 0 < inner_radius < outer_radius:
        raise ValueError("Annulus requires positive increasing radii")
    if not isinstance(angular_segments, int) or angular_segments < 3:
        raise ValueError("angular_segments must be an integer >= 3")
    if not isinstance(radial_segments, int) or radial_segments < 1:
        raise ValueError("radial_segments must be an integer >= 1")

    vertices = []
    for radial_index in range(radial_segments + 1):
        radial_fraction = radial_index / radial_segments
        radius = inner_radius + (outer_radius - inner_radius) * radial_fraction
        for angular_index in range(angular_segments):
            angle = 2 * math.pi * angular_index / angular_segments
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), 0.0))

    faces = []
    uv_faces = []
    for radial_index in range(radial_segments):
        inner_row = radial_index * angular_segments
        outer_row = (radial_index + 1) * angular_segments
        u0 = radial_index / radial_segments
        u1 = (radial_index + 1) / radial_segments
        for angular_index in range(angular_segments):
            next_index = (angular_index + 1) % angular_segments
            v0 = angular_index / angular_segments
            v1 = (angular_index + 1) / angular_segments
            faces.append(
                (
                    inner_row + angular_index,
                    inner_row + next_index,
                    outer_row + next_index,
                    outer_row + angular_index,
                )
            )
            uv_faces.append(((u0, v0), (u0, v1), (u1, v1), (u1, v0)))
    return AnnulusMeshData(tuple(vertices), tuple(faces), tuple(uv_faces))
