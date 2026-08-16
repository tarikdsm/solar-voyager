import importlib.util
import math
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "procedural_shape.py"


def load_module():
    spec = importlib.util.spec_from_file_location("blender_procedural_shape", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def directions(count=200):
    # Deterministic Fibonacci-spiral sampling of the sphere.
    golden = math.pi * (3.0 - math.sqrt(5.0))
    samples = []
    for index in range(count):
        z = 1.0 - 2.0 * (index + 0.5) / count
        radius = math.sqrt(max(0.0, 1.0 - z * z))
        angle = golden * index
        samples.append((radius * math.cos(angle), radius * math.sin(angle), z))
    return samples


class ProceduralShapeTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def shape(self, seed=433, **overrides):
        return self.module.ProceduralShape(seed=seed, **overrides)

    def test_same_seed_reproduces_the_identical_radius_field(self):
        first = [self.shape().radius(direction) for direction in directions()]
        second = [self.shape().radius(direction) for direction in directions()]
        self.assertEqual(first, second)

    def test_different_seeds_produce_different_radius_fields(self):
        first = [self.shape(seed=433).radius(direction) for direction in directions()]
        second = [self.shape(seed=101955).radius(direction) for direction in directions()]
        self.assertNotEqual(first, second)

    def test_radius_stays_positive_and_inside_the_declared_envelope(self):
        shape = self.shape(relief=0.22, crater_count=14, crater_depth=0.1)
        radii = [shape.radius(direction) for direction in directions(400)]
        self.assertTrue(all(value > 0.0 for value in radii))
        self.assertLessEqual(max(radii), 1.0 + 0.22 + 1e-12)
        self.assertGreaterEqual(min(radii), 1.0 - 0.22 - 0.1 - 1e-12)

    def test_relief_and_craters_actually_deform_the_sphere(self):
        smooth = self.shape(relief=0.0, crater_count=0)
        self.assertEqual({smooth.radius(direction) for direction in directions(50)}, {1.0})

        cratered = self.shape(relief=0.0, crater_count=24, crater_depth=0.12)
        radii = [cratered.radius(direction) for direction in directions(600)]
        self.assertLess(min(radii), 1.0)

        noisy = self.shape(relief=0.2, crater_count=0)
        spread = [noisy.radius(direction) for direction in directions(200)]
        self.assertGreater(max(spread) - min(spread), 0.01)

    def test_axis_ratios_scale_the_exported_point(self):
        shape = self.shape(relief=0.0, crater_count=0, axis_ratios=(1.0, 0.5, 0.25))
        x, y, z = shape.point((0.0, 1.0, 0.0))
        self.assertAlmostEqual(x, 0.0, 12)
        self.assertAlmostEqual(y, 0.5, 12)
        self.assertAlmostEqual(z, 0.0, 12)

    def test_shade_is_a_bounded_deterministic_function_of_direction(self):
        shape = self.shape()
        values = [shape.shade(direction) for direction in directions()]
        self.assertTrue(all(0.0 <= value <= 1.0 for value in values))
        self.assertEqual(values, [shape.shade(direction) for direction in directions()])
        self.assertGreater(max(values) - min(values), 0.05)

    def test_rejects_invalid_seed_and_shape_parameters(self):
        cases = (
            ({"seed": -1}, "seed"),
            ({"seed": True}, "seed"),
            ({"relief": -0.1}, "relief"),
            ({"relief": 0.95}, "relief"),
            ({"crater_count": -2}, "crater"),
            ({"crater_depth": -0.1}, "crater"),
            ({"axis_ratios": (1.0, 0.0, 1.0)}, "axis"),
            ({"axis_ratios": (1.0, 1.0)}, "axis"),
            ({"octaves": 0}, "octaves"),
        )
        for overrides, pattern in cases:
            with self.subTest(overrides=overrides):
                arguments = {"seed": 433}
                arguments.update(overrides)
                with self.assertRaisesRegex(ValueError, pattern):
                    self.module.ProceduralShape(**arguments)

    def test_rejects_a_zero_length_direction(self):
        with self.assertRaisesRegex(ValueError, "direction"):
            self.shape().radius((0.0, 0.0, 0.0))


class ShadeFieldTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.shape = self.module.ProceduralShape(seed=90000702)

    def test_equirectangular_direction_inverts_the_mesh_uv_convention(self):
        for u, v in ((0.0, 0.5), (0.25, 0.5), (0.5, 0.5), (0.75, 0.9), (0.13, 0.02)):
            with self.subTest(u=u, v=v):
                x, y, z = self.module.equirectangular_direction(u, v)
                self.assertAlmostEqual(math.sqrt(x * x + y * y + z * z), 1.0, 12)
                recovered_u = (0.5 + math.atan2(-y, x) / (2.0 * math.pi)) % 1.0
                recovered_v = 0.5 + math.asin(max(-1.0, min(1.0, z))) / math.pi
                self.assertAlmostEqual(min(abs(recovered_u - u), 1.0 - abs(recovered_u - u)), 0.0, 9)
                self.assertAlmostEqual(recovered_v, v, 9)

    def test_field_is_bounded_deterministic_and_correctly_sized(self):
        first = self.module.shade_field(self.shape, 64, 32)
        second = self.module.shade_field(self.shape, 64, 32)
        self.assertEqual(len(first), 64 * 32)
        self.assertEqual(first, second)
        self.assertTrue(all(0.0 <= value <= 1.0 for value in first))
        self.assertGreater(max(first) - min(first), 0.05)

    def test_field_is_row_major_and_matches_direct_evaluation(self):
        field = self.module.shade_field(self.shape, 8, 4)
        for row in range(4):
            for column in range(8):
                direction = self.module.equirectangular_direction(
                    (column + 0.5) / 8, (row + 0.5) / 4
                )
                self.assertEqual(field[row * 8 + column], self.shape.shade(direction))

    def test_field_wraps_across_the_longitude_seam(self):
        field = self.module.shade_field(self.shape, 512, 8)
        for row in range(8):
            first = field[row * 512]
            last = field[row * 512 + 511]
            neighbour = field[row * 512 + 1]
            self.assertLess(abs(first - last), 4.0 * abs(first - neighbour) + 1e-3)

    def test_rejects_invalid_dimensions(self):
        for width, height in ((0, 32), (64, 0), (64, True)):
            with self.subTest(width=width, height=height):
                with self.assertRaisesRegex(ValueError, "integer"):
                    self.module.shade_field(self.shape, width, height)


if __name__ == "__main__":
    unittest.main()
