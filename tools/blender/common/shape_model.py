"""Published shape-model ingest: OBJ parsing, deterministic decimation, normalization.

NASA PDS SBN distributes the NEAR (Eros), OSIRIS-REx (Bennu), Hayabusa2 (Ryugu)
and Rosetta (67P) shape models as public-domain Wavefront OBJ. This module reads
them without Blender so the whole real-model path is unit-testable, and reduces
them to the 5,000-triangle small-body budget with uniform-grid vertex clustering
rather than Blender's DECIMATE modifier — clustering is a pure function of the
vertex positions and the grid, so two builds cannot disagree.

The builders own the fetch policy; this module only consumes an already-downloaded
file and re-verifies its pinned SHA-256 before trusting it.
"""

import hashlib
import math
import pathlib


SUPPORTED_FORMATS = ("obj",)
MAX_CLUSTER_RESOLUTION = 512


def _parse_vertex(fields, line_number):
    if len(fields) < 3:
        raise ValueError(f"OBJ line {line_number}: a vertex needs three coordinates")
    try:
        vertex = tuple(float(value) for value in fields[:3])
    except ValueError as error:
        raise ValueError(f"OBJ line {line_number}: vertex coordinates must be numbers") from error
    if not all(math.isfinite(component) for component in vertex):
        raise ValueError(f"OBJ line {line_number}: vertex coordinates must be finite")
    return vertex


def _parse_face_index(field, vertex_count, line_number):
    token = field.split("/", 1)[0]
    try:
        index = int(token)
    except ValueError as error:
        raise ValueError(f"OBJ line {line_number}: face index must be an integer") from error
    if index > 0:
        resolved = index - 1
    elif index < 0:
        resolved = vertex_count + index
    else:
        raise ValueError(f"OBJ line {line_number}: face index 0 is not valid in Wavefront OBJ")
    if not 0 <= resolved < vertex_count:
        raise ValueError(f"OBJ line {line_number}: face index {index} is out of range")
    return resolved


def parse_obj(source):
    """Parse Wavefront OBJ text into ``(vertices, triangles)``.

    Polygons are fan-triangulated; texture and normal records are discarded
    because the builders regenerate both deterministically.
    """
    vertices = []
    faces = []
    for line_number, raw_line in enumerate(str(source).splitlines(), start=1):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        keyword, _, remainder = line.partition(" ")
        fields = remainder.split()
        if keyword == "v":
            vertices.append(_parse_vertex(fields, line_number))
        elif keyword == "f":
            if len(fields) < 3:
                raise ValueError(f"OBJ line {line_number}: a face needs at least three corners")
            corners = [_parse_face_index(field, len(vertices), line_number) for field in fields]
            for offset in range(1, len(corners) - 1):
                faces.append((corners[0], corners[offset], corners[offset + 1]))
    if not vertices or not faces:
        raise ValueError("OBJ source is empty: no vertex or face records were found")
    return tuple(vertices), tuple(faces)


def _canonical_face(face):
    """Rotate a triangle to start at its smallest index, preserving winding."""
    if face[0] <= face[1] and face[0] <= face[2]:
        return face
    if face[1] <= face[2]:
        return (face[1], face[2], face[0])
    return (face[2], face[0], face[1])


def cluster(vertices, faces, resolution):
    """Collapse `vertices` onto a `resolution`³ grid and remap `faces`."""
    if isinstance(resolution, bool) or not isinstance(resolution, int) or resolution < 1:
        raise ValueError(f"Cluster resolution must be an integer >= 1; received {resolution!r}")
    minimum = [min(vertex[axis] for vertex in vertices) for axis in range(3)]
    maximum = [max(vertex[axis] for vertex in vertices) for axis in range(3)]
    extent = [maximum[axis] - minimum[axis] for axis in range(3)]
    span = max(extent)
    if not math.isfinite(span) or span <= 0.0:
        raise ValueError("Shape model has no spatial extent to cluster")

    cells = {}
    membership = []
    for vertex in vertices:
        key = tuple(
            min(resolution - 1, int((vertex[axis] - minimum[axis]) / span * resolution))
            for axis in range(3)
        )
        cells.setdefault(key, []).append(vertex)
        membership.append(key)

    ordered_keys = sorted(cells)
    index_by_key = {key: index for index, key in enumerate(ordered_keys)}
    representatives = []
    for key in ordered_keys:
        members = sorted(cells[key])
        representatives.append(
            tuple(sum(member[axis] for member in members) / len(members) for axis in range(3))
        )

    remapped = set()
    for face in faces:
        corners = tuple(index_by_key[membership[corner]] for corner in face)
        if corners[0] == corners[1] or corners[1] == corners[2] or corners[0] == corners[2]:
            continue
        remapped.add(_canonical_face(corners))

    used = sorted({corner for face in remapped for corner in face})
    compacted = {corner: index for index, corner in enumerate(used)}
    return (
        tuple(representatives[corner] for corner in used),
        tuple(sorted((compacted[a], compacted[b], compacted[c]) for a, b, c in remapped)),
    )


def decimate(vertices, faces, max_triangles):
    """Reduce `faces` to at most `max_triangles`, finest grid that still fits."""
    if isinstance(max_triangles, bool) or not isinstance(max_triangles, int) or max_triangles < 4:
        raise ValueError(f"Triangle cap must be an integer >= 4; received {max_triangles!r}")
    if len(faces) <= max_triangles:
        return tuple(vertices), tuple(faces)

    low = 1
    high = MAX_CLUSTER_RESOLUTION
    best = cluster(vertices, faces, low)
    while low <= high:
        middle = (low + high) // 2
        candidate = cluster(vertices, faces, middle)
        if len(candidate[1]) <= max_triangles:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1
    if len(best[1]) > max_triangles:
        raise ValueError(
            f"Vertex clustering could not reach {max_triangles} triangles; "
            f"the coarsest grid still emits {len(best[1])}"
        )
    return best


def normalize_unit_radius(vertices):
    """Recentre on the bounding box and scale so the farthest vertex sits at 1.0."""
    minimum = [min(vertex[axis] for vertex in vertices) for axis in range(3)]
    maximum = [max(vertex[axis] for vertex in vertices) for axis in range(3)]
    centre = tuple((minimum[axis] + maximum[axis]) / 2.0 for axis in range(3))
    centred = tuple(
        tuple(vertex[axis] - centre[axis] for axis in range(3)) for vertex in vertices
    )
    radius = max(math.sqrt(sum(component * component for component in vertex)) for vertex in centred)
    if not math.isfinite(radius) or radius <= 0.0:
        raise ValueError("Shape model collapses to a point: no usable radius")
    return (
        tuple(tuple(component / radius for component in vertex) for vertex in centred),
        centre,
        radius,
    )


def file_sha256(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_shape_model(path, *, sha256, model_format, max_triangles):
    """Verify, parse, decimate and normalize a published shape model."""
    if model_format not in SUPPORTED_FORMATS:
        raise ValueError(
            f'Unsupported shape-model format "{model_format}"; supported: {", ".join(SUPPORTED_FORMATS)}'
        )
    path = pathlib.Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Shape model is not present: {path}")
    expected = str(sha256).lower()
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise ValueError("Shape model requires a pinned lowercase SHA-256")
    measured = file_sha256(path)
    if measured != expected:
        raise ValueError(f"Shape model SHA-256 mismatch: expected {expected}, measured {measured}")

    vertices, faces = parse_obj(path.read_text(encoding="utf-8", errors="strict"))
    vertices, faces = decimate(vertices, faces, max_triangles)
    normalized, _, _ = normalize_unit_radius(vertices)
    return normalized, faces
