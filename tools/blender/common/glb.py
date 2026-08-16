"""Deterministic post-processing for Blender-authored GLB files."""

import json
import math
import pathlib
import struct


_COMPONENT_FORMATS = {5121: "B", 5123: "H", 5125: "I"}
_TEXCOORD_DECIMALS = 6


def _read_chunks(payload):
    if len(payload) < 20 or payload[:4] != b"glTF" or struct.unpack_from("<I", payload, 4)[0] != 2:
        raise ValueError("Expected a glTF 2 binary file")
    chunks = []
    offset = 12
    while offset < len(payload):
        length, chunk_type = struct.unpack_from("<I4s", payload, offset)
        start = offset + 8
        chunks.append((chunk_type, bytearray(payload[start : start + length])))
        offset = start + length
    if offset != len(payload):
        raise ValueError("Malformed GLB chunk lengths")
    return chunks


def read_gltf_json(path):
    """Parsed JSON chunk of a GLB, for post-export contract assertions."""
    chunks = _read_chunks(pathlib.Path(path).read_bytes())
    json_chunks = [data for chunk_type, data in chunks if chunk_type == b"JSON"]
    if len(json_chunks) != 1:
        raise ValueError("Expected exactly one JSON chunk")
    return json.loads(json_chunks[0].decode("utf-8"))


def _canonicalize_primitive_indices(document, binary, primitive):
    if primitive.get("mode", 4) != 4 or "indices" not in primitive:
        return
    accessor = document["accessors"][primitive["indices"]]
    if accessor.get("type") != "SCALAR" or accessor["count"] % 3 != 0:
        raise ValueError("Triangle index accessor must be a SCALAR multiple of three")
    component_type = accessor["componentType"]
    if component_type not in _COMPONENT_FORMATS:
        raise ValueError(f"Unsupported triangle index component type: {component_type}")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("byteStride") is not None:
        raise ValueError("Strided triangle index buffers are unsupported")
    format_code = _COMPONENT_FORMATS[component_type]
    component_size = struct.calcsize(format_code)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    indices = struct.unpack_from(f'<{accessor["count"]}{format_code}', binary, offset)
    triangles = sorted(zip(indices[0::3], indices[1::3], indices[2::3]))
    flattened = (index for triangle in triangles for index in triangle)
    struct.pack_into(
        f'<{accessor["count"]}{format_code}', binary, offset, *flattened
    )
    expected_bytes = accessor["count"] * component_size
    if offset + expected_bytes > len(binary):
        raise ValueError("Triangle index accessor exceeds the GLB binary chunk")


def _canonicalize_primitive_texcoords(document, binary, primitive):
    for semantic, accessor_index in primitive.get("attributes", {}).items():
        if not semantic.startswith("TEXCOORD_"):
            continue
        accessor = document["accessors"][accessor_index]
        if (
            accessor.get("componentType") != 5126
            or accessor.get("type") != "VEC2"
            or accessor.get("sparse") is not None
        ):
            raise ValueError("Texcoord canonicalization requires non-sparse float32 VEC2 accessors")
        view = document["bufferViews"][accessor["bufferView"]]
        if view.get("buffer", 0) != 0:
            raise ValueError("Texcoord canonicalization requires the GLB binary buffer")
        stride = view.get("byteStride", 8)
        if stride < 8:
            raise ValueError("Texcoord VEC2 byte stride must be at least 8")
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        final_byte = offset + (accessor["count"] - 1) * stride + 8
        if accessor["count"] < 1 or final_byte > len(binary):
            raise ValueError("Texcoord accessor exceeds the GLB binary chunk")
        for index in range(accessor["count"]):
            element_offset = offset + index * stride
            u, v = struct.unpack_from("<2f", binary, element_offset)
            if not math.isfinite(u) or not math.isfinite(v):
                raise ValueError("Texcoord values must be finite")
            struct.pack_into(
                "<2f",
                binary,
                element_offset,
                round(u, _TEXCOORD_DECIMALS),
                round(v, _TEXCOORD_DECIMALS),
            )


