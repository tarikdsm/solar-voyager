import importlib.util
from collections import Counter
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "bake_ephemerides.py"
SPEC = importlib.util.spec_from_file_location("bake_ephemerides", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {MODULE_PATH}")
bake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bake)

EXPECTED_BODY_IDS = [
    "sun",
    "mercury",
    "venus",
    "earth",
    "moon",
    "mars",
    "phobos",
    "deimos",
    "jupiter",
    "io",
    "europa",
    "ganymede",
    "callisto",
    "saturn",
    "mimas",
    "enceladus",
    "tethys",
    "dione",
    "rhea",
    "titan",
    "iapetus",
    "uranus",
    "miranda",
    "ariel",
    "umbriel",
    "titania",
    "oberon",
    "neptune",
    "triton",
    "pluto",
    "charon",
    "ceres",
    "eris",
    "makemake",
    "haumea",
    "vesta",
    "pallas",
    "hygiea",
    "eros",
    "bennu",
    "ryugu",
    "1p",
    "67p",
]


def sample_elements():
    return {
        body_id: {
            "semiMajorAxisKm": float(index + 1) * bake.AU_KM,
            "eccentricity": 0.01,
            "inclinationRad": 0.02,
            "longitudeAscendingNodeRad": 0.03,
            "argumentPeriapsisRad": 0.04,
            "meanAnomalyRad": 0.05,
        }
        for index, body_id in enumerate(bake.BODY_IDS)
        if body_id != "sun"
    }


def successful_query(definition, _factory, _cache):
    return sample_elements()[definition.id], [
        {"positionKm": [0.0, 0.0, 0.0], "velocityKmS": [0.0, 0.0, 0.0]}
        for _ in bake.CHECK_OFFSETS_DAYS
    ]


