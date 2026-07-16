import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "blender" / "moon_config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("moon_config", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MoonConfigTests(unittest.TestCase):
    def setUp(self):
        self.context = tempfile.TemporaryDirectory()
        self.root = Path(self.context.name)
        self.catalog = self.root / "bodies.json"
        self.catalog.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "bodies": [
                        {
                            "id": "moon",
                            "name": "Moon",
                            "kind": "moon",
                            "meanRadiusKm": 1737.4,
                            "visual": {"polarRadiusRatio": 1.0, "proceduralSeed": 301},
                        },
                        {
                            "id": "earth",
                            "name": "Earth",
                            "kind": "planet",
                            "meanRadiusKm": 6371.0,
                            "visual": {"polarRadiusRatio": 1.0, "proceduralSeed": 399},
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.textures = self.root / "textures" / "moon"
        self.textures.mkdir(parents=True)
        for name in (
            "moon_albedo.jpg",
            "moon_height.png",
            "moon_normal.png",
            "moon_detail_albedo.jpg",
            "moon_detail_normal.png",
        ):
            (self.textures / name).write_bytes(name.encode("ascii"))

    def tearDown(self):
        self.context.cleanup()

    def test_resolves_catalog_driven_moon_contract(self):
        module = load_module()
        config = module.moon_config(
            "moon", self.catalog, self.root / "models", self.root / "textures"
        )

        self.assertEqual(config.category, "moons")
        self.assertEqual(config.mean_radius_km, 1737.4)
        self.assertEqual(config.relief_range_km, 20.0)
        self.assertEqual(config.procedural_seed, 301)
        self.assertEqual(
            [texture.role for texture in config.textures],
            ["albedo", "height", "normal", "detail_albedo", "detail_normal"],
        )

    def test_rejects_non_moon_and_lists_missing_files(self):
        module = load_module()
        with self.assertRaisesRegex(ValueError, 'Body "earth" is not a moon'):
            module.moon_config(
                "earth", self.catalog, self.root / "models", self.root / "textures"
            )
        (self.textures / "moon_normal.png").unlink()
        with self.assertRaisesRegex(FileNotFoundError, "moon_normal.png"):
            module.moon_config(
                "moon", self.catalog, self.root / "models", self.root / "textures"
            )

    def test_relief_is_inward_and_peaks_at_normalized_radius_one(self):
        module = load_module()
        self.assertEqual(module.normalized_relief_radius(1.0, 1737.4, 20.0), 1.0)
        self.assertAlmostEqual(
            module.normalized_relief_radius(0.0, 1737.4, 20.0),
            1.0 - 20.0 / 1737.4,
            15,
        )
        with self.assertRaisesRegex(ValueError, "height sample"):
            module.normalized_relief_radius(1.01, 1737.4, 20.0)


if __name__ == "__main__":
    unittest.main()
