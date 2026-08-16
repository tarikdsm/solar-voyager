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


def build_mesh_glb(positions, normals, triangles):
    position_bytes = struct.pack(
        f"<{len(positions) * 3}f", *(value for vector in positions for value in vector)
    )
    normal_bytes = struct.pack(
        f"<{len(normals) * 3}f", *(value for vector in normals for value in vector)
    )
    index_values = tuple(index for triangle in triangles for index in triangle)
    index_bytes = struct.pack(f"<{len(index_values)}H", *index_values)
    binary = position_bytes + normal_bytes + index_bytes
    document = {
        "asset": {"version": "2.0"},
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3"},
            {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(index_values), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteLength": len(position_bytes), "byteOffset": 0},
            {"buffer": 0, "byteLength": len(normal_bytes), "byteOffset": len(position_bytes)},
            {
                "buffer": 0,
                "byteLength": len(index_bytes),
                "byteOffset": len(position_bytes) + len(normal_bytes),
            },
        ],
        "buffers": [{"byteLength": len(binary)}],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2}]}
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


def read_normals(payload, count, position_count):
    json_length = struct.unpack_from("<I", payload, 12)[0]
    binary_offset = 20 + json_length + 8
    offset = binary_offset + position_count * 12
    values = struct.unpack_from(f"<{count * 3}f", payload, offset)
    return [tuple(values[index * 3 : index * 3 + 3]) for index in range(count)]


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


class MeshNormalCanonicalizationTests(unittest.TestCase):
    def setUp(self):
        self.glb = load_module()
        # Regular octahedron: every vertex normal equals its normalized position.
        self.positions = (
            (1.0, 0.0, 0.0),
            (-1.0, 0.0, 0.0),
            (0.0, 1.0, 0.0),
            (0.0, -1.0, 0.0),
            (0.0, 0.0, 1.0),
            (0.0, 0.0, -1.0),
        )
        self.triangles = (
            (0, 2, 4),
            (2, 1, 4),
            (1, 3, 4),
            (3, 0, 4),
            (2, 0, 5),
            (1, 2, 5),
            (3, 1, 5),
            (0, 3, 5),
        )

    def canonicalize(self, payload, name="mesh.glb"):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / name
            path.write_bytes(payload)
            self.glb.canonicalize_triangle_indices(path)
            self.glb.canonicalize_mesh_normals(path)
            return path.read_bytes()

    def test_derives_area_weighted_normals_from_exported_positions(self):
        garbage = tuple((0.0, 0.0, 1.0) for _ in self.positions)
        payload = self.canonicalize(build_mesh_glb(self.positions, garbage, self.triangles))
        normals = read_normals(payload, len(self.positions), len(self.positions))
        for expected, measured in zip(self.positions, normals):
            for axis in range(3):
                self.assertAlmostEqual(measured[axis], expected[axis], 6)

    def test_identical_meshes_in_different_triangle_orders_produce_identical_bytes(self):
        garbage = tuple((0.0, 0.0, 1.0) for _ in self.positions)
        forward = self.canonicalize(build_mesh_glb(self.positions, garbage, self.triangles))
        reversed_order = self.canonicalize(
            build_mesh_glb(self.positions, garbage, tuple(reversed(self.triangles)))
        )
        self.assertEqual(forward, reversed_order)

    def test_seam_split_duplicates_share_one_welded_normal(self):
        # Vertex 4 duplicated as vertex 6 the way a UV seam splits it.
        positions = self.positions + ((0.0, 0.0, 1.0),)
        triangles = ((0, 2, 4), (2, 1, 4), (1, 3, 6), (3, 0, 6))
        garbage = tuple((1.0, 0.0, 0.0) for _ in positions)
        payload = self.canonicalize(build_mesh_glb(positions, garbage, triangles))
        normals = read_normals(payload, len(positions), len(positions))
        self.assertEqual(normals[4], normals[6])
        self.assertAlmostEqual(normals[4][2], 1.0, 6)

    def test_falls_back_to_the_radial_normal_for_an_unreferenced_vertex(self):
        positions = self.positions + ((0.6, 0.0, 0.8),)
        garbage = tuple((0.0, 1.0, 0.0) for _ in positions)
        payload = self.canonicalize(build_mesh_glb(positions, garbage, self.triangles))
        normals = read_normals(payload, len(positions), len(positions))
        self.assertAlmostEqual(normals[6][0], 0.6, 6)
        self.assertAlmostEqual(normals[6][1], 0.0, 6)
        self.assertAlmostEqual(normals[6][2], 0.8, 6)


if __name__ == "__main__":
    unittest.main()
