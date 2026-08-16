"""Deterministic class-I geodesic sphere generation (no Blender dependency).

Blender's icosphere operator only reaches ``20 * 4^(k-1)`` triangles, which skips
from 1,280 straight past the 5,000-triangle small-body budget to 5,120. A class-I
geodesic sphere of frequency ``n`` has exactly ``20 * n**2`` triangles, so
frequency 15 fills 4,500 of the 5,000 available triangles.

Building the lattice here rather than through a Blender operator also makes the
vertex ordering a pure function of this module, which is what keeps two builds
byte-identical.
"""

import math


DEFAULT_FREQUENCY = 15


def _icosahedron():
    """Unit-radius regular icosahedron with outward-wound faces."""
    golden = (1.0 + math.sqrt(5.0)) / 2.0
    raw = (
        (-1.0, golden, 0.0),
        (1.0, golden, 0.0),
        (-1.0, -golden, 0.0),
        (1.0, -golden, 0.0),
        (0.0, -1.0, golden),
        (0.0, 1.0, golden),
        (0.0, -1.0, -golden),
        (0.0, 1.0, -golden),
        (golden, 0.0, -1.0),
        (golden, 0.0, 1.0),
        (-golden, 0.0, -1.0),
        (-golden, 0.0, 1.0),
    )
    faces = (
        (0, 11, 5),
        (0, 5, 1),
        (0, 1, 7),
        (0, 7, 10),
        (0, 10, 11),
        (1, 5, 9),
        (5, 11, 4),
        (11, 10, 2),
        (10, 7, 6),
        (7, 1, 8),
        (3, 9, 4),
        (3, 4, 2),
        (3, 2, 6),
        (3, 6, 8),
        (3, 8, 9),
        (4, 9, 5),
        (2, 4, 11),
        (6, 2, 10),
        (8, 6, 7),
        (9, 8, 1),
    )
    return tuple(_normalized(vertex) for vertex in raw), faces


def _normalized(vector):
    length = math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
    if length <= 0.0:
        raise ValueError("Cannot normalize a zero-length direction")
    return (vector[0] / length, vector[1] / length, vector[2] / length)


def _lattice_key(corners, weights):
    """Exact, face-independent identity for a barycentric lattice point.

    Sorting by global corner index makes the key — and the weighted sum computed
    from it — identical for the two base faces that share an edge, so shared
    points weld bit-exactly instead of landing a float ULP apart.
    """
    return tuple(
        sorted(
            (corner, weight)
            for corner, weight in zip(corners, weights)
            if weight > 0
        )
    )


def _lattice_position(key, base_vertices, frequency):
    x = 0.0
    y = 0.0
    z = 0.0
    for corner, weight in key:
        vertex = base_vertices[corner]
        x += weight * vertex[0]
        y += weight * vertex[1]
        z += weight * vertex[2]
    return _normalized((x / frequency, y / frequency, z / frequency))


def geodesic_sphere(frequency=DEFAULT_FREQUENCY):
    """Return ``(vertices, faces)`` for a unit class-I geodesic sphere.

    ``vertices`` is a tuple of ``(x, y, z)`` float triples on the unit sphere and
    ``faces`` a tuple of outward-wound vertex-index triples of length
    ``20 * frequency**2``.
    """
    if isinstance(frequency, bool) or not isinstance(frequency, int) or frequency < 1:
        raise ValueError(f"Geodesic frequency must be an integer >= 1; received {frequency!r}")

    base_vertices, base_faces = _icosahedron()
    indices = {}
    vertices = []
    faces = []

    for corners in base_faces:
        lattice = {}
        for row in range(frequency + 1):
            for column in range(row + 1):
                weights = (frequency - row, row - column, column)
                key = _lattice_key(corners, weights)
                index = indices.get(key)
                if index is None:
                    index = len(vertices)
                    indices[key] = index
                    vertices.append(_lattice_position(key, base_vertices, frequency))
                lattice[(row, column)] = index
        for row in range(1, frequency + 1):
            for column in range(row):
                faces.append(
                    (lattice[(row - 1, column)], lattice[(row, column)], lattice[(row, column + 1)])
                )
            for column in range(row - 1):
                faces.append(
                    (
                        lattice[(row - 1, column)],
                        lattice[(row, column + 1)],
                        lattice[(row - 1, column + 1)],
                    )
                )

    return tuple(vertices), tuple(faces)
