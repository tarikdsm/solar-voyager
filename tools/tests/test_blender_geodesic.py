import importlib.util
import math
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "geodesic.py"


def load_module():
    spec = importlib.util.spec_from_file_location("blender_geodesic", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GeodesicSphereTests(unittest.TestCase):
    def setUp(self):
        self.geodesic = load_module()

    def test_frequency_defines_the_exact_triangle_and_vertex_count(self):
        for frequency in (1, 2, 3, 15):
            with self.subTest(frequency=frequency):
                vertices, faces = self.geodesic.geodesic_sphere(frequency)
                self.assertEqual(len(faces), 20 * frequency * frequency)
                self.assertEqual(len(vertices), 10 * frequency * frequency + 2)

    def test_default_frequency_fits_the_small_body_budget(self):
        self.assertEqual(20 * self.geodesic.DEFAULT_FREQUENCY**2, 4_500)
        self.assertLessEqual(20 * self.geodesic.DEFAULT_FREQUENCY**2, 5_000)

    def test_every_vertex_lies_on_the_unit_sphere(self):
        vertices, _ = self.geodesic.geodesic_sphere(4)
        for x, y, z in vertices:
            self.assertAlmostEqual(math.sqrt(x * x + y * y + z * z), 1.0, 12)

    def test_shared_lattice_points_are_welded_into_a_closed_manifold(self):
        _, faces = self.geodesic.geodesic_sphere(5)
        edges = {}
        for a, b, c in faces:
            for start, end in ((a, b), (b, c), (c, a)):
                key = (min(start, end), max(start, end))
                edges[key] = edges.get(key, 0) + 1
        self.assertEqual(len(faces), 500)
        self.assertTrue(all(count == 2 for count in edges.values()))
        self.assertEqual(len(edges), 750)

    def test_faces_wind_outward(self):
        vertices, faces = self.geodesic.geodesic_sphere(3)
        for a, b, c in faces:
            first = vertices[a]
            second = vertices[b]
            third = vertices[c]
            edge_one = [second[axis] - first[axis] for axis in range(3)]
            edge_two = [third[axis] - first[axis] for axis in range(3)]
            normal = (
                edge_one[1] * edge_two[2] - edge_one[2] * edge_two[1],
                edge_one[2] * edge_two[0] - edge_one[0] * edge_two[2],
                edge_one[0] * edge_two[1] - edge_one[1] * edge_two[0],
            )
            centroid = [(first[axis] + second[axis] + third[axis]) / 3.0 for axis in range(3)]
            self.assertGreater(sum(normal[axis] * centroid[axis] for axis in range(3)), 0.0)

    def test_generation_is_bit_stable_across_calls(self):
        first = self.geodesic.geodesic_sphere(6)
        second = self.geodesic.geodesic_sphere(6)
        self.assertEqual(first, second)

    def test_rejects_invalid_frequency(self):
        for frequency in (0, -3, 2.5):
            with self.subTest(frequency=frequency):
                with self.assertRaisesRegex(ValueError, "frequency"):
                    self.geodesic.geodesic_sphere(frequency)


if __name__ == "__main__":
    unittest.main()
