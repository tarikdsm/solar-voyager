import json
import tempfile
import unittest
from pathlib import Path


from tools.blender.ring_config import ring_planet_config


class RingPlanetConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.catalog_path = self.root / "bodies.json"
        self.rings_path = self.root / "rings.json"
        self.models_root = self.root / "models"
        self.textures_root = self.root / "textures"
        bodies = []
        systems = []
        for body_id, ratio, reference, inner, outer in (
            ("jupiter", 0.935125609, 71_492, 100_000, 270_000),
            ("saturn", 0.902037566, 60_268, 66_900, 140_224),
            ("uranus", 0.977072655, 25_559, 36_100, 106_200),
            ("neptune", 0.982918753, 24_764, 41_000, 62_940),
        ):
            bodies.append(
                {
                    "id": body_id,
                    "name": body_id.title(),
                    "kind": "planet",
                    "visual": {"proceduralSeed": len(bodies) + 1, "polarRadiusRatio": ratio},
                }
            )
            systems.append(
                {
                    "bodyId": body_id,
                    "referenceRadiusKm": reference,
                    "innerRadiusKm": inner,
                    "outerRadiusKm": outer,
                    "exposure": 2,
                    "baseColor": "#ffffff",
                    "bands": [
                        {
                            "name": "main",
                            "innerRadiusKm": inner,
                            "outerRadiusKm": outer,
                            "opticalDepth": 0.5,
                            "color": "#ffffff",
                        }
                    ],
                    "arcs": [],
                    "particles": None,
                    "sources": ["https://example.test/rings"],
                }
            )
            source = self.textures_root / body_id
            source.mkdir(parents=True)
            for name in (
                f"{body_id}_albedo.jpg",
                f"{body_id}_detail_albedo.jpg",
                f"{body_id}_detail_normal.png",
                f"{body_id}_rings.png",
                "SOURCES.md",
            ):
                (source / name).write_bytes(b"fixture")
        self.catalog_path.write_text(
            json.dumps({"schemaVersion": 2, "bodies": bodies}), encoding="utf-8"
        )
        self.rings_path.write_text(
            json.dumps({"schemaVersion": 1, "systems": systems}), encoding="utf-8"
        )

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, body_id):
        return ring_planet_config(
            body_id,
            catalog_path=self.catalog_path,
            rings_path=self.rings_path,
            models_root=self.models_root,
            textures_root=self.textures_root,
        )

    def test_resolves_all_four_normalized_ring_contracts(self):
        expected = {
            "jupiter": (100_000 / 71_492, 270_000 / 71_492),
            "saturn": (66_900 / 60_268, 140_224 / 60_268),
            "uranus": (36_100 / 25_559, 106_200 / 25_559),
            "neptune": (41_000 / 24_764, 62_940 / 24_764),
        }
        for body_id, radii in expected.items():
            with self.subTest(body_id=body_id):
                config = self.config(body_id)
                self.assertEqual(config.body_id, body_id)
                self.assertEqual(config.category, "planets")
                self.assertEqual(config.angular_segments, 256)
                self.assertEqual(config.radial_segments, 4)
                self.assertAlmostEqual(config.inner_radius_ratio, radii[0], places=12)
                self.assertAlmostEqual(config.outer_radius_ratio, radii[1], places=12)
                self.assertEqual(config.surface_material_name, "mat_surface")
                self.assertEqual(config.ring_material_name, "mat_rings")
                self.assertEqual(len(config.source_files), 5)

    def test_reports_missing_source_files_by_body_and_role(self):
        missing = self.textures_root / "uranus" / "uranus_rings.png"
        missing.unlink()
        with self.assertRaisesRegex(
            FileNotFoundError, r'uranus.*ring texture.*uranus_rings\.png'
        ):
            self.config("uranus")

    def test_rejects_unknown_or_non_planet_catalog_entries(self):
        with self.assertRaisesRegex(ValueError, r'unknown ringed planet "earth"'):
            self.config("earth")


if __name__ == "__main__":
    unittest.main()
