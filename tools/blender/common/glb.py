"""Deterministic post-processing for Blender-authored GLB files."""

import json
import pathlib
import struct


_COMPONENT_FORMATS = {5121: "B", 5123: "H", 5125: "I"}


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

    output = bytearray(struct.pack("<4sII", b"glTF", 2, 0))
    for chunk_type, data in chunks:
        if chunk_type == b"BIN\0":
            data = binary
        output.extend(struct.pack("<I4s", len(data), chunk_type))
        output.extend(data)
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    return path
