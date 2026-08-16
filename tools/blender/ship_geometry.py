"""Blender-free deterministic hard-surface primitives for the ship builder.

Every generator returns a :class:`MeshData` whose vertices, faces, per-loop UVs
and per-loop normals are produced in a fixed order from pure arithmetic. Nothing
here imports ``bpy``, so ``tools/tests/test_blender_ship_primitives.py`` can
exercise the topology, the winding and the analytic normals without Blender.

Authoring frame (metres, Blender axes):

* ``+X`` is the nose and thrust axis (ADR-025).
* ``+Z`` is dorsal "up".
* ``+Y`` is port, ``-Y`` is starboard.

Blender's glTF export maps ``(x, y, z)`` to ``(x, z, -y)``, so the runtime model
frame has ``+X`` nose, ``+Y`` up and ``+Z`` starboard — the frame
``src/render/shipVisual.ts`` measured and encoded as ``MODEL_TO_BODY``.

Ring angles are measured from ``+Z`` (dorsal) toward ``-Y`` (starboard), which
puts the cylindrical UV seam on the dorsal spine where the hull structure hides
it.
"""

import math
from typing import NamedTuple, Optional, Sequence, Tuple


Vector3 = Tuple[float, float, float]
Vector2 = Tuple[float, float]


class MeshData(NamedTuple):
    """One primitive: polygon soup with per-loop UVs and analytic normals."""

    vertices: Tuple[Vector3, ...]
    faces: Tuple[Tuple[int, ...], ...]
    uv_faces: Tuple[Tuple[Vector2, ...], ...]
    normal_faces: Tuple[Tuple[Vector3, ...], ...]

    @property
    def triangles(self) -> int:
        """Triangles after fan triangulation, which is what glTF stores."""
        return sum(len(face) - 2 for face in self.faces)


class ProfilePoint(NamedTuple):
    """One station of a surface of revolution about the ship's ``+X`` axis."""

    x: float
    radius: float
    #: When true the two adjacent bands share an averaged normal at this
    #: station, producing a continuous curve; when false the station is a hard
    #: crease, which is what makes hull steps read as plating.
    smooth: bool = True


def _normalize(vector: Vector3) -> Vector3:
    length = math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
    if length <= 0.0:
        raise ValueError("Cannot normalize a zero-length vector")
    return (vector[0] / length, vector[1] / length, vector[2] / length)


def ring_direction(angle: float) -> Vector3:
    """Outward radial direction at ``angle``, measured from +Z toward -Y."""
    return (0.0, -math.sin(angle), math.cos(angle))


def merge(parts: Sequence[MeshData]) -> MeshData:
    """Concatenate primitives in argument order, keeping index bases stable."""
    vertices: list = []
    faces: list = []
    uv_faces: list = []
    normal_faces: list = []
    for part in parts:
        offset = len(vertices)
        vertices.extend(part.vertices)
        faces.extend(tuple(index + offset for index in face) for face in part.faces)
        uv_faces.extend(part.uv_faces)
        normal_faces.extend(part.normal_faces)
    return MeshData(tuple(vertices), tuple(faces), tuple(uv_faces), tuple(normal_faces))


def transform(
    mesh: MeshData,
    *,
    rotation: Optional[Tuple[Vector3, Vector3, Vector3]] = None,
    scale: Vector3 = (1.0, 1.0, 1.0),
    translation: Vector3 = (0.0, 0.0, 0.0),
) -> MeshData:
    """Place a primitive: scale, then rotate (three row vectors), then translate.

    Normals are carried by the inverse-transpose of the scale so a flattened
    blister — the canopy is one — keeps exact shading instead of the sheared
    normals a naive rotation would produce.
    """
    rows = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)) if rotation is None else rotation
    if any(component == 0.0 for component in scale):
        raise ValueError("Transform scale components must be non-zero")

    def rotate(vector: Vector3) -> Vector3:
        return (
            rows[0][0] * vector[0] + rows[0][1] * vector[1] + rows[0][2] * vector[2],
            rows[1][0] * vector[0] + rows[1][1] * vector[1] + rows[1][2] * vector[2],
            rows[2][0] * vector[0] + rows[2][1] * vector[1] + rows[2][2] * vector[2],
        )

    vertices = []
    for vertex in mesh.vertices:
        placed = rotate((vertex[0] * scale[0], vertex[1] * scale[1], vertex[2] * scale[2]))
        vertices.append(
            (placed[0] + translation[0], placed[1] + translation[1], placed[2] + translation[2])
        )
    normal_faces = tuple(
        tuple(
            rotate(_normalize((normal[0] / scale[0], normal[1] / scale[1], normal[2] / scale[2])))
            for normal in face
        )
        for face in mesh.normal_faces
    )
    return MeshData(tuple(vertices), mesh.faces, mesh.uv_faces, normal_faces)


