#!/usr/bin/env python3
"""Bake the pinned constellation figures into the runtime star-index segment payload."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import os
from pathlib import Path
import ssl
import struct
from urllib.request import Request, urlopen


# Kept in sync with tools/bake_stars.py by tools/tests/test_bake_constellations.py,
# which asserts these four constants still equal the ones that bake stars.bin.
STARS_SOURCE_URL = "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz"
STARS_SOURCE_SHA256 = "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed"
EXPECTED_SOURCE_RECORDS = 9_110
EXPECTED_STAR_COUNT = 9_096

LINES_SOURCE_URL = (
    "https://raw.githubusercontent.com/MarcvdSluys/ConstellationLines/"
    "v1.3/ConstellationLines.dat"
)
LINES_SOURCE_SHA256 = "aaccfda40b91a87a9fb7a456997bf869dea4c16dc3e91352800a8cfefa8f3f0d"
EXPECTED_CONSTELLATIONS = 88
CATALOG_REQUIRED_BYTES = 114
ABBREVIATION_LENGTH = 3
MINIMUM_POLYLINE_VERTICES = 2
BYTES_PER_SEGMENT = 4
MAX_STAR_INDEX = 0xFFFF


@dataclass(frozen=True)
class Polyline:
    """One source pen-stroke: consecutive HR ids joined into line segments."""

    abbreviation: str
    hr_ids: tuple[int, ...]


@dataclass(frozen=True)
class CatalogIndex:
    """The HR -> stars.bin record index map, plus the records stars.bin skips."""

    star_index_by_hr: dict[int, int]
    blank_coordinate_hr_ids: frozenset[int]

    @property
    def star_count(self) -> int:
        return len(self.star_index_by_hr)


@dataclass(frozen=True)
class SegmentSet:
    """Deduplicated segments in emission order, with the discarded retrace count."""

    segments: tuple[tuple[int, int], ...]
    duplicate_count: int

    @property
    def distinct_star_count(self) -> int:
        return len({index for segment in self.segments for index in segment})


@dataclass(frozen=True)
class BakeResult:
    """Everything the CLI reports about one complete bake."""

    payload: bytes
    constellation_count: int
    polyline_count: int
    segment_count: int
    duplicate_count: int
    distinct_star_count: int


def _field(line: str, first_byte: int, last_byte: int) -> str:
    return line[first_byte - 1 : last_byte].strip()


def build_catalog_index(lines: list[str]) -> CatalogIndex:
    """Reproduce bake_stars.build_payload's record filter to number stars.bin rows."""
    star_index_by_hr: dict[int, int] = {}
    blank_coordinate_hr_ids: set[int] = set()
    previous_hr = 0
    for line in lines:
        if len(line) < CATALOG_REQUIRED_BYTES:
            raise ValueError(
                f"Yale catalog record must contain at least {CATALOG_REQUIRED_BYTES} bytes, received {len(line)}"
            )

        hr = int(_field(line, 1, 4))
        coordinate_fields = (
            _field(line, 76, 77),
            _field(line, 78, 79),
            _field(line, 80, 83),
            _field(line, 84, 84),
            _field(line, 85, 86),
            _field(line, 87, 88),
            _field(line, 89, 90),
        )
        if not any(coordinate_fields):
            blank_coordinate_hr_ids.add(hr)
            continue
        if not all(coordinate_fields):
            raise ValueError(f"HR {hr} has incomplete J2000 coordinates")
        if hr <= previous_hr:
            raise ValueError(
                f"catalog records must have strictly increasing HR ids; received {hr} after {previous_hr}"
            )

        star_index_by_hr[hr] = len(star_index_by_hr)
        previous_hr = hr
    return CatalogIndex(
        star_index_by_hr=star_index_by_hr,
        blank_coordinate_hr_ids=frozenset(blank_coordinate_hr_ids),
    )


