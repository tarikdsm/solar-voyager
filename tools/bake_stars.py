#!/usr/bin/env python3
"""Bake the pinned Yale Bright Star Catalogue into the runtime Float32 payload."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import math
import os
from pathlib import Path
import ssl
import struct
from urllib.request import Request, urlopen


SOURCE_URL = "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz"
SOURCE_SHA256 = "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed"
EXPECTED_SOURCE_RECORDS = 9_110
EXPECTED_STAR_COUNT = 9_096
STRIDE_FLOATS = 7
BYTES_PER_STAR = STRIDE_FLOATS * 4
J2000_OBLIQUITY_RAD = math.radians(23.439291111)
CATALOG_RECORD_BYTES = 197


@dataclass(frozen=True)
class StarRecord:
    hr: int
    ra_rad: float
    declination_rad: float
    visual_magnitude: float
    bv: float | None


def _field(line: str, first_byte: int, last_byte: int) -> str:
    return line[first_byte - 1 : last_byte].strip()


def parse_record(line: str) -> StarRecord | None:
    """Parse one CDS V/50 fixed-width record, or skip a blank historical entry."""
    if len(line) != CATALOG_RECORD_BYTES:
        raise ValueError(
            f"Yale catalog record must contain {CATALOG_RECORD_BYTES} bytes, received {len(line)}"
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
        return None
    if not all(coordinate_fields):
        raise ValueError(f"HR {hr} has incomplete J2000 coordinates")

    ra_hours_text, ra_minutes_text, ra_seconds_text = coordinate_fields[:3]
    declination_sign, dec_degrees_text, dec_minutes_text, dec_seconds_text = coordinate_fields[3:]
    if declination_sign not in {"+", "-"}:
        raise ValueError(f"HR {hr} has invalid declination sign {declination_sign!r}")

    visual_magnitude_text = _field(line, 103, 107)
    if not visual_magnitude_text:
        raise ValueError(f"HR {hr} has no V magnitude")

    ra_hours = (
        int(ra_hours_text)
        + int(ra_minutes_text) / 60
        + float(ra_seconds_text) / 3_600
    )
    declination_degrees = (
        int(dec_degrees_text)
        + int(dec_minutes_text) / 60
        + int(dec_seconds_text) / 3_600
    )
    if declination_sign == "-":
        declination_degrees = -declination_degrees

    bv_text = _field(line, 110, 114)
    return StarRecord(
        hr=hr,
        ra_rad=math.radians(ra_hours * 15),
        declination_rad=math.radians(declination_degrees),
        visual_magnitude=float(visual_magnitude_text),
        bv=float(bv_text) if bv_text else None,
    )


def bv_to_rgb(bv: float | None) -> tuple[float, float, float]:
    """Map a B-V color index to a bounded display RGB triplet."""
    if bv is None:
        return (1.0, 1.0, 1.0)

    clamped_bv = max(-0.4, min(2.0, bv))
    t = (clamped_bv + 0.4) / 2.4
    if t < 0.4:
        red = 0.61 + 0.11 * t + 0.1 * t * t
        green = 0.70 + 0.07 * t + 0.1 * t * t
        blue = 1.0
    else:
        u = t - 0.4
        red = 0.83 + 0.17 * t
        green = 0.87 + 0.11 * t
        blue = 1.0 - 0.47 * u - 0.53 * u * u
    return (red, green, blue)


def components_for_star(record: StarRecord) -> tuple[float, ...]:
    """Convert one catalog record to the seven runtime payload components."""
    cos_declination = math.cos(record.declination_rad)
    equatorial_x = cos_declination * math.cos(record.ra_rad)
    equatorial_y = cos_declination * math.sin(record.ra_rad)
    equatorial_z = math.sin(record.declination_rad)
    cos_obliquity = math.cos(J2000_OBLIQUITY_RAD)
    sin_obliquity = math.sin(J2000_OBLIQUITY_RAD)
    ecliptic_y = cos_obliquity * equatorial_y + sin_obliquity * equatorial_z
    ecliptic_z = -sin_obliquity * equatorial_y + cos_obliquity * equatorial_z
    red, green, blue = bv_to_rgb(record.bv)
    return (
        equatorial_x,
        ecliptic_y,
        ecliptic_z,
        record.visual_magnitude,
        red,
        green,
        blue,
    )


def build_payload(lines: list[str]) -> tuple[bytes, int]:
    """Pack source-ordered records into the raw little-endian Float32 payload."""
    payload = bytearray()
    previous_hr = 0
    star_count = 0
    for line in lines:
        record = parse_record(line)
        if record is None:
            continue
        if record.hr <= previous_hr:
            raise ValueError(
                f"catalog records must have strictly increasing HR ids; received {record.hr} after {previous_hr}"
            )
        payload.extend(struct.pack("<7f", *components_for_star(record)))
        previous_hr = record.hr
        star_count += 1
    return bytes(payload), star_count


def verify_and_decode_source(compressed: bytes) -> list[str]:
    """Verify the pinned compressed source before decoding its fixed-width lines."""
    actual_hash = hashlib.sha256(compressed).hexdigest()
    if actual_hash != SOURCE_SHA256:
        raise ValueError(
            f"source SHA-256 mismatch: expected {SOURCE_SHA256}, received {actual_hash}"
        )
    try:
        catalog_bytes = gzip.decompress(compressed)
        return catalog_bytes.decode("ascii").splitlines()
    except (gzip.BadGzipFile, UnicodeDecodeError) as error:
        raise ValueError("pinned Yale catalog is not valid ASCII gzip data") from error


def download_source(url: str) -> bytes:
    """Download the pinned source with an explicit maintained CA bundle."""
    try:
        import certifi
    except ImportError as error:
        raise RuntimeError(
            "certifi is required for network bakes; install tools/requirements-stars.txt"
        ) from error

    context = ssl.create_default_context(cafile=certifi.where())
    request = Request(url, headers={"User-Agent": "SolarVoyager-star-bake/1"})
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


def bake_catalog(compressed: bytes) -> tuple[bytes, int]:
    """Validate and convert the complete pinned catalog."""
    lines = verify_and_decode_source(compressed)
    if len(lines) != EXPECTED_SOURCE_RECORDS:
        raise ValueError(
            f"expected {EXPECTED_SOURCE_RECORDS} Yale records, received {len(lines)}"
        )
    payload, star_count = build_payload(lines)
    if star_count != EXPECTED_STAR_COUNT:
        raise ValueError(f"expected {EXPECTED_STAR_COUNT} stars, emitted {star_count}")
    expected_bytes = EXPECTED_STAR_COUNT * BYTES_PER_STAR
    if len(payload) != expected_bytes:
        raise ValueError(f"expected {expected_bytes} payload bytes, emitted {len(payload)}")
    return payload, star_count


def parse_args() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="local pinned catalog.gz")
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "stars.bin",
        help="output binary path",
    )
    parser.add_argument("--url", default=SOURCE_URL, help="catalog URL")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    compressed = args.source.read_bytes() if args.source else download_source(args.url)
    payload, star_count = bake_catalog(compressed)
    atomic_write_bytes(args.output, payload)
    print(f"Source SHA-256: {hashlib.sha256(compressed).hexdigest()}")
    print(f"Baked {star_count:,} stars into {len(payload):,} bytes")
    print(f"Output SHA-256: {hashlib.sha256(payload).hexdigest()}")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