def roll_rotation(angle: float) -> Tuple[Vector3, Vector3, Vector3]:
    """Rows of the roll about ``+X`` that carries local ``+Z`` onto the hull ring.

    Greebles are modelled flat-on and rolled onto their station, so the same
    chamfered box serves every angle around the hull.
    """
    cosine = math.cos(angle)
    sine = math.sin(angle)
    return ((1.0, 0.0, 0.0), (0.0, cosine, -sine), (0.0, sine, cosine))


def rotation_from_axis(axis: Vector3) -> Tuple[Vector3, Vector3, Vector3]:
    """Rows of the rotation that carries local ``+X`` onto ``axis``.

    Used to aim thruster bells and masts. The roll about ``axis`` is fixed by
    choosing the reference up vector deterministically, so two runs of the
    builder place every nozzle identically.
    """
    forward = _normalize(axis)
    reference = (0.0, 0.0, 1.0) if abs(forward[2]) < 0.9 else (0.0, 1.0, 0.0)
    right = _normalize(
        (
            reference[1] * forward[2] - reference[2] * forward[1],
            reference[2] * forward[0] - reference[0] * forward[2],
            reference[0] * forward[1] - reference[1] * forward[0],
        )
    )
    up = (
        forward[1] * right[2] - forward[2] * right[1],
        forward[2] * right[0] - forward[0] * right[2],
        forward[0] * right[1] - forward[1] * right[0],
    )
    return (
        (forward[0], right[0], up[0]),
        (forward[1], right[1], up[1]),
        (forward[2], right[2], up[2]),
    )


def _band_normal(start: ProfilePoint, end: ProfilePoint) -> Tuple[float, float]:
    """Axial/radial components of the exact normal of one lathe band."""
    delta_x = end.x - start.x
    delta_r = end.radius - start.radius
    length = math.hypot(delta_x, delta_r)
    if length <= 0.0:
        raise ValueError("Lathe profile stations must not coincide")
    return (-delta_r / length, delta_x / length)


def _station_normals(profile: Sequence[ProfilePoint]) -> Tuple[Tuple[Tuple[float, float], ...], ...]:
    """Per-band, per-end axial/radial normals honouring the smooth flags."""
    band_normals = [_band_normal(profile[index], profile[index + 1]) for index in range(len(profile) - 1)]
    resolved = []
    for index, band in enumerate(band_normals):
        start = band
        end = band
        if profile[index].smooth and index > 0:
            previous = band_normals[index - 1]
            start = _blend(previous, band)
        if profile[index + 1].smooth and index + 1 < len(band_normals):
            following = band_normals[index + 1]
            end = _blend(band, following)
        resolved.append((start, end))
    return tuple(resolved)


def _blend(left: Tuple[float, float], right: Tuple[float, float]) -> Tuple[float, float]:
    axial = left[0] + right[0]
    radial = left[1] + right[1]
    length = math.hypot(axial, radial)
    if length <= 0.0:
        return left
    return (axial / length, radial / length)


def arc_lengths(profile: Sequence[ProfilePoint]) -> Tuple[float, ...]:
    """Cumulative profile arc length, which is how ``V`` is distributed."""
    arc = [0.0]
    for index in range(len(profile) - 1):
        arc.append(
            arc[-1]
            + math.hypot(
                profile[index + 1].x - profile[index].x,
                profile[index + 1].radius - profile[index].radius,
            )
        )
    return tuple(arc)


