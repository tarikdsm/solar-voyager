import gzip
import hashlib
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "bake_stars.py"
SPEC = importlib.util.spec_from_file_location("bake_stars", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {MODULE_PATH}")
bake = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bake
SPEC.loader.exec_module(bake)

CANOPUS_LINE = (
    "2326   Alp CarCP-52  914  45348234480 245I                  "
    "062143.9-523827062357.1-524145261.21-25.29-0.72  +0.15 +0.10 +0.18   "
    "F0II               +0.022+0.021 +.028+021        0                 *"
)
SIRIUS_LINE = (
    "2491  9Alp CMaBD-16 1591  48915151881 257I   5423           "
    "064044.6-163444064508.9-164258227.22-08.88-1.46   0.00 -0.05 -0.03   "
    "A1Vm               -0.553-1.205 +.375-008SBO    13 10.3  11.2AB   4*"
)


class StarParserTests(unittest.TestCase):
    def assert_tuple_almost_equal(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for actual_value, expected_value in zip(actual, expected, strict=True):
            self.assertAlmostEqual(actual_value, expected_value, places=12)

    def test_parses_canopus_and_sirius_catalog_fields(self):
        canopus = bake.parse_record(CANOPUS_LINE)
        sirius = bake.parse_record(SIRIUS_LINE)

        self.assertIsNotNone(canopus)
        self.assertIsNotNone(sirius)
        assert canopus is not None
        assert sirius is not None
        self.assertEqual(canopus.hr, 2326)
        self.assertEqual(sirius.hr, 2491)
        self.assertAlmostEqual(canopus.visual_magnitude, -0.72)
        self.assertAlmostEqual(sirius.visual_magnitude, -1.46)
        self.assertAlmostEqual(canopus.bv, 0.15)
        self.assertAlmostEqual(sirius.bv, 0.0)
        self.assertGreater(
            10 ** (-0.4 * sirius.visual_magnitude),
            10 ** (-0.4 * canopus.visual_magnitude),
        )

    def test_skips_historical_entries_with_blank_j2000_coordinates(self):
        line = list(CANOPUS_LINE)
        line[75:90] = " " * 15

        self.assertIsNone(bake.parse_record("".join(line)))

    def test_accepts_right_trimmed_records_and_rejects_missing_required_bytes(self):
        full = bake.parse_record(CANOPUS_LINE)
        trimmed = bake.parse_record(CANOPUS_LINE[:170])
        self.assertEqual(trimmed, full)

        with self.assertRaisesRegex(ValueError, "at least 114 bytes"):
            bake.parse_record(CANOPUS_LINE[:113])

        line = list(CANOPUS_LINE)
        line[102:107] = " " * 5
        with self.assertRaisesRegex(ValueError, "HR 2326.*V magnitude"):
            bake.parse_record("".join(line))

    def test_converts_spot_checks_to_ecliptic_j2000_directions(self):
        canopus = bake.parse_record(CANOPUS_LINE)
        sirius = bake.parse_record(SIRIUS_LINE)
        assert canopus is not None
        assert sirius is not None

        self.assert_tuple_almost_equal(
            bake.components_for_star(canopus)[:3],
            (-0.06322197015050315, 0.23659913080721862, -0.9695482627448504),
        )
        self.assert_tuple_almost_equal(
            bake.components_for_star(sirius)[:3],
            (-0.18745405323332234, 0.7473028927370847, -0.6374945995325638),
        )

    def test_maps_bv_to_bounded_rgb_and_uses_white_when_missing(self):
        self.assertEqual(bake.bv_to_rgb(None), (1.0, 1.0, 1.0))
        self.assertEqual(bake.bv_to_rgb(-10.0), bake.bv_to_rgb(-0.4))
        self.assertEqual(bake.bv_to_rgb(10.0), bake.bv_to_rgb(2.0))
        for component in bake.bv_to_rgb(0.65):
            self.assertGreaterEqual(component, 0.0)
            self.assertLessEqual(component, 1.0)


class StarPayloadTests(unittest.TestCase):
    def test_packs_source_order_as_deterministic_little_endian_float32(self):
        payload, star_count = bake.build_payload([CANOPUS_LINE, SIRIUS_LINE])
        canopus = bake.parse_record(CANOPUS_LINE)
        sirius = bake.parse_record(SIRIUS_LINE)
        assert canopus is not None
        assert sirius is not None

        expected = struct.pack("<7f", *bake.components_for_star(canopus)) + struct.pack(
            "<7f", *bake.components_for_star(sirius)
        )
        self.assertEqual(star_count, 2)
        self.assertEqual(payload, expected)
        self.assertEqual(bake.build_payload([CANOPUS_LINE, SIRIUS_LINE]), (payload, 2))

    def test_rejects_non_increasing_hr_ids(self):
        with self.assertRaisesRegex(ValueError, "strictly increasing HR"):
            bake.build_payload([SIRIUS_LINE, CANOPUS_LINE])

    def test_verifies_compressed_source_before_decoding(self):
        compressed = gzip.compress(
            f"{CANOPUS_LINE}\n{SIRIUS_LINE}\n".encode("ascii"), mtime=0
        )
        source_hash = hashlib.sha256(compressed).hexdigest()

        with self.assertRaisesRegex(ValueError, "source SHA-256 mismatch"):
            bake.verify_and_decode_source(compressed)
        with mock.patch.object(bake, "SOURCE_SHA256", source_hash):
            self.assertEqual(
                bake.verify_and_decode_source(compressed),
                [CANOPUS_LINE, SIRIUS_LINE],
            )

    def test_atomically_replaces_output_without_leaving_temporary_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "stars.bin"
            bake.atomic_write_bytes(output_path, b"first")
            bake.atomic_write_bytes(output_path, b"second")

            self.assertEqual(output_path.read_bytes(), b"second")
            self.assertEqual(list(output_path.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