def canonicalize_triangle_indices(path):
    path = pathlib.Path(path)
    chunks = _read_chunks(path.read_bytes())
    json_chunks = [data for chunk_type, data in chunks if chunk_type == b"JSON"]
    binary_chunks = [data for chunk_type, data in chunks if chunk_type == b"BIN\0"]
    if len(json_chunks) != 1 or len(binary_chunks) != 1:
        raise ValueError("Expected exactly one JSON and one BIN chunk")
    document = json.loads(json_chunks[0].decode("utf-8"))
    binary = binary_chunks[0]
    for mesh in document.get("meshes", ()):
        for primitive in mesh.get("primitives", ()):
            _canonicalize_primitive_indices(document, binary, primitive)
            _canonicalize_primitive_texcoords(document, binary, primitive)

    output = bytearray(struct.pack("<4sII", b"glTF", 2, 0))
    for chunk_type, data in chunks:
        if chunk_type == b"BIN\0":
            data = binary
        output.extend(struct.pack("<I4s", len(data), chunk_type))
        output.extend(data)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    return path


def _triangle_indices(document, binary, primitive):
    accessor = document["accessors"][primitive["indices"]]
    if accessor.get("type") != "SCALAR" or accessor["count"] % 3 != 0:
        raise ValueError("Triangle index accessor must be a SCALAR multiple of three")
    component_type = accessor["componentType"]
    if component_type not in _COMPONENT_FORMATS:
        raise ValueError(f"Unsupported triangle index component type: {component_type}")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("byteStride") is not None:
        raise ValueError("Strided triangle index buffers are unsupported")
    format_code = _COMPONENT_FORMATS[component_type]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return struct.unpack_from(f'<{accessor["count"]}{format_code}', binary, offset)


def _canonicalize_primitive_normals(document, binary, primitive):
    attributes = primitive.get("attributes", {})
    if primitive.get("mode", 4) != 4 or "indices" not in primitive:
        raise ValueError("Mesh normal canonicalization requires indexed triangle primitives")
    if "POSITION" not in attributes or "NORMAL" not in attributes:
        raise ValueError("Mesh normal canonicalization requires POSITION and NORMAL attributes")
    count, position_offset, position_stride = _float3_accessor(
        document, binary, attributes["POSITION"]
    )
    normal_count, normal_offset, normal_stride = _float3_accessor(
        document, binary, attributes["NORMAL"]
    )
    if count != normal_count:
        raise ValueError("Mesh POSITION and NORMAL counts differ")

    positions = []
    weld_keys = []
    accumulators = {}
    for index in range(count):
        element = position_offset + index * position_stride
        key = bytes(binary[element : element + 12])
        positions.append(struct.unpack("<3f", key))
        weld_keys.append(key)
        accumulators.setdefault(key, [0.0, 0.0, 0.0])

    indices = _triangle_indices(document, binary, primitive)
    for offset in range(0, len(indices), 3):
        first, second, third = (positions[indices[offset + corner]] for corner in range(3))
        edge_one = (second[0] - first[0], second[1] - first[1], second[2] - first[2])
        edge_two = (third[0] - first[0], third[1] - first[1], third[2] - first[2])
        # Un-normalized cross product: magnitude is twice the triangle area, so
        # summing it is the standard area-weighted smooth normal.
        face = (
            edge_one[1] * edge_two[2] - edge_one[2] * edge_two[1],
            edge_one[2] * edge_two[0] - edge_one[0] * edge_two[2],
            edge_one[0] * edge_two[1] - edge_one[1] * edge_two[0],
        )
        for corner in range(3):
            accumulator = accumulators[weld_keys[indices[offset + corner]]]
            accumulator[0] += face[0]
            accumulator[1] += face[1]
            accumulator[2] += face[2]

    for index in range(count):
        accumulator = accumulators[weld_keys[index]]
        length = math.sqrt(
            accumulator[0] ** 2 + accumulator[1] ** 2 + accumulator[2] ** 2
        )
        if length == 0.0:
            # No non-degenerate incident triangle: the body is star-shaped about
            # its normalized origin, so the radial direction is the correct limit.
            vector = positions[index]
            length = math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
            if length == 0.0:
                raise ValueError("Mesh vertex has neither an incident face nor a radial direction")
        else:
            vector = accumulator
        struct.pack_into(
            "<3f",
            binary,
            normal_offset + index * normal_stride,
            vector[0] / length,
            vector[1] / length,
            vector[2] / length,
        )