def lathe(
    profile: Sequence[ProfilePoint],
    segments: int,
    *,
    u_range: Vector2 = (0.0, 1.0),
    v_range: Vector2 = (0.0, 1.0),
    with_uvs: bool = True,
    flip: bool = False,
) -> MeshData:
    """Surface of revolution about ``+X`` with exact normals and cylindrical UVs.

    Stations must advance along ``+X``. That is not cosmetic: the outward
    normal and the counter-clockwise winding are both derived from a positive
    axial step, so a reversed profile would silently emit an inside-out shell.
    Pass ``flip=True`` for surfaces meant to be seen from the inside, such as
    the nozzle liner and the recessed glow well.
    """
    if len(profile) < 2:
        raise ValueError("Lathe requires at least two profile stations")
    if not isinstance(segments, int) or segments < 3:
        raise ValueError("Lathe requires an integer segments >= 3")
    if any(point.radius < 0.0 for point in profile):
        raise ValueError("Lathe profile radii must be non-negative")
    if any(profile[index + 1].x <= profile[index].x for index in range(len(profile) - 1)):
        raise ValueError("Lathe profile stations must strictly increase along +X")

    normals = _station_normals(profile)
    arc = arc_lengths(profile)
    span = arc[-1]

    vertices: list = []
    faces: list = []
    uv_faces: list = []
    normal_faces: list = []
    for band in range(len(profile) - 1):
        start = profile[band]
        end = profile[band + 1]
        start_normal, end_normal = normals[band]
        base = len(vertices)
        for index in range(segments + 1):
            angle = 2.0 * math.pi * (index % segments) / segments
            direction = ring_direction(angle)
            vertices.append(
                (start.x, direction[1] * start.radius, direction[2] * start.radius)
            )
            vertices.append((end.x, direction[1] * end.radius, direction[2] * end.radius))
        v0 = v_range[0] + (v_range[1] - v_range[0]) * (arc[band] / span)
        v1 = v_range[0] + (v_range[1] - v_range[0]) * (arc[band + 1] / span)
        for index in range(segments):
            corner = base + index * 2
            face = (corner, corner + 2, corner + 3, corner + 1)
            u0 = u_range[0] + (u_range[1] - u_range[0]) * (index / segments)
            u1 = u_range[0] + (u_range[1] - u_range[0]) * ((index + 1) / segments)
            uv_face = ((u0, v0), (u1, v0), (u1, v1), (u0, v1)) if with_uvs else ()
            corner_normals = []
            for angle_index, (axial, radial) in (
                (index, start_normal),
                (index + 1, start_normal),
                (index + 1, end_normal),
                (index, end_normal),
            ):
                direction = ring_direction(2.0 * math.pi * (angle_index % segments) / segments)
                corner_normals.append(
                    _normalize((axial, direction[1] * radial, direction[2] * radial))
                )
            if flip:
                face = face[::-1]
                uv_face = uv_face[::-1]
                corner_normals = [
                    (-normal[0], -normal[1], -normal[2]) for normal in corner_normals[::-1]
                ]
            faces.append(face)
            uv_faces.append(uv_face)
            normal_faces.append(tuple(corner_normals))
    return MeshData(tuple(vertices), tuple(faces), tuple(uv_faces), tuple(normal_faces))


