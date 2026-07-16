import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "blender" / "planet_config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("planet_config", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PlanetConfigTests(unittest.TestCase):
    def setUp(self):
        self.root_context = tempfile.TemporaryDirectory()
        self.root = Path(self.root_context.name)
        self.models_root = self.root / "models"
        self.textures_root = self.root / "textures"
        self.catalog_path = self.root / "bodies.json"
        self.catalog_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "bodies": [
                        {
                            "id": "sun",
                            "name": "Sun",
                            "kind": "star",
                            "visual": {"polarRadiusRatio": 1.0, "proceduralSeed": 10},
                        },
                        {
                            "id": "earth",
                            "name": "Earth",
                            "kind": "planet",
                            "visual": {
                                "polarRadiusRatio": 6356.8 / 6378.1,
                                "proceduralSeed": 399,
                            },
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.root_context.cleanup()

    def write_earth_sources(self):
        earth = self.textures_root / "earth"
        earth.mkdir(parents=True)
        for filename in (
            "earth_albedo.png",
            "8k_earth_normal_map.tif",
            "8k_earth_nightmap.jpg",
            "8k_earth_clouds.jpg",
        ):
            (earth / filename).write_bytes(filename.encode("ascii"))

    def test_resolves_earth_contract_from_catalog_and_stable_roots(self):
        self.write_earth_sources()
        module = load_module()

        config = module.planet_config(
            "earth", self.catalog_path, self.models_root, self.textures_root
        )

        self.assertEqual(config.body_id, "earth")
        self.assertEqual(config.name, "Earth")
        self.assertEqual(config.category, "planets")
        self.assertEqual(config.output_dir, self.models_root / "planets" / "earth")
        self.assertEqual(config.procedural_seed, 399)
        self.assertAlmostEqual(config.polar_radius_ratio, 6356.8 / 6378.1, 15)
        self.assertEqual(
            [texture.role for texture in config.textures],
            ["albedo", "normal", "emissive", "clouds"],
        )
        self.assertEqual(
            [texture.output_name for texture in config.textures],
            [
                "earth_albedo.png",
                "earth_normal.png",
                "earth_emissive_night.jpg",
                "earth_clouds.jpg",
            ],
        )

    def test_rejects_unknown_and_non_planet_body_ids(self):
        self.write_earth_sources()
        module = load_module()

        with self.assertRaisesRegex(ValueError, 'body id "missing"'):
            module.planet_config(
                "missing", self.catalog_path, self.models_root, self.textures_root
            )
        with self.assertRaisesRegex(ValueError, 'Body "sun" is not a planet'):
            module.planet_config(
                "sun", self.catalog_path, self.models_root, self.textures_root
            )

    def test_lists_every_missing_earth_role_file(self):
        module = load_module()

        with self.assertRaises(FileNotFoundError) as raised:
            module.planet_config(
                "earth", self.catalog_path, self.models_root, self.textures_root
            )

        message = str(raised.exception)
        for filename in (
            "earth_albedo.png",
            "8k_earth_normal_map.tif",
            "8k_earth_nightmap.jpg",
            "8k_earth_clouds.jpg",
        ):
            self.assertIn(filename, message)

    def test_rejects_out_of_contract_polar_ratio(self):
        self.write_earth_sources()
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        catalog["bodies"][1]["visual"]["polarRadiusRatio"] = 0
        self.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        module = load_module()

        with self.assertRaisesRegex(ValueError, "polarRadiusRatio"):
            module.planet_config(
                "earth", self.catalog_path, self.models_root, self.textures_root
            )


if __name__ == "__main__":
    unittest.main()