def canonicalize_mesh_normals(path):
    """Recompute every float32 normal from the exported positions and indices.

    Blender 5.1's smooth-normal calculation is process-dependent, so authored
    GLBs cannot be byte-compared until the normals are re-derived from data that
    is already in the file. `canonicalize_ellipsoid_normals` does this
    analytically for spheroids; this is the same pass for shapes that have no
    closed form. Run it *after* `canonicalize_triangle_indices` so the
    accumulation order is the canonical triangle order.

    Vertices are welded by exact float32 position bits, which reunites the
    duplicates the exporter creates at UV seams. Welding is per primitive, so a
    multi-material mesh keeps a hard edge at its material boundary.
    """
    path = pathlib.Path(path)
    chunks = _read_chunks(path.read_bytes())
    json_chunks = [data for chunk_type, data in chunks if chunk_type == b"JSON"]
    binary_chunks = [data for chunk_type, data in chunks if chunk_type == b"BIN\0"]
    if len(json_chunks) != 1 or len(binary_chunks) != 1:
        raise ValueError("Expected exactly one JSON and one BIN chunk")
    document = json.loads(json_chunks[0].decode("utf-8"))
    binary = binary_chunks[0]

    for mesh in document.get("meshes", ()):
        for primitive in mesh.get("primitives", ()):
            _canonicalize_primitive_normals(document, binary, primitive)

    output = bytearray(struct.pack("<4sII", b"glTF", 2, 0))
    for chunk_type, data in chunks:
        if chunk_type == b"BIN\0":
            data = binary
        output.extend(struct.pack("<I4s", len(data), chunk_type))
        output.extend(data)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    return path


def _float3_accessor(document, binary, accessor_index):
    accessor = document["accessors"][accessor_index]
    if (
        accessor.get("componentType") != 5126
        or accessor.get("type") != "VEC3"
        or accessor.get("sparse") is not None
    ):
        raise ValueError("Ellipsoid canonicalization requires non-sparse float32 VEC3 accessors")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("Ellipsoid canonicalization requires the GLB binary buffer")
    stride = view.get("byteStride", 12)
    if stride < 12:
        raise ValueError("Ellipsoid VEC3 byte stride must be at least 12")
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    final_byte = offset + (accessor["count"] - 1) * stride + 12
    if accessor["count"] < 1 or final_byte > len(binary):
        raise ValueError("Ellipsoid accessor exceeds the GLB binary chunk")
    return accessor["count"], offset, stride


def canonicalize_ellipsoid_normals(path, polar_radius_ratio):
    """Derive deterministic glTF +Y-polar normals from float32 positions."""
    ratio = float(polar_radius_ratio)
    if not math.isfinite(ratio) or not 0.0 < ratio <= 1.0:
        raise ValueError("polar_radius_ratio must be finite and in (0, 1]")

    path = pathlib.Path(path)
    chunks = _read_chunks(path.read_bytes())
    json_chunks = [data for chunk_type, data in chunks if chunk_type == b"JSON"]
    binary_chunks = [data for chunk_type, data in chunks if chunk_type == b"BIN\0"]
    if len(json_chunks) != 1 or len(binary_chunks) != 1:
        raise ValueError("Expected exactly one JSON and one BIN chunk")
    document = json.loads(json_chunks[0].decode("utf-8"))
    binary = binary_chunks[0]
    inverse_polar_squared = 1.0 / (ratio * ratio)

    for mesh in document.get("meshes", ()):
        for primitive in mesh.get("primitives", ()):
            attributes = primitive.get("attributes", {})
            if "POSITION" not in attributes or "NORMAL" not in attributes:
                raise ValueError("Ellipsoid primitive requires POSITION and NORMAL attributes")
            position = _float3_accessor(document, binary, attributes["POSITION"])
            normal = _float3_accessor(document, binary, attributes["NORMAL"])
            if position[0] != normal[0]:
                raise ValueError("Ellipsoid POSITION and NORMAL counts differ")
            for index in range(position[0]):
                position_offset = position[1] + index * position[2]
                normal_offset = normal[1] + index * normal[2]
                x, y, z = struct.unpack_from("<3f", binary, position_offset)
                ny = y * inverse_polar_squared
                length = math.sqrt(x * x + ny * ny + z * z)
                if length == 0.0:
                    raise ValueError("Ellipsoid position cannot be the origin")
                struct.pack_into("<3f", binary, normal_offset, x / length, ny / length, z / length)

    output = bytearray(struct.pack("<4sII", b"glTF", 2, 0))
    for chunk_type, data in chunks:
        if chunk_type == b"BIN\0":
            data = binary
        output.extend(struct.pack("<I4s", len(data), chunk_type))
        output.extend(data)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    return path
