import importlib.util
import json
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


if __name__ == "__main__":
    unittest.main()