def disc(
    x: float,
    radius: float,
    segments: int,
    *,
    facing: float = 1.0,
    uv_center: Vector2 = (0.5, 0.5),
    uv_scale: float = 0.0,
    with_uvs: bool = True,
    inner_radius: float = 0.0,
) -> MeshData:
    """Flat cap or annulus in the YZ plane, wound to face ``+X`` or ``-X``.

    ``uv_scale`` of 0 collapses the cap into a single texel, which is what hull
    caps want: they are hidden by the engine and nose assemblies and should not
    claim texture space.
    """
    if not isinstance(segments, int) or segments < 3:
        raise ValueError("Disc requires an integer segments >= 3")
    if radius <= 0.0 or inner_radius < 0.0 or inner_radius >= radius:
        raise ValueError("Disc requires 0 <= inner_radius < radius")
    normal = (1.0, 0.0, 0.0) if facing >= 0.0 else (-1.0, 0.0, 0.0)
    vertices: list = []
    faces: list = []
    uv_faces: list = []
    normal_faces: list = []

    def uv_for(direction: Vector3, scale: float) -> Vector2:
        return (
            uv_center[0] + uv_scale * scale * direction[1],
            uv_center[1] + uv_scale * scale * direction[2],
        )

    if inner_radius == 0.0:
        vertices.append((x, 0.0, 0.0))
        for index in range(segments):
            direction = ring_direction(2.0 * math.pi * index / segments)
            vertices.append((x, direction[1] * radius, direction[2] * radius))
        for index in range(segments):
            first = 1 + index
            second = 1 + (index + 1) % segments
            faces.append((0, second, first) if facing >= 0.0 else (0, first, second))
            if with_uvs:
                center_uv = (uv_center[0], uv_center[1])
                a = uv_for(ring_direction(2.0 * math.pi * index / segments), 1.0)
                b = uv_for(ring_direction(2.0 * math.pi * ((index + 1) % segments) / segments), 1.0)
                uv_faces.append((center_uv, b, a) if facing >= 0.0 else (center_uv, a, b))
            else:
                uv_faces.append(())
            normal_faces.append((normal, normal, normal))
        return MeshData(tuple(vertices), tuple(faces), tuple(uv_faces), tuple(normal_faces))

    for index in range(segments):
        direction = ring_direction(2.0 * math.pi * index / segments)
        vertices.append((x, direction[1] * inner_radius, direction[2] * inner_radius))
        vertices.append((x, direction[1] * radius, direction[2] * radius))
    for index in range(segments):
        inner_a = index * 2
        outer_a = index * 2 + 1
        inner_b = ((index + 1) % segments) * 2
        outer_b = ((index + 1) % segments) * 2 + 1
        faces.append(
            (inner_a, outer_a, outer_b, inner_b)
            if facing >= 0.0
            else (inner_a, inner_b, outer_b, outer_a)
        )
        if with_uvs:
            direction_a = ring_direction(2.0 * math.pi * index / segments)
            direction_b = ring_direction(2.0 * math.pi * ((index + 1) % segments) / segments)
            ratio = inner_radius / radius
            corners = (
                uv_for(direction_a, ratio),
                uv_for(direction_a, 1.0),
                uv_for(direction_b, 1.0),
                uv_for(direction_b, ratio),
            )
            uv_faces.append(corners if facing >= 0.0 else (corners[0], corners[3], corners[2], corners[1]))
        else:
            uv_faces.append(())
        normal_faces.append((normal, normal, normal, normal))
    return MeshData(tuple(vertices), tuple(faces), tuple(uv_faces), tuple(normal_faces))


def chamfered_box(
    half_extents: Vector3,
    chamfer: float,
    *,
    with_uvs: bool = False,
) -> MeshData:
    """Box with all twelve edges chamfered: 6 faces, 12 edge strips, 8 corners.

    The chamfers exist for one reason: at chase-camera range a bare 90° edge
    reads as a black line, while a 2–4 cm chamfer catches the sun and draws the
    silhouette of every greeble.
    """
    if any(extent <= 0.0 for extent in half_extents):
        raise ValueError("Chamfered box requires positive half extents")
    if chamfer <= 0.0 or chamfer >= min(half_extents):
        raise ValueError("Chamfer must be positive and smaller than every half extent")

    signs = (-1.0, 1.0)
    index_of = {}
    vertices: list = []
    for sx in signs:
        for sy in signs:
            for sz in signs:
                for axis in range(3):
                    extent = [
                        sx * (half_extents[0] - (0.0 if axis == 0 else chamfer)),
                        sy * (half_extents[1] - (0.0 if axis == 1 else chamfer)),
                        sz * (half_extents[2] - (0.0 if axis == 2 else chamfer)),
                    ]
                    index_of[(sx, sy, sz, axis)] = len(vertices)
                    vertices.append((extent[0], extent[1], extent[2]))

    faces: list = []
    normal_faces: list = []

    def add(indices, normal):
        faces.append(tuple(indices))
        normal_faces.append(tuple(normal for _ in indices))

    # Six axis-aligned faces, wound counter-clockwise as seen from outside.
    for axis in range(3):
        for sign in signs:
            normal = [0.0, 0.0, 0.0]
            normal[axis] = sign
            others = [value for value in range(3) if value != axis]
            corners = []
            for first, second in ((-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)):
                key = [0.0, 0.0, 0.0]
                key[axis] = sign
                key[others[0]] = first
                key[others[1]] = second
                corners.append(index_of[(key[0], key[1], key[2], axis)])
            oriented = corners if _face_winding(vertices, corners, tuple(normal)) else corners[::-1]
            add(oriented, tuple(normal))

    # Twelve edge chamfers.
    for axis in range(3):
        others = [value for value in range(3) if value != axis]
        for first in signs:
            for second in signs:
                quad = []
                for along in signs:
                    key = [0.0, 0.0, 0.0]
                    key[axis] = along
                    key[others[0]] = first
                    key[others[1]] = second
                    quad.append((key[0], key[1], key[2]))
                normal = [0.0, 0.0, 0.0]
                normal[others[0]] = first
                normal[others[1]] = second
                unit = _normalize((normal[0], normal[1], normal[2]))
                corners = [
                    index_of[(quad[0][0], quad[0][1], quad[0][2], others[0])],
                    index_of[(quad[0][0], quad[0][1], quad[0][2], others[1])],
                    index_of[(quad[1][0], quad[1][1], quad[1][2], others[1])],
                    index_of[(quad[1][0], quad[1][1], quad[1][2], others[0])],
                ]
                oriented = corners if _face_winding(vertices, corners, unit) else corners[::-1]
                add(oriented, unit)

    # Eight corner triangles.
    for sx in signs:
        for sy in signs:
            for sz in signs:
                unit = _normalize((sx, sy, sz))
                corners = [
                    index_of[(sx, sy, sz, 0)],
                    index_of[(sx, sy, sz, 1)],
                    index_of[(sx, sy, sz, 2)],
                ]
                oriented = corners if _face_winding(vertices, corners, unit) else corners[::-1]
                add(oriented, unit)

    uv_faces = tuple(
        tuple((0.5, 0.5) for _ in face) if with_uvs else () for face in faces
    )
    return MeshData(tuple(vertices), tuple(faces), uv_faces, tuple(normal_faces))


