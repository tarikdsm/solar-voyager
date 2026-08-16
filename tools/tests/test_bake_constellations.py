import gzip
import hashlib
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


def load_tool(module_name: str):
    module_path = Path(__file__).parents[1] / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bake = load_tool("bake_constellations")
bake_stars = load_tool("bake_stars")

COMPLETE_COORDINATES = "062143.9-523827"
BLANK_COORDINATES = " " * 15
PARTIAL_COORDINATES = "0621     -523827"[:15]

# Sorted fixture HR ids; HR 92 is a blank-coordinate record stars.bin never emits,
# so the surviving records take star indices 0..10 in increasing HR order.
CATALOG_HR_IDS = (15, 92, 163, 165, 215, 7306, 7405, 7592, 8762, 8961, 8965, 8976)
BLANK_COORDINATE_HR = 92
STAR_INDEX_BY_HR = {
    15: 0,
    163: 1,
    165: 2,
    215: 3,
    7306: 4,
    7405: 5,
    7592: 6,
    8762: 7,
    8961: 8,
    8965: 9,
    8976: 10,
}

LINES_TEXT = """# ConstellationLines.dat: synthetic fixture.
# Licence: irrelevant here.

And  4 8961 8976 8965 8762
And  2  165  163
Vul  3 7306 7405 7592
"""


def catalog_line(hr: int, coordinates: str = COMPLETE_COORDINATES) -> str:
    """Build a fixed-width Yale record carrying only the fields the bake reads."""
    record = [" "] * bake.CATALOG_REQUIRED_BYTES
    record[0:4] = f"{hr:4d}"
    record[75:90] = coordinates
    return "".join(record)


def catalog_fixture_lines() -> list[str]:
    return [
        catalog_line(
            hr,
            BLANK_COORDINATES if hr == BLANK_COORDINATE_HR else COMPLETE_COORDINATES,
        )
        for hr in CATALOG_HR_IDS
    ]


def catalog_fixture_index():
    return bake.build_catalog_index(catalog_fixture_lines())


class PinSyncTests(unittest.TestCase):
    def test_star_source_pins_stay_synchronised_with_bake_stars(self):
        self.assertEqual(bake.STARS_SOURCE_URL, bake_stars.SOURCE_URL)
        self.assertEqual(bake.STARS_SOURCE_SHA256, bake_stars.SOURCE_SHA256)
        self.assertEqual(
            bake.EXPECTED_SOURCE_RECORDS, bake_stars.EXPECTED_SOURCE_RECORDS
        )
        self.assertEqual(bake.EXPECTED_STAR_COUNT, bake_stars.EXPECTED_STAR_COUNT)
        self.assertEqual(bake.CATALOG_REQUIRED_BYTES, bake_stars.CATALOG_REQUIRED_BYTES)


class CatalogIndexTests(unittest.TestCase):
    def test_indexes_only_records_with_complete_j2000_coordinates(self):
        catalog = catalog_fixture_index()

        self.assertEqual(catalog.star_index_by_hr, STAR_INDEX_BY_HR)
        self.assertEqual(catalog.blank_coordinate_hr_ids, frozenset({BLANK_COORDINATE_HR}))
        self.assertEqual(catalog.star_count, len(CATALOG_HR_IDS) - 1)

    def test_reproduces_bake_stars_record_filter_on_real_catalog_lines(self):
        lines = [
            "2326   Alp CarCP-52  914  45348234480 245I                  "
            "062143.9-523827062357.1-524145261.21-25.29-0.72  +0.15 +0.10 +0.18   "
            "F0II               +0.022+0.021 +.028+021        0                 *",
            "2491  9Alp CMaBD-16 1591  48915151881 257I   5423           "
            "064044.6-163444064508.9-164258227.22-08.88-1.46   0.00 -0.05 -0.03   "
            "A1Vm               -0.553-1.205 +.375-008SBO    13 10.3  11.2AB   4*",
        ]
        blanked = list(lines[0])
        blanked[75:90] = BLANK_COORDINATES
        source = [lines[0], "".join(blanked).replace("2326", "2400", 1), lines[1]]

        _, star_count = bake_stars.build_payload(source)
        catalog = bake.build_catalog_index(source)

        self.assertEqual(catalog.star_count, star_count)
        self.assertEqual(catalog.star_index_by_hr, {2326: 0, 2491: 1})

    def test_rejects_incomplete_coordinates_and_non_increasing_hr_ids(self):
        with self.assertRaisesRegex(ValueError, "HR 15 has incomplete J2000 coordinates"):
            bake.build_catalog_index([catalog_line(15, PARTIAL_COORDINATES)])
        with self.assertRaisesRegex(ValueError, "strictly increasing HR"):
            bake.build_catalog_index([catalog_line(163), catalog_line(15)])
        with self.assertRaisesRegex(ValueError, "at least 114 bytes"):
            bake.build_catalog_index([catalog_line(15)[:113]])


