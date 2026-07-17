import importlib.util
import json
import math
import pathlib
import struct
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "glb.py"


def load_module():
    spec = importlib.util.spec_from_file_location("blender_glb", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_glb(triangles):
    indices = tuple(index for triangle in triangles for index in triangle)
    binary = struct.pack(f"<{len(indices)}H", *indices)
    document = {
        "asset": {"version": "2.0"},
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5123,
                "count": len(indices),
                "type": "SCALAR",
            }
        ],
        "bufferViews": [{"buffer": 0, "byteLength": len(binary)}],
        "buffers": [{"byteLength": len(binary)}],
        "meshes": [{"primitives": [{"attributes": {}, "indices": 0}]}],
    }
    encoded_json = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (-len(encoded_json) % 4)
    binary += b"\0" * (-len(binary) % 4)
    length = 12 + 8 + len(encoded_json) + 8 + len(binary)
    return b"".join(
        (
            struct.pack("<4sII", b"glTF", 2, length),
            struct.pack("<I4s", len(encoded_json), b"JSON"),
            encoded_json,
            struct.pack("<I4s", len(binary), b"BIN\0"),
            binary,
        )
    )


def build_ellipsoid_glb(normals, polar_ratio):
    diagonal = math.sqrt(0.5)
    positions = (
        (1.0, 0.0, 0.0),
        (0.0, polar_ratio, 0.0),
        (diagonal, polar_ratio * diagonal, 0.0),
    )
    position_bytes = struct.pack("<9f", *(value for vector in positions for value in vector))
    normal_bytes = struct.pack("<9f", *(value for vector in normals for value in vector))
    binary = position_bytes + normal_bytes
    document = {
        "asset": {"version": "2.0"},
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteLength": len(position_bytes), "byteOffset": 0},
            {
                "buffer": 0,
                "byteLength": len(normal_bytes),
                "byteOffset": len(position_bytes),
            },
        ],
        "buffers": [{"byteLength": len(binary)}],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}}]}
        ],
    }
    encoded_json = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (-len(encoded_json) % 4)
    binary += b"\0" * (-len(binary) % 4)
    length = 12 + 8 + len(encoded_json) + 8 + len(binary)
    return b"".join(
        (
            struct.pack("<4sII", b"glTF", 2, length),
            struct.pack("<I4s", len(encoded_json), b"JSON"),
            encoded_json,
            struct.pack("<I4s", len(binary), b"BIN\0"),
            binary,
        )
    )


def build_texcoord_glb(texcoords):
    binary = struct.pack(
        f"<{len(texcoords) * 2}f",
        *(value for texcoord in texcoords for value in texcoord),
    )
    document = {
        "asset": {"version": "2.0"},
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": len(texcoords),
                "type": "VEC2",
            }
        ],
        "bufferViews": [{"buffer": 0, "byteLength": len(binary)}],
        "buffers": [{"byteLength": len(binary)}],
        "meshes": [{"primitives": [{"attributes": {"TEXCOORD_0": 0}}]}],
    }
    encoded_json = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (-len(encoded_json) % 4)
    binary += b"\0" * (-len(binary) % 4)
    length = 12 + 8 + len(encoded_json) + 8 + len(binary)
    return b"".join(
        (
            struct.pack("<4sII", b"glTF", 2, length),
            struct.pack("<I4s", len(encoded_json), b"JSON"),
            encoded_json,
            struct.pack("<I4s", len(binary), b"BIN\0"),
            binary,
        )
    )


class BlenderGlbTests(unittest.TestCase):
    def setUp(self):
        self.glb = load_module()

    def test_canonicalizes_equivalent_triangle_orders_to_identical_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = pathlib.Path(temporary) / "first.glb"
            second = pathlib.Path(temporary) / "second.glb"
            first.write_bytes(build_glb(((3, 4, 5), (0, 1, 2))))
            second.write_bytes(build_glb(((0, 1, 2), (3, 4, 5))))

            self.glb.canonicalize_triangle_indices(first)
            self.glb.canonicalize_triangle_indices(second)

            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_canonicalizes_ellipsoid_normals_from_float32_positions(self):
        ratio = 0.8
        with tempfile.TemporaryDirectory() as temporary:
            first = pathlib.Path(temporary) / "first.glb"
            second = pathlib.Path(temporary) / "second.glb"
            first.write_bytes(build_ellipsoid_glb(((1, 0, 0), (0, 1, 0), (0, 0, 1)), ratio))
            second.write_bytes(build_ellipsoid_glb(((0, 1, 0), (0, 0, 1), (1, 0, 0)), ratio))

            self.glb.canonicalize_ellipsoid_normals(first, ratio)
            self.glb.canonicalize_ellipsoid_normals(second, ratio)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            payload = first.read_bytes()
            json_length = struct.unpack_from("<I", payload, 12)[0]
            binary_offset = 20 + json_length + 8
            normal_offset = binary_offset + 9 * 4
            normals = struct.unpack_from("<9f", payload, normal_offset)
            self.assertEqual(normals[:6], (1.0, 0.0, 0.0, 0.0, 1.0, 0.0))
            expected_x = ratio / math.sqrt(1.0 + ratio * ratio)
            expected_y = 1.0 / math.sqrt(1.0 + ratio * ratio)
            self.assertAlmostEqual(normals[6], expected_x, 7)
            self.assertAlmostEqual(normals[7], expected_y, 7)
            self.assertEqual(normals[8], 0.0)

    def test_canonicalizes_sub_precision_texcoord_variation(self):
        lower = 0.006386101245880127
        upper = 0.006386160850524902
        with tempfile.TemporaryDirectory() as temporary:
            first = pathlib.Path(temporary) / "first.glb"
            second = pathlib.Path(temporary) / "second.glb"
            first.write_bytes(build_texcoord_glb(((lower, 0.25), (upper, 0.75))))
            second.write_bytes(build_texcoord_glb(((upper, 0.25), (lower, 0.75))))

            self.glb.canonicalize_triangle_indices(first)
            self.glb.canonicalize_triangle_indices(second)

            self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