def _face_winding(vertices: Sequence[Vector3], indices: Sequence[int], normal: Vector3) -> bool:
    """True when ``indices`` are wound counter-clockwise about ``normal``."""
    a = vertices[indices[0]]
    b = vertices[indices[1]]
    c = vertices[indices[2]]
    edge1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    edge2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2],
        edge1[0] * edge2[1] - edge1[1] * edge2[0],
    )
    return cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] > 0.0


def torus(
    major_radius: float,
    minor_radius: float,
    major_segments: int,
    minor_segments: int,
) -> MeshData:
    """Ring encircling the ``+X`` axis; used for collars and the drive ring."""
    if major_radius <= minor_radius or minor_radius <= 0.0:
        raise ValueError("Torus requires 0 < minor_radius < major_radius")
    if not isinstance(major_segments, int) or major_segments < 3:
        raise ValueError("Torus requires an integer major_segments >= 3")
    if not isinstance(minor_segments, int) or minor_segments < 3:
        raise ValueError("Torus requires an integer minor_segments >= 3")

    vertices: list = []
    normals: list = []
    for major in range(major_segments):
        direction = ring_direction(2.0 * math.pi * major / major_segments)
        for minor in range(minor_segments):
            phi = 2.0 * math.pi * minor / minor_segments
            radial = major_radius + minor_radius * math.cos(phi)
            vertices.append(
                (minor_radius * math.sin(phi), direction[1] * radial, direction[2] * radial)
            )
            normals.append(
                _normalize(
                    (
                        math.sin(phi),
                        direction[1] * math.cos(phi),
                        direction[2] * math.cos(phi),
                    )
                )
            )

    faces: list = []
    normal_faces: list = []
    for major in range(major_segments):
        next_major = (major + 1) % major_segments
        for minor in range(minor_segments):
            next_minor = (minor + 1) % minor_segments
            quad = (
                major * minor_segments + minor,
                next_major * minor_segments + minor,
                next_major * minor_segments + next_minor,
                major * minor_segments + next_minor,
            )
            faces.append(quad)
            normal_faces.append(tuple(normals[index] for index in quad))
    uv_faces = tuple(() for _ in faces)
    return MeshData(tuple(vertices), tuple(faces), uv_faces, tuple(normal_faces))


def bounds(mesh: MeshData) -> Tuple[Vector3, Vector3]:
    """Axis-aligned bounds; the builder measures ship length from these."""
    if not mesh.vertices:
        raise ValueError("Cannot measure an empty mesh")
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for vertex in mesh.vertices:
        for axis in range(3):
            minimum[axis] = min(minimum[axis], vertex[axis])
            maximum[axis] = max(maximum[axis], vertex[axis])
    return (
        (minimum[0], minimum[1], minimum[2]),
        (maximum[0], maximum[1], maximum[2]),
    )