class PolylineParserTests(unittest.TestCase):
    def test_parses_polylines_and_skips_comments_and_blank_lines(self):
        polylines = bake.parse_polylines(LINES_TEXT)

        self.assertEqual(
            polylines,
            [
                bake.Polyline("And", (8961, 8976, 8965, 8762)),
                bake.Polyline("And", (165, 163)),
                bake.Polyline("Vul", (7306, 7405, 7592)),
            ],
        )
        self.assertEqual(bake.parse_polylines("# only a comment\n\n   \n"), [])
        self.assertEqual(
            bake.parse_polylines("\tAnd 2 165 163\r\n"),
            [bake.Polyline("And", (165, 163))],
        )

    def test_rejects_count_field_disagreeing_with_listed_hr_ids(self):
        with self.assertRaisesRegex(
            ValueError, r"line 1 declares 3 HR ids for And but lists 2"
        ):
            bake.parse_polylines("And 3 165 163\n")
        with self.assertRaisesRegex(
            ValueError, r"line 2 declares 2 HR ids for Vul but lists 3"
        ):
            bake.parse_polylines("# header\nVul 2 7306 7405 7592\n")

    def test_rejects_malformed_records(self):
        with self.assertRaisesRegex(ValueError, "invalid IAU abbreviation 'Andr'"):
            bake.parse_polylines("Andr 2 165 163\n")
        with self.assertRaisesRegex(ValueError, "invalid IAU abbreviation 'A1d'"):
            bake.parse_polylines("A1d 2 165 163\n")
        with self.assertRaisesRegex(ValueError, "line 1 has a non-integer field"):
            bake.parse_polylines("And 2 165 16x\n")
        with self.assertRaisesRegex(ValueError, "at least 2 are required"):
            bake.parse_polylines("And 1 165\n")
        with self.assertRaisesRegex(ValueError, "must read '<abbreviation> <count>"):
            bake.parse_polylines("And\n")


class SegmentTests(unittest.TestCase):
    def build(self, text: str):
        return bake.build_segments(bake.parse_polylines(text), catalog_fixture_index())

    def test_connects_consecutive_hr_ids_into_star_index_pairs(self):
        segment_set = self.build(LINES_TEXT)

        self.assertEqual(
            segment_set.segments,
            ((8, 10), (10, 9), (9, 7), (2, 1), (4, 5), (5, 6)),
        )
        self.assertEqual(segment_set.duplicate_count, 0)
        self.assertEqual(segment_set.distinct_star_count, 9)

    def test_deduplicates_retraced_and_reversed_segments(self):
        segment_set = self.build("And 5 165 163 215 163 165\n")

        self.assertEqual(segment_set.segments, ((2, 1), (1, 3)))
        self.assertEqual(segment_set.duplicate_count, 2)
        self.assertEqual(segment_set.distinct_star_count, 3)

    def test_deduplicates_reversed_segments_across_polylines(self):
        segment_set = self.build("And 2 165 163\nVul 2 163 165\n")

        self.assertEqual(segment_set.segments, ((2, 1),))
        self.assertEqual(segment_set.duplicate_count, 1)

    def test_orders_segments_by_ascii_abbreviation_then_source_order(self):
        text = "Cae 2 15 163\nVul 2 7306 7405\nCMa 2 8961 8965\nAnd 2 165 215\n"

        self.assertEqual(
            self.build(text).segments, ((2, 3), (8, 9), (0, 1), (4, 5))
        )
        self.assertEqual(
            self.build(text).segments,
            self.build("And 2 165 215\nCMa 2 8961 8965\nCae 2 15 163\nVul 2 7306 7405\n").segments,
        )

    def test_preserves_source_order_between_polylines_of_one_constellation(self):
        forwards = self.build("And 2 8961 8965\nAnd 2 165 215\n")
        backwards = self.build("And 2 165 215\nAnd 2 8961 8965\n")

        self.assertEqual(forwards.segments, ((8, 9), (2, 3)))
        self.assertEqual(backwards.segments, ((2, 3), (8, 9)))

    def test_rejects_unknown_hr_ids(self):
        with self.assertRaisesRegex(
            ValueError, r"And references HR 9999, absent from the Yale catalog"
        ):
            self.build("And 2 165 9999\n")

    def test_rejects_hr_ids_whose_records_have_blank_coordinates(self):
        with self.assertRaisesRegex(
            ValueError, r"And references HR 92, whose Yale record has blank J2000 coordinates"
        ):
            self.build("And 2 92 163\n")

    def test_rejects_consecutively_repeated_vertices(self):
        with self.assertRaisesRegex(ValueError, "And repeats star index 2 consecutively"):
            self.build("And 3 165 165 163\n")

    def test_rejects_star_indices_beyond_the_uint16_range(self):
        catalog = bake.CatalogIndex(
            star_index_by_hr={165: 0, 163: bake.MAX_STAR_INDEX + 1},
            blank_coordinate_hr_ids=frozenset(),
        )
        with self.assertRaisesRegex(ValueError, "beyond the uint16 range"):
            bake.build_segments(bake.parse_polylines("And 2 165 163\n"), catalog)


