import importlib.util
import json
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "small_body_config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("small_body_config", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def catalog_body(body_id, kind, **overrides):
    body = {
        "id": body_id,
        "name": body_id.upper(),
        "kind": kind,
        "meanRadiusKm": 8.42,
        "visual": {"albedoColor": "#9a7b68", "proceduralSeed": 433, "polarRadiusRatio": 1.0},
    }
    body.update(overrides)
    return body


class SmallBodyConfigTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.context = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.context.name)
        self.catalog = self.root / "bodies.json"
        self.write_catalog(
            catalog_body("eros", "asteroid"),
            catalog_body("67p", "comet", meanRadiusKm=1.7),
            catalog_body("earth", "planet", meanRadiusKm=6371.0),
        )

    def tearDown(self):
        self.context.cleanup()

    def write_catalog(self, *bodies):
        self.catalog.write_text(
            json.dumps({"schemaVersion": 2, "bodies": list(bodies)}), encoding="utf-8"
        )

    def config(self, body_id, **kwargs):
        return self.module.small_body_config(
            body_id, catalog_path=self.catalog, models_root=self.root / "models", **kwargs
        )

    def test_resolves_the_asteroid_authoring_contract_from_the_catalog(self):
        config = self.config("eros")
        self.assertEqual(config.category, "asteroids")
        self.assertEqual(config.kind, "asteroid")
        self.assertEqual(config.procedural_seed, 433)
        self.assertEqual(config.mean_radius_km, 8.42)
        self.assertEqual(config.output_dir, (self.root / "models" / "asteroids" / "eros"))
        self.assertEqual(config.albedo_name, "eros_albedo.png")
        self.assertEqual(
            [round(channel, 6) for channel in config.albedo_color],
            [round(0x9A / 255.0, 6), round(0x7B / 255.0, 6), round(0x68 / 255.0, 6)],
        )
        self.assertIsNone(config.coma)

    def test_resolves_the_comet_anchor_contract(self):
        config = self.config("67p")
        self.assertEqual(config.category, "comets")
        self.assertIsNotNone(config.coma)
        self.assertGreater(config.coma.coma_radius_ratio, 1.0)
        self.assertGreater(config.coma.tail_length_ratio, config.coma.coma_radius_ratio)

    def test_anchor_names_are_the_frozen_t0139_api(self):
        self.assertEqual(self.module.COMA_ANCHOR_NAME, "coma_anchor")
        self.assertEqual(self.module.TAIL_ANCHOR_NAME, "tail_anchor")
        self.assertEqual(self.module.ANCHOR_NAMES, ("coma_anchor", "tail_anchor"))

    def test_rejects_bodies_that_are_not_asteroids_or_comets(self):
        with self.assertRaisesRegex(ValueError, "asteroid or comet"):
            self.config("earth")

    def test_rejects_an_asteroid_requested_as_a_comet(self):
        with self.assertRaisesRegex(ValueError, "not a comet"):
            self.config("eros", expected_kind="comet")

    def test_rejects_invalid_catalog_records(self):
        cases = (
            (catalog_body("eros", "asteroid", meanRadiusKm=0), "meanRadiusKm"),
            (
                catalog_body(
                    "eros", "asteroid", visual={"albedoColor": "#9a7b68", "proceduralSeed": -1}
                ),
                "proceduralSeed",
            ),
            (
                catalog_body(
                    "eros", "asteroid", visual={"albedoColor": "grey", "proceduralSeed": 433}
                ),
                "albedoColor",
            ),
        )
        for body, pattern in cases:
            with self.subTest(pattern=pattern):
                self.write_catalog(body)
                with self.assertRaisesRegex(ValueError, pattern):
                    self.config("eros")

    def test_requires_catalog_schema_version_two(self):
        self.catalog.write_text(json.dumps({"schemaVersion": 1, "bodies": []}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "schemaVersion"):
            self.config("eros")


class ShapeModelSourceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_declares_a_shape_model_for_every_flown_body(self):
        for body_id in ("eros", "bennu", "ryugu", "67p"):
            with self.subTest(body_id=body_id):
                source = self.module.shape_model_source(body_id)
                self.assertIsNotNone(source)
                self.assertEqual(source.body_id, body_id)
                self.assertEqual(source.role, "shape")
                self.assertEqual(source.model_format, "obj")
                self.assertEqual(source.output_name, f"{body_id}_shape.obj")
                self.assertTrue(source.product_url.startswith("https://"))
                self.assertIn("public domain", source.license.lower())

    def test_bodies_no_mission_visited_have_no_shape_model(self):
        for body_id in ("vesta", "pallas", "hygiea", "1p"):
            with self.subTest(body_id=body_id):
                self.assertIsNone(self.module.shape_model_source(body_id))

    def test_unpinned_sources_are_refused_and_name_the_owning_task(self):
        source = self.module.shape_model_source("eros")
        self.assertIsNone(source.source_url)
        self.assertIsNone(source.sha256)
        with self.assertRaisesRegex(ValueError, "T0132"):
            self.module.validate_shape_source(source)

    def test_pinned_sources_validate(self):
        source = self.module.shape_model_source("eros")._replace(
            source_url="https://sbnarchive.psi.edu/example/eros.obj", sha256="a" * 64
        )
        self.assertIs(self.module.validate_shape_source(source), source)

    def test_pinned_sources_must_use_https_and_a_lowercase_digest(self):
        base = self.module.shape_model_source("eros")
        cases = (
            (base._replace(source_url="http://example.test/eros.obj", sha256="a" * 64), "HTTPS"),
            (base._replace(source_url="https://example.test/eros.obj", sha256="A" * 64), "SHA-256"),
            (base._replace(source_url="https://example.test/eros.obj", sha256="a" * 63), "SHA-256"),
        )
        for source, pattern in cases:
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(ValueError, pattern):
                    self.module.validate_shape_source(source)

    def test_resolves_the_fetch_destination_and_refuses_escapes(self):
        source = self.module.shape_model_source("bennu")
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.assertEqual(
                self.module.resolve_shape_path(root, source),
                (root / "bennu" / "bennu_shape.obj").resolve(),
            )
            escaping = source._replace(output_name="../escaped.obj")
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.module.resolve_shape_path(root, escaping)


if __name__ == "__main__":
    unittest.main()
