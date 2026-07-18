import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "blender" / "pluto_config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("pluto_config", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PlutoConfigTests(unittest.TestCase):
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
                            "id": "pluto",
                            "name": "Pluto",
                            "kind": "dwarf",
                            "meanRadiusKm": 1188.3,
                            "visual": {
                                "polarRadiusRatio": 1.0,
                                "proceduralSeed": 999,
                            },
                        },
                        {
                            "id": "earth",
                            "name": "Earth",
                            "kind": "planet",
                            "meanRadiusKm": 6371.0,
                            "visual": {
                                "polarRadiusRatio": 0.996647,
                                "proceduralSeed": 399,
                            },
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.textures = self.root / "textures" / "pluto"
        self.textures.mkdir(parents=True)
        for name in ("2k_pluto.jpg", "4k_pluto.jpg"):
            (self.textures / name).write_bytes(name.encode("ascii"))
        self.sources = self.root / "source-model" / "dwarfs" / "pluto"
        self.sources.mkdir(parents=True)
        for name in (
            "pluto_detail_albedo.jpg",
            "pluto_detail_normal.png",
            "SOURCES.md",
        ):
            (self.sources / name).write_bytes(name.encode("ascii"))

    def tearDown(self):
        self.context.cleanup()

    def test_resolves_catalog_driven_pluto_contract(self):
        module = load_module()
        config = module.pluto_config(
            "pluto",
            self.catalog,
            self.root / "models",
            self.root / "textures",
            self.root / "source-model",
        )

        self.assertEqual(config.category, "dwarfs")
        self.assertEqual(config.output_dir, (self.root / "models" / "dwarfs" / "pluto").resolve())
        self.assertEqual(config.mean_radius_km, 1188.3)
        self.assertEqual(config.polar_radius_ratio, 1.0)
        self.assertEqual(config.procedural_seed, 999)
        self.assertEqual(config.preview_albedo_path.name, "4k_pluto.jpg")
        self.assertEqual(
            [(item.role, item.output_name) for item in config.publish_files],
            [
                ("albedo", "pluto_albedo.jpg"),
                ("detail_albedo", "pluto_detail_albedo.jpg"),
                ("detail_normal", "pluto_detail_normal.png"),
                ("provenance", "SOURCES.md"),
            ],
        )

    def test_falls_back_to_2k_preview_and_lists_missing_files(self):
        module = load_module()
        (self.textures / "4k_pluto.jpg").unlink()
        config = module.pluto_config(
            "pluto",
            self.catalog,
            self.root / "models",
            self.root / "textures",
            self.root / "source-model",
        )
        self.assertEqual(config.preview_albedo_path.name, "2k_pluto.jpg")

        (self.sources / "pluto_detail_normal.png").unlink()
        with self.assertRaisesRegex(FileNotFoundError, "pluto_detail_normal.png"):
            module.pluto_config(
                "pluto",
                self.catalog,
                self.root / "models",
                self.root / "textures",
                self.root / "source-model",
            )

    def test_rejects_non_dwarf_and_invalid_catalog_values(self):
        module = load_module()
        with self.assertRaisesRegex(ValueError, 'Body "earth" is not a dwarf'):
            module.pluto_config(
                "earth",
                self.catalog,
                self.root / "models",
                self.root / "textures",
                self.root / "source-model",
            )

        catalog = json.loads(self.catalog.read_text(encoding="utf-8"))
        catalog["bodies"][0]["visual"]["proceduralSeed"] = -1
        self.catalog.write_text(json.dumps(catalog), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "invalid proceduralSeed"):
            module.pluto_config(
                "pluto",
                self.catalog,
                self.root / "models",
                self.root / "textures",
                self.root / "source-model",
            )

    def test_committed_sources_name_origin_generator_seed_and_rights(self):
        sources_path = (
            Path(__file__).parents[2]
            / "assets"
            / "models"
            / "dwarfs"
            / "pluto"
            / "SOURCES.md"
        )
        sources = sources_path.read_text(encoding="utf-8")
        self.assertIn("PIA11707", sources)
        self.assertIn("https://www.jpl.nasa.gov/images/pia11707-pluto-color-map/", sources)
        self.assertIn("public domain", sources.lower())
        albedo_line = next(
            line for line in sources.splitlines() if line.startswith("- `pluto_albedo.jpg`")
        )
        self.assertIn("tools/textures/preparePlutoMap.mjs", albedo_line)
        self.assertIn("seed 999", albedo_line)
        self.assertIn("no-data", albedo_line)
        for filename in ("pluto_detail_albedo.jpg", "pluto_detail_normal.png"):
            matching = [line for line in sources.splitlines() if line.startswith(f"- `{filename}`")]
            self.assertEqual(len(matching), 1)
            self.assertIn("tools/generateDetailTextures.mjs", matching[0])
            self.assertIn("seed 999", matching[0])
            self.assertIn("all rights reserved", matching[0])


if __name__ == "__main__":
    unittest.main()