def parse_polylines(text: str) -> list[Polyline]:
    """Parse the whitespace-separated figure file, skipping comments and blank lines."""
    polylines: list[Polyline] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        tokens = line.split()
        if len(tokens) < 2:
            raise ValueError(
                f"line {line_number} must read '<abbreviation> <count> <HR>...', received {raw_line!r}"
            )

        abbreviation = tokens[0]
        if len(abbreviation) != ABBREVIATION_LENGTH or not abbreviation.isalpha():
            raise ValueError(
                f"line {line_number} has invalid IAU abbreviation {abbreviation!r}"
            )

        try:
            declared_count = int(tokens[1])
            hr_ids = tuple(int(token) for token in tokens[2:])
        except ValueError as error:
            raise ValueError(f"line {line_number} has a non-integer field") from error

        if declared_count != len(hr_ids):
            raise ValueError(
                f"line {line_number} declares {declared_count} HR ids for {abbreviation} but lists {len(hr_ids)}"
            )
        if declared_count < MINIMUM_POLYLINE_VERTICES:
            raise ValueError(
                f"line {line_number} gives {abbreviation} {declared_count} vertices; "
                f"at least {MINIMUM_POLYLINE_VERTICES} are required to form a segment"
            )
        polylines.append(Polyline(abbreviation=abbreviation, hr_ids=hr_ids))
    return polylines


def resolve_star_index(abbreviation: str, hr: int, catalog: CatalogIndex) -> int:
    """Map one figure HR id onto its stars.bin record index, or fail loudly."""
    star_index = catalog.star_index_by_hr.get(hr)
    if star_index is None:
        if hr in catalog.blank_coordinate_hr_ids:
            raise ValueError(
                f"{abbreviation} references HR {hr}, whose Yale record has blank J2000 coordinates"
            )
        raise ValueError(f"{abbreviation} references HR {hr}, absent from the Yale catalog")
    if star_index > MAX_STAR_INDEX:
        raise ValueError(
            f"{abbreviation} references HR {hr} at star index {star_index}, beyond the uint16 range"
        )
    return star_index


def build_segments(polylines: list[Polyline], catalog: CatalogIndex) -> SegmentSet:
    """Emit deduplicated segments ordered by abbreviation, then by source order."""
    segments: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    duplicate_count = 0
    for polyline in sorted(polylines, key=lambda candidate: candidate.abbreviation):
        star_indices = [
            resolve_star_index(polyline.abbreviation, hr, catalog) for hr in polyline.hr_ids
        ]
        for first_index, second_index in zip(star_indices, star_indices[1:]):
            if first_index == second_index:
                raise ValueError(
                    f"{polyline.abbreviation} repeats star index {first_index} consecutively"
                )
            unordered = (min(first_index, second_index), max(first_index, second_index))
            if unordered in seen:
                duplicate_count += 1
                continue
            seen.add(unordered)
            segments.append((first_index, second_index))
    return SegmentSet(segments=tuple(segments), duplicate_count=duplicate_count)


def build_payload(segments: tuple[tuple[int, int], ...]) -> bytes:
    """Pack segment endpoints into the raw little-endian Uint16 index-pair payload."""
    payload = bytearray()
    for first_index, second_index in segments:
        payload.extend(struct.pack("<2H", first_index, second_index))
    return bytes(payload)


def verify_and_decode_catalog(compressed: bytes) -> list[str]:
    """Verify the pinned compressed catalog before decoding its fixed-width lines."""
    actual_hash = hashlib.sha256(compressed).hexdigest()
    if actual_hash != STARS_SOURCE_SHA256:
        raise ValueError(
            f"stars source SHA-256 mismatch: expected {STARS_SOURCE_SHA256}, received {actual_hash}"
        )
    try:
        catalog_bytes = gzip.decompress(compressed)
        return catalog_bytes.decode("ascii").splitlines()
    except (gzip.BadGzipFile, UnicodeDecodeError) as error:
        raise ValueError("pinned Yale catalog is not valid ASCII gzip data") from error


