import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "common" / "catalog.py"


def load_module():
    spec = importlib.util.spec_from_file_location("blender_catalog", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BlenderCatalogTests(unittest.TestCase):
    def setUp(self):
        self.catalog = load_module()

    def test_derives_asset_directories_from_catalog_kinds(self):
        expected = {
            "star": "sun",
            "planet": "planets",
            "moon": "moons",
            "dwarf": "dwarfs",
            "asteroid": "asteroids",
            "comet": "comets",
        }
        for kind, category in expected.items():
            with self.subTest(kind=kind):
                self.assertEqual(self.catalog.asset_category({"id": "test", "kind": kind}), category)

    def test_rejects_unsupported_kind(self):
        with self.assertRaisesRegex(ValueError, "unsupported kind"):
            self.catalog.asset_category({"id": "test", "kind": "spaceship"})


if __name__ == "__main__":
    unittest.main()