class PayloadTests(unittest.TestCase):
    def test_packs_segments_as_little_endian_uint16_pairs(self):
        segments = ((8, 10), (10, 9), (2, 1))
        payload = bake.build_payload(segments)

        self.assertEqual(len(payload), len(segments) * bake.BYTES_PER_SEGMENT)
        self.assertEqual(payload, struct.pack("<6H", 8, 10, 10, 9, 2, 1))
        self.assertEqual(payload[:4], b"\x08\x00\x0a\x00")
        self.assertEqual(struct.unpack("<6H", payload), (8, 10, 10, 9, 2, 1))
        self.assertEqual(bake.build_payload(()), b"")

    def test_verifies_both_pinned_sources_before_decoding(self):
        compressed = gzip.compress("\n".join(catalog_fixture_lines()).encode("ascii"), mtime=0)
        lines_source = LINES_TEXT.encode("ascii")

        with self.assertRaisesRegex(ValueError, "stars source SHA-256 mismatch"):
            bake.verify_and_decode_catalog(compressed)
        with self.assertRaisesRegex(ValueError, "lines source SHA-256 mismatch"):
            bake.verify_and_decode_lines(lines_source)

        with mock.patch.object(
            bake, "STARS_SOURCE_SHA256", hashlib.sha256(compressed).hexdigest()
        ):
            self.assertEqual(
                bake.verify_and_decode_catalog(compressed), catalog_fixture_lines()
            )
        with mock.patch.object(
            bake, "LINES_SOURCE_SHA256", hashlib.sha256(lines_source).hexdigest()
        ):
            self.assertEqual(bake.verify_and_decode_lines(lines_source), LINES_TEXT)

    def test_bakes_both_verified_sources_end_to_end(self):
        compressed = gzip.compress("\n".join(catalog_fixture_lines()).encode("ascii"), mtime=0)
        lines_source = LINES_TEXT.encode("ascii")

        with mock.patch.multiple(
            bake,
            STARS_SOURCE_SHA256=hashlib.sha256(compressed).hexdigest(),
            LINES_SOURCE_SHA256=hashlib.sha256(lines_source).hexdigest(),
            EXPECTED_SOURCE_RECORDS=len(CATALOG_HR_IDS),
            EXPECTED_STAR_COUNT=len(CATALOG_HR_IDS) - 1,
            EXPECTED_CONSTELLATIONS=2,
        ):
            result = bake.bake_figures(compressed, lines_source)

            self.assertEqual(result.constellation_count, 2)
            self.assertEqual(result.polyline_count, 3)
            self.assertEqual(result.segment_count, 6)
            self.assertEqual(result.duplicate_count, 0)
            self.assertEqual(result.distinct_star_count, 9)
            self.assertEqual(
                result.payload, struct.pack("<12H", 8, 10, 10, 9, 9, 7, 2, 1, 4, 5, 5, 6)
            )

    def test_rejects_drifted_record_star_and_constellation_counts(self):
        compressed = gzip.compress("\n".join(catalog_fixture_lines()).encode("ascii"), mtime=0)
        lines_source = LINES_TEXT.encode("ascii")
        pins = {
            "STARS_SOURCE_SHA256": hashlib.sha256(compressed).hexdigest(),
            "LINES_SOURCE_SHA256": hashlib.sha256(lines_source).hexdigest(),
        }

        with mock.patch.multiple(
            bake, **pins, EXPECTED_SOURCE_RECORDS=len(CATALOG_HR_IDS) + 1
        ):
            with self.assertRaisesRegex(ValueError, "expected 13 Yale records, received 12"):
                bake.bake_figures(compressed, lines_source)

        with mock.patch.multiple(
            bake,
            **pins,
            EXPECTED_SOURCE_RECORDS=len(CATALOG_HR_IDS),
            EXPECTED_STAR_COUNT=len(CATALOG_HR_IDS),
        ):
            with self.assertRaisesRegex(
                ValueError, r"expected 12 stars\.bin records, indexed 11"
            ):
                bake.bake_figures(compressed, lines_source)

        with mock.patch.multiple(
            bake,
            **pins,
            EXPECTED_SOURCE_RECORDS=len(CATALOG_HR_IDS),
            EXPECTED_STAR_COUNT=len(CATALOG_HR_IDS) - 1,
            EXPECTED_CONSTELLATIONS=88,
        ):
            with self.assertRaisesRegex(ValueError, "expected 88 constellations, received 2"):
                bake.bake_figures(compressed, lines_source)

    def test_atomically_replaces_output_without_leaving_temporary_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "constellations.bin"
            bake.atomic_write_bytes(output_path, b"first")
            bake.atomic_write_bytes(output_path, struct.pack("<2H", 1, 2))

            self.assertEqual(output_path.read_bytes(), struct.pack("<2H", 1, 2))
            self.assertEqual(list(output_path.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