def verify_and_decode_lines(raw: bytes) -> str:
    """Verify the pinned figure file before decoding its ASCII text."""
    actual_hash = hashlib.sha256(raw).hexdigest()
    if actual_hash != LINES_SOURCE_SHA256:
        raise ValueError(
            f"lines source SHA-256 mismatch: expected {LINES_SOURCE_SHA256}, received {actual_hash}"
        )
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("pinned constellation figures are not valid ASCII data") from error


def download_source(url: str) -> bytes:
    """Download a pinned source with an explicit maintained CA bundle."""
    try:
        import certifi
    except ImportError as error:
        raise RuntimeError(
            "certifi is required for network bakes; install tools/requirements-stars.txt"
        ) from error

    context = ssl.create_default_context(cafile=certifi.where())
    request = Request(url, headers={"User-Agent": "SolarVoyager-constellation-bake/1"})
    with urlopen(request, timeout=30, context=context) as response:
        return response.read()


def atomic_write_bytes(output_path: Path, payload: bytes) -> None:
    """Durably publish bytes with a same-directory atomic replacement."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    try:
        with temporary_path.open("wb") as output_file:
            output_file.write(payload)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def bake_figures(compressed_catalog: bytes, lines_source: bytes) -> BakeResult:
    """Validate and convert both complete pinned sources."""
    catalog_lines = verify_and_decode_catalog(compressed_catalog)
    if len(catalog_lines) != EXPECTED_SOURCE_RECORDS:
        raise ValueError(
            f"expected {EXPECTED_SOURCE_RECORDS} Yale records, received {len(catalog_lines)}"
        )

    catalog = build_catalog_index(catalog_lines)
    if catalog.star_count != EXPECTED_STAR_COUNT:
        raise ValueError(
            f"expected {EXPECTED_STAR_COUNT} stars.bin records, indexed {catalog.star_count}"
        )

    polylines = parse_polylines(verify_and_decode_lines(lines_source))
    constellation_count = len({polyline.abbreviation for polyline in polylines})
    if constellation_count != EXPECTED_CONSTELLATIONS:
        raise ValueError(
            f"expected {EXPECTED_CONSTELLATIONS} constellations, received {constellation_count}"
        )

    segment_set = build_segments(polylines, catalog)
    payload = build_payload(segment_set.segments)
    expected_bytes = len(segment_set.segments) * BYTES_PER_SEGMENT
    if len(payload) != expected_bytes:
        raise ValueError(f"expected {expected_bytes} payload bytes, emitted {len(payload)}")
    return BakeResult(
        payload=payload,
        constellation_count=constellation_count,
        polyline_count=len(polylines),
        segment_count=len(segment_set.segments),
        duplicate_count=segment_set.duplicate_count,
        distinct_star_count=segment_set.distinct_star_count,
    )


def parse_args() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stars-source", type=Path, help="local pinned catalog.gz")
    parser.add_argument(
        "--lines-source", type=Path, help="local pinned ConstellationLines.dat"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "constellations.bin",
        help="output binary path",
    )
    parser.add_argument("--stars-url", default=STARS_SOURCE_URL, help="catalog URL")
    parser.add_argument(
        "--lines-url", default=LINES_SOURCE_URL, help="constellation figures URL"
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    compressed_catalog = (
        args.stars_source.read_bytes()
        if args.stars_source
        else download_source(args.stars_url)
    )
    lines_source = (
        args.lines_source.read_bytes()
        if args.lines_source
        else download_source(args.lines_url)
    )
    result = bake_figures(compressed_catalog, lines_source)
    atomic_write_bytes(args.output, result.payload)
    print(f"Stars source SHA-256: {hashlib.sha256(compressed_catalog).hexdigest()}")
    print(f"Lines source SHA-256: {hashlib.sha256(lines_source).hexdigest()}")
    print(
        f"Baked {result.constellation_count} constellations "
        f"and {result.polyline_count} polylines into {result.segment_count:,} segments "
        f"({result.duplicate_count} duplicates removed) across {result.distinct_star_count:,} stars"
    )
    print(f"Payload: {len(result.payload):,} bytes")
    print(f"Output SHA-256: {hashlib.sha256(result.payload).hexdigest()}")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
