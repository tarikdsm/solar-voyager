import hashlib
import importlib.util
import math
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "shape_model.py"
GEODESIC_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "geodesic.py"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_obj(path, vertices, faces):
    lines = ["# synthetic shape model"]
    lines.extend(f"v {x!r} {y!r} {z!r}" for x, y, z in vertices)
    lines.extend(f"f {a + 1} {b + 1} {c + 1}" for a, b, c in faces)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class ObjParsingTests(unittest.TestCase):
    def setUp(self):
        self.module = load(MODULE_PATH, "blender_shape_model")

    def test_parses_vertices_faces_and_ignores_auxiliary_records(self):
        source = "\n".join(
            (
                "# Eros-like fragment",
                "mtllib ignored.mtl",
                "v 0 0 0",
                "vn 0 0 1",
                "vt 0.5 0.5",
                "v 1 0 0",
                "v 0 1 0",
                "v 0 0 1",
                "f 1/1/1 2/1/1 3/1/1",
                "f 1//1 2//1 4//1",
                "",
            )
        )
        vertices, faces = self.module.parse_obj(source)
        self.assertEqual(vertices, ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
        self.assertEqual(faces, ((0, 1, 2), (0, 1, 3)))

    def test_triangulates_polygons_with_a_fan_and_resolves_negative_indices(self):
        source = "\n".join(
            ("v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1 2 3 4", "f -4 -3 -2")
        )
        _, faces = self.module.parse_obj(source)
        self.assertEqual(faces, ((0, 1, 2), (0, 2, 3), (0, 1, 2)))

    def test_rejects_degenerate_records(self):
        cases = (
            ("v 0 0\nf 1 1 1", "vertex"),
            ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2", "face"),
            ("v 0 0 0\nf 1 2 3", "index"),
            ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0", "index"),
            ("v nan 0 0", "finite"),
            ("# nothing at all", "empty"),
        )
        for source, pattern in cases:
            with self.subTest(source=source):
                with self.assertRaisesRegex(ValueError, pattern):
                    self.module.parse_obj(source)


class DecimationTests(unittest.TestCase):
    def setUp(self):
        self.module = load(MODULE_PATH, "blender_shape_model")
        self.geodesic = load(GEODESIC_PATH, "blender_geodesic")

    def test_meshes_already_inside_the_cap_are_returned_untouched(self):
        vertices, faces = self.geodesic.geodesic_sphere(4)
        result = self.module.decimate(vertices, faces, 5_000)
        self.assertEqual(result, (vertices, faces))

    def test_decimation_enforces_the_triangle_cap(self):
        vertices, faces = self.geodesic.geodesic_sphere(24)
        self.assertEqual(len(faces), 11_520)
        _, decimated = self.module.decimate(vertices, faces, 5_000)
        self.assertLessEqual(len(decimated), 5_000)
        self.assertGreater(len(decimated), 1_000)

    def test_decimation_is_independent_of_input_ordering(self):
        vertices, faces = self.geodesic.geodesic_sphere(16)
        shuffled_faces = tuple(sorted(faces, key=lambda face: (face[2], face[1], face[0])))
        first = self.module.decimate(vertices, faces, 2_000)
        second = self.module.decimate(vertices, shuffled_faces, 2_000)
        self.assertEqual(first, second)

    def test_decimation_preserves_the_gross_shape(self):
        vertices, faces = self.geodesic.geodesic_sphere(20)
        decimated_vertices, _ = self.module.decimate(vertices, faces, 3_000)
        radii = [math.sqrt(x * x + y * y + z * z) for x, y, z in decimated_vertices]
        self.assertGreater(min(radii), 0.9)
        self.assertLess(max(radii), 1.05)

    def test_rejects_an_impossible_cap(self):
        vertices, faces = self.geodesic.geodesic_sphere(4)
        with self.assertRaisesRegex(ValueError, "cap"):
            self.module.decimate(vertices, faces, 0)


class NormalizationTests(unittest.TestCase):
    def setUp(self):
        self.module = load(MODULE_PATH, "blender_shape_model")

    def test_recenters_on_the_bounding_box_and_scales_to_unit_radius(self):
        vertices = ((10.0, 4.0, 0.0), (14.0, 4.0, 0.0), (12.0, 8.0, 0.0), (12.0, 4.0, 6.0))
        normalized, centre, scale = self.module.normalize_unit_radius(vertices)
        box_centre = [
            (min(v[axis] for v in normalized) + max(v[axis] for v in normalized)) / 2.0
            for axis in range(3)
        ]
        self.assertTrue(all(abs(value) < 1e-12 for value in box_centre))
        self.assertAlmostEqual(max(math.sqrt(x * x + y * y + z * z) for x, y, z in normalized), 1.0, 12)
        self.assertEqual(centre, (12.0, 6.0, 3.0))
        self.assertGreater(scale, 0.0)

    def test_rejects_a_degenerate_point_cloud(self):
        with self.assertRaisesRegex(ValueError, "radius"):
            self.module.normalize_unit_radius(((1.0, 1.0, 1.0), (1.0, 1.0, 1.0)))


class ShapeModelLoadingTests(unittest.TestCase):
    def setUp(self):
        self.module = load(MODULE_PATH, "blender_shape_model")
        self.geodesic = load(GEODESIC_PATH, "blender_geodesic")
        self.context = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.context.name)
        vertices, faces = self.geodesic.geodesic_sphere(12)
        self.path = write_obj(self.root / "eros_shape.obj", vertices, faces)
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def tearDown(self):
        self.context.cleanup()

    def test_loads_verifies_decimates_and_normalizes(self):
        vertices, faces = self.module.load_shape_model(
            self.path, sha256=self.digest, model_format="obj", max_triangles=1_500
        )
        self.assertLessEqual(len(faces), 1_500)
        self.assertAlmostEqual(max(math.sqrt(sum(c * c for c in v)) for v in vertices), 1.0, 12)

    def test_rejects_a_checksum_mismatch(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.module.load_shape_model(
                self.path, sha256="0" * 64, model_format="obj", max_triangles=5_000
            )

    def test_rejects_an_unsupported_format_and_a_missing_file(self):
        with self.assertRaisesRegex(ValueError, "format"):
            self.module.load_shape_model(
                self.path, sha256=self.digest, model_format="icq", max_triangles=5_000
            )
        with self.assertRaises(FileNotFoundError):
            self.module.load_shape_model(
                self.root / "absent.obj", sha256=self.digest, model_format="obj", max_triangles=5_000
            )


if __name__ == "__main__":
    unittest.main()