class BakeCoreTests(unittest.TestCase):
    def test_defines_the_complete_parent_first_v1_catalog(self):
        self.assertEqual(bake.BODY_IDS, EXPECTED_BODY_IDS)
        self.assertEqual(
            Counter(definition.kind for definition in bake.BODY_DEFINITIONS),
            Counter(
                {"star": 1, "planet": 8, "dwarf": 5, "moon": 21, "asteroid": 6, "comet": 2}
            ),
        )

        seen = set()
        seeds = set()
        for definition in bake.BODY_DEFINITIONS:
            if definition.parent_id is not None:
                self.assertIn(definition.parent_id, seen, definition.id)
            self.assertTrue(math.isfinite(definition.mu_km3_s2) and definition.mu_km3_s2 > 0)
            self.assertTrue(math.isfinite(definition.mean_radius_km) and definition.mean_radius_km > 0)
            self.assertTrue(
                math.isfinite(definition.sidereal_rotation_period_sec)
                and definition.sidereal_rotation_period_sec != 0
            )
            self.assertTrue(math.isfinite(definition.axial_tilt_rad))
            self.assertGreaterEqual(definition.geometric_albedo, 0)
            self.assertLessEqual(definition.geometric_albedo, 1)
            self.assertNotIn(definition.procedural_seed, seeds)
            seen.add(definition.id)
            seeds.add(definition.procedural_seed)

        self.assertEqual(bake.DEFINITION_BY_ID["1p"].horizons_id, 90_000_030)
        self.assertEqual(bake.DEFINITION_BY_ID["67p"].horizons_id, 90_000_702)

    def test_converts_horizons_elements_to_game_units(self):
        elements = bake.elements_from_row(
            {
                "a": 2.0,
                "e": 0.1,
                "incl": 180.0,
                "Omega": 90.0,
                "w": 45.0,
                "M": 270.0,
            }
        )

        self.assertEqual(elements["semiMajorAxisKm"], 2 * bake.AU_KM)
        self.assertEqual(elements["eccentricity"], 0.1)
        self.assertAlmostEqual(elements["inclinationRad"], math.pi)
        self.assertAlmostEqual(elements["longitudeAscendingNodeRad"], math.pi / 2)
        self.assertAlmostEqual(elements["argumentPeriapsisRad"], math.pi / 4)
        self.assertAlmostEqual(elements["meanAnomalyRad"], 3 * math.pi / 2)

    def test_converts_horizons_vectors_to_game_units(self):
        state = bake.state_from_row(
            {"x": 1.0, "y": 2.0, "z": 3.0, "vx": 4.0, "vy": 5.0, "vz": 6.0}
        )

        self.assertEqual(
            state["positionKm"], [bake.AU_KM, 2 * bake.AU_KM, 3 * bake.AU_KM]
        )
        self.assertEqual(state["velocityKmS"][0], 4 * bake.AU_KM / bake.DAY_SEC)
        self.assertEqual(state["velocityKmS"][2], 6 * bake.AU_KM / bake.DAY_SEC)

    def test_rejects_missing_or_non_finite_query_values(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            bake.elements_from_row({"a": 1.0})
        with self.assertRaisesRegex(ValueError, "finite"):
            bake.state_from_row(
                {"x": math.nan, "y": 0, "z": 0, "vx": 0, "vy": 0, "vz": 0}
            )
        with self.assertRaisesRegex(ValueError, "invalid Kepler branch"):
            bake.elements_from_row(
                {
                    "a": 1.0,
                    "e": 1.1,
                    "incl": 0,
                    "Omega": 0,
                    "w": 0,
                    "M": 0,
                }
            )

    def test_computes_sphere_of_influence_from_mu_ratio(self):
        self.assertAlmostEqual(
            bake.sphere_of_influence_km(100_000.0, 1.0, 1_000.0),
            100_000.0 * (1.0 / 1_000.0) ** (2.0 / 5.0),
        )
        self.assertAlmostEqual(
            bake.sphere_of_influence_km(-100_000.0, 1.0, 1_000.0),
            100_000.0 * (1.0 / 1_000.0) ** (2.0 / 5.0),
        )

    def test_builds_canonical_parent_order_and_nullable_sun_orbit(self):
        catalog = bake.build_catalog(sample_elements())

        self.assertEqual([body["id"] for body in catalog["bodies"]], bake.BODY_IDS)
        sun = catalog["bodies"][0]
        moon = next(body for body in catalog["bodies"] if body["id"] == "moon")
        self.assertIsNone(sun["parentId"])
        self.assertIsNone(sun["elements"])
        self.assertIsNone(sun["soiRadiusKm"])
        self.assertEqual(moon["parentId"], "earth")
        self.assertGreater(moon["soiRadiusKm"], 0)

    def test_builds_three_complete_heliocentric_check_samples(self):
        vectors = {
            body_id: [
                {"positionKm": [float(sample), 0.0, 0.0], "velocityKmS": [0.0, 1.0, 0.0]}
                for sample in range(3)
            ]
            for body_id in bake.BODY_IDS
            if body_id != "sun"
        }

        checks = bake.build_checks(vectors)

        self.assertEqual([sample["offsetDays"] for sample in checks["samples"]], [0, 30, 365])
        for sample in checks["samples"]:
            self.assertEqual(list(sample["states"]), bake.BODY_IDS)
            self.assertEqual(sample["states"]["sun"]["positionKm"], [0.0, 0.0, 0.0])
            self.assertEqual(sample["states"]["sun"]["velocityKmS"], [0.0, 0.0, 0.0])


class FakeHorizons:
    calls = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls.append(("init", kwargs))

    def elements(self, **kwargs):
        self.calls.append(("elements", kwargs))
        return [
            {
                "datetime_jd": bake.EPOCH_JD_TDB,
                "a": 1,
                "e": 0.1,
                "incl": 2,
                "Omega": 3,
                "w": 4,
                "M": 5,
            }
        ]

    def vectors(self, **kwargs):
        self.calls.append(("vectors", kwargs))
        return [
            {
                "datetime_jd": bake.EPOCH_JD_TDB + bake.CHECK_OFFSETS_DAYS[index],
                "x": index,
                "y": 0,
                "z": 0,
                "vx": 0,
                "vy": 1,
                "vz": 0,
            }
            for index in range(3)
        ]


class BakeAdapterTests(unittest.TestCase):
    def setUp(self):
        FakeHorizons.calls = []

    def test_routes_parent_relative_and_small_body_queries_without_ambiguity(self):
        cases = [
            ("earth", "500@10", None, "399"),
            ("moon", "500@399", None, "301"),
            ("io", "500@599", None, "501"),
            ("charon", "500@999", None, "901"),
            ("ceres", "500@10", "smallbody", "1"),
            ("1p", "500@10", None, "90000030"),
            ("67p", "500@10", None, "90000702"),
        ]

        for body_id, element_center, id_type, target_id in cases:
            with self.subTest(body_id=body_id):
                FakeHorizons.calls = []
                bake.query_body(bake.DEFINITION_BY_ID[body_id], FakeHorizons, cache=False)
                calls = list(FakeHorizons.calls)
                self.assertEqual(calls[0][1]["id"], target_id)
                self.assertEqual(calls[0][1]["id_type"], id_type)
                self.assertEqual(calls[0][1]["location"], element_center)
                self.assertEqual(calls[0][1]["epochs"], bake.EPOCH_JD_TDB)
                self.assertEqual(
                    calls[1], ("elements", {"refplane": "ecliptic", "cache": False})
                )
                self.assertEqual(calls[2][1]["location"], "500@10")
                self.assertEqual(calls[2][1]["id_type"], id_type)
                self.assertEqual(
                    calls[2][1]["epochs"],
                    [bake.EPOCH_JD_TDB + offset for offset in bake.CHECK_OFFSETS_DAYS],
                )

    def test_query_failure_preserves_existing_output_bytes(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_dir = Path(temporary_directory)
            catalog_path = output_dir / "bodies.json"
            checks_path = output_dir / "ephemerides-check.json"
            catalog_path.write_bytes(b"catalog-before")
            checks_path.write_bytes(b"checks-before")

            def failing_query(definition, _factory, _cache):
                if definition.id == "venus":
                    raise RuntimeError("service unavailable")
                return sample_elements()[definition.id], [
                    {"positionKm": [0.0, 0.0, 0.0], "velocityKmS": [0.0, 0.0, 0.0]}
                    for _ in bake.CHECK_OFFSETS_DAYS
                ]

            with self.assertRaisesRegex(RuntimeError, "venus"):
                bake.bake(output_dir, query_function=failing_query)

            self.assertEqual(catalog_path.read_bytes(), b"catalog-before")
            self.assertEqual(checks_path.read_bytes(), b"checks-before")

    def test_rejects_horizons_rows_with_an_unexpected_epoch(self):
        class WrongEpochHorizons(FakeHorizons):
            def vectors(self, **kwargs):
                rows = super().vectors(**kwargs)
                rows[1]["datetime_jd"] += 1
                return rows

        with self.assertRaisesRegex(ValueError, "vector row 1 epoch"):
            bake.query_body(bake.DEFINITION_BY_ID["earth"], WrongEpochHorizons)

    def test_publish_failure_rolls_back_both_outputs(self):
        for failed_publish in (1, 2):
            with self.subTest(failed_publish=failed_publish):
                temporary_directory_context = tempfile.TemporaryDirectory()
                self.addCleanup(temporary_directory_context.cleanup)
                temporary_directory = temporary_directory_context.name
                output_dir = Path(temporary_directory)
                catalog_path = output_dir / "bodies.json"
                checks_path = output_dir / "ephemerides-check.json"
                catalog_path.write_bytes(b"catalog-before")
                checks_path.write_bytes(b"checks-before")
                real_replace = os.replace
                publish_count = 0

                def fail_publish(source, destination):
                    nonlocal publish_count
                    if str(source).endswith(".tmp"):
                        publish_count += 1
                        if publish_count == failed_publish:
                            raise OSError(f"simulated publish failure {failed_publish}")
                    return real_replace(source, destination)

                with mock.patch.object(bake.os, "replace", side_effect=fail_publish):
                    with self.assertRaisesRegex(OSError, "publish failure"):
                        bake.bake(output_dir, query_function=successful_query)

                self.assertEqual(catalog_path.read_bytes(), b"catalog-before")
                self.assertEqual(checks_path.read_bytes(), b"checks-before")
                self.assertFalse(Path(f"{catalog_path}.bak").exists())
                self.assertFalse(Path(f"{checks_path}.bak").exists())

    def test_failed_rollback_preserves_recovery_backup(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_dir = Path(temporary_directory)
            catalog_path = output_dir / "bodies.json"
            checks_path = output_dir / "ephemerides-check.json"
            catalog_backup = Path(f"{catalog_path}.bak")
            checks_backup = Path(f"{checks_path}.bak")
            catalog_path.write_bytes(b"catalog-before")
            checks_path.write_bytes(b"checks-before")
            real_replace = os.replace
            publish_count = 0

            def fail_publish_and_restore(source, destination):
                nonlocal publish_count
                if str(source).endswith(".tmp"):
                    publish_count += 1
                    if publish_count == 2:
                        raise OSError("simulated second publish failure")
                if Path(source) == catalog_backup:
                    raise OSError("simulated catalog restore failure")
                return real_replace(source, destination)

            with mock.patch.object(bake.os, "replace", side_effect=fail_publish_and_restore):
                with self.assertRaisesRegex(RuntimeError, "rollback failed.*bodies.json.bak"):
                    bake.bake(output_dir, query_function=successful_query)

            self.assertNotEqual(catalog_path.read_bytes(), b"catalog-before")
            self.assertEqual(checks_path.read_bytes(), b"checks-before")
            self.assertEqual(catalog_backup.read_bytes(), b"catalog-before")
            self.assertFalse(checks_backup.exists())

    def test_atomic_json_writer_is_deterministic_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "output.json"

            bake.atomic_write_json(path, {"b": 2, "a": 1})

            self.assertEqual(path.read_text(encoding="utf-8"), '{\n  "b": 2,\n  "a": 1\n}\n')
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
