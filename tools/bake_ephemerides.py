"""Bake the Solar Voyager J2026 body catalog from JPL Horizons data."""

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import shutil
from typing import Any, Dict, List, Mapping, Optional, Sequence


AU_KM = 149_597_870.7
DAY_SEC = 86_400.0
EPOCH_JD_TDB = 2_461_041.5
CHECK_OFFSETS_DAYS = (0, 30, 365)
FRAME = "heliocentric-ecliptic-j2000"


@dataclass(frozen=True)
class BodyDefinition:
    id: str
    name: str
    kind: str
    horizons_id: int
    parent_id: Optional[str]
    mu_km3_s2: float
    mean_radius_km: float
    sidereal_rotation_period_sec: float
    axial_tilt_rad: float
    geometric_albedo: float
    surface_kind: str
    albedo_color: str
    procedural_seed: int
    horizons_id_type: Optional[str] = None


def _days(value: float) -> float:
    return value * DAY_SEC


def _hours(value: float) -> float:
    return value * 3_600.0


# Physical metadata: JPL Solar System Dynamics planetary satellite/physical
# parameters and NASA planetary fact sheets. Query-derived orbital values never
# come from this table.
BODY_DEFINITIONS = (
    BodyDefinition("sun", "Sun", "star", 10, None, 132_712_440_041.9394, 695_700.0, _days(25.05), math.radians(7.25), 1.0, "stellar", "#fff4d6", 10),
    BodyDefinition("mercury", "Mercury", "planet", 199, "sun", 22_031.86855, 2_439.7, _days(58.646), math.radians(0.034), 0.142, "solid", "#aaa39a", 199),
    BodyDefinition("venus", "Venus", "planet", 299, "sun", 324_858.592, 6_051.8, _days(-243.025), math.radians(177.36), 0.689, "solid", "#d9b36c", 299),
    BodyDefinition("earth", "Earth", "planet", 399, "sun", 398_600.435507, 6_371.0084, _days(0.99726968), math.radians(23.439281), 0.434, "solid", "#4f78a8", 399),
    BodyDefinition("moon", "Moon", "moon", 301, "earth", 4_902.800118, 1_737.4, _days(27.321661), math.radians(6.68), 0.12, "solid", "#aaa8a3", 301),
    BodyDefinition("mars", "Mars", "planet", 499, "sun", 42_828.375214, 3_389.5, _days(1.02595675), math.radians(25.19), 0.17, "solid", "#b85c3b", 499),
    BodyDefinition("phobos", "Phobos", "moon", 401, "mars", 0.0007087, 11.08, _days(0.31891023), 0.0, 0.071, "solid", "#8c8175", 401),
    BodyDefinition("deimos", "Deimos", "moon", 402, "mars", 0.0000962, 6.2, _days(1.26244), 0.0, 0.068, "solid", "#9b9185", 402),
    BodyDefinition("jupiter", "Jupiter", "planet", 599, "sun", 126_686_534.911, 69_911.0, _days(0.41354), math.radians(3.13), 0.538, "gas", "#c9a477", 599),
    BodyDefinition("io", "Io", "moon", 501, "jupiter", 5_959.91547, 1_821.49, _days(1.769137786), 0.0, 0.63, "solid", "#d8c35a", 501),
    BodyDefinition("europa", "Europa", "moon", 502, "jupiter", 3_202.71210, 1_560.80, _days(3.551181), 0.0, 0.67, "solid", "#c7b89a", 502),
    BodyDefinition("ganymede", "Ganymede", "moon", 503, "jupiter", 9_887.83275, 2_631.20, _days(7.154553), 0.0, 0.43, "solid", "#8f8170", 503),
    BodyDefinition("callisto", "Callisto", "moon", 504, "jupiter", 7_179.28340, 2_410.30, _days(16.689018), 0.0, 0.22, "solid", "#69645f", 504),
    BodyDefinition("saturn", "Saturn", "planet", 699, "sun", 37_931_207.8, 58_232.0, _days(0.44401), math.radians(26.73), 0.499, "gas", "#d8c28e", 699),
    BodyDefinition("mimas", "Mimas", "moon", 601, "saturn", 2.50349, 198.20, _days(0.9424218), 0.0, 0.962, "solid", "#bdbbb4", 601),
    BodyDefinition("enceladus", "Enceladus", "moon", 602, "saturn", 7.21037, 252.10, _days(1.370218), 0.0, 1.0, "solid", "#e5e6e3", 602),
    BodyDefinition("tethys", "Tethys", "moon", 603, "saturn", 41.21353, 531.10, _days(1.887802), 0.0, 0.80, "solid", "#c8c5bd", 603),
    BodyDefinition("dione", "Dione", "moon", 604, "saturn", 73.11607, 561.40, _days(2.736915), 0.0, 0.99, "solid", "#c6c4be", 604),
    BodyDefinition("rhea", "Rhea", "moon", 605, "saturn", 153.94175, 763.50, _days(4.518212), 0.0, 0.949, "solid", "#aaa9a4", 605),
    BodyDefinition("titan", "Titan", "moon", 606, "saturn", 8_978.13710, 2_574.76, _days(15.945421), 0.0, 0.22, "solid", "#c68d42", 606),
    BodyDefinition("iapetus", "Iapetus", "moon", 608, "saturn", 120.51511, 734.30, _days(79.3215), 0.0, 0.05, "solid", "#77736d", 608),
    BodyDefinition("uranus", "Uranus", "planet", 799, "sun", 5_793_951.322, 25_362.0, _days(-0.71833), math.radians(97.77), 0.488, "gas", "#9ccbd3", 799),
    BodyDefinition("miranda", "Miranda", "moon", 705, "uranus", 4.3, 235.8, _days(1.413479), 0.0, 0.32, "solid", "#a9a6a0", 705),
    BodyDefinition("ariel", "Ariel", "moon", 701, "uranus", 83.5, 578.9, _days(2.520379), 0.0, 0.39, "solid", "#b8b6ae", 701),
    BodyDefinition("umbriel", "Umbriel", "moon", 702, "uranus", 85.1, 584.7, _days(4.144177), 0.0, 0.21, "solid", "#77746f", 702),
    BodyDefinition("titania", "Titania", "moon", 703, "uranus", 226.9, 788.9, _days(8.705872), 0.0, 0.27, "solid", "#a5a29b", 703),
    BodyDefinition("oberon", "Oberon", "moon", 704, "uranus", 205.3, 761.4, _days(13.463239), 0.0, 0.23, "solid", "#8e8981", 704),
    BodyDefinition("neptune", "Neptune", "planet", 899, "sun", 6_835_099.5, 24_622.0, _days(0.67125), math.radians(28.32), 0.442, "gas", "#4169a9", 899),
    BodyDefinition("triton", "Triton", "moon", 801, "neptune", 1_428.49546, 1_352.60, _days(-5.876854), 0.0, 0.76, "solid", "#b7aca3", 801),
    BodyDefinition("pluto", "Pluto", "dwarf", 999, "sun", 869.3, 1_188.3, _days(-6.3872), math.radians(122.53), 0.3, "solid", "#b7a28c", 999),
    BodyDefinition("charon", "Charon", "moon", 901, "pluto", 106.1, 606.0, _days(6.3872), 0.0, 0.38, "solid", "#8f8b87", 901),
    BodyDefinition("ceres", "Ceres", "dwarf", 1, "sun", 62.6284, 469.7, _hours(9.074170), math.radians(4.0), 0.090, "solid", "#77736d", 1, "smallbody"),
    BodyDefinition("eris", "Eris", "dwarf", 136_199, "sun", 1_107.9338, 1_200.0, _days(1.079), 0.0, 0.84, "solid", "#d8d4cd", 136_199, "smallbody"),
    BodyDefinition("makemake", "Makemake", "dwarf", 136_472, "sun", 206.9033, 714.0, _days(0.937), 0.0, 0.81, "solid", "#c5a58d", 136_472, "smallbody"),
    BodyDefinition("haumea", "Haumea", "dwarf", 136_108, "sun", 267.339, 715.0, _days(0.1631), 0.0, 0.72, "solid", "#d8d5cf", 136_108, "smallbody"),
    BodyDefinition("vesta", "Vesta", "asteroid", 4, "sun", 17.2882844, 261.385, _hours(5.3421276322), math.radians(27.5), 0.4228, "solid", "#9b9184", 4, "smallbody"),
    BodyDefinition("pallas", "Pallas", "asteroid", 2, "sun", 13.63, 256.5, _hours(7.8132214), math.radians(84.0), 0.155, "solid", "#85817b", 2, "smallbody"),
    BodyDefinition("hygiea", "Hygiea", "asteroid", 10, "sun", 7.0, 203.56, _hours(13.828), 0.0, 0.0717, "solid", "#66625f", 10_001, "smallbody"),
    BodyDefinition("eros", "Eros", "asteroid", 433, "sun", 4.463e-4, 8.42, _hours(5.27), 0.0, 0.25, "solid", "#9a7b68", 433, "smallbody"),
    BodyDefinition("bennu", "Bennu", "asteroid", 101_955, "sun", 4.8904e-9, 0.24222, _hours(4.296061), math.radians(177.6), 0.044, "solid", "#343230", 101_955, "smallbody"),
    BodyDefinition("ryugu", "Ryugu", "asteroid", 162_173, "sun", 3.00e-8, 0.448, _hours(7.63262), math.radians(171.6), 0.045, "solid", "#3d3935", 162_173, "smallbody"),
    BodyDefinition("1p", "1P/Halley", "comet", 90_000_030, "sun", 1.47e-5, 5.5, _hours(52.8), 0.0, 0.04, "solid", "#6f716d", 90_000_030),
    BodyDefinition("67p", "67P/Churyumov-Gerasimenko", "comet", 90_000_702, "sun", 6.622e-7, 1.7, _hours(12.76129), 0.0, 0.06, "solid", "#4f4c47", 90_000_702),
)

BODY_IDS = [definition.id for definition in BODY_DEFINITIONS]
DEFINITION_BY_ID = {definition.id: definition for definition in BODY_DEFINITIONS}


def _finite_values(row: Mapping[str, Any], keys: Sequence[str]) -> List[float]:
    available_keys = getattr(row, "colnames", row)
    missing = [key for key in keys if key not in available_keys]
    if missing:
        raise ValueError(f"missing Horizons columns: {', '.join(missing)}")
    values = [float(row[key]) for key in keys]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Horizons row values must be finite")
    return values


def elements_from_row(row: Mapping[str, Any]) -> Dict[str, float]:
    """Convert a Horizons element row from AU/degrees to km/radians."""
    a_au, eccentricity, inclination_deg, node_deg, periapsis_deg, mean_deg = _finite_values(
        row, ("a", "e", "incl", "Omega", "w", "M")
    )
    if not (
        (a_au > 0 and 0 <= eccentricity < 1)
        or (a_au < 0 and eccentricity > 1)
    ):
        raise ValueError(
            f"invalid Kepler branch: a={a_au} AU, eccentricity={eccentricity}"
        )
    return {
        "semiMajorAxisKm": a_au * AU_KM,
        "eccentricity": eccentricity,
        "inclinationRad": math.radians(inclination_deg),
        "longitudeAscendingNodeRad": math.radians(node_deg),
        "argumentPeriapsisRad": math.radians(periapsis_deg),
        "meanAnomalyRad": math.radians(mean_deg),
    }


def state_from_row(row: Mapping[str, Any]) -> Dict[str, List[float]]:
    """Convert a Horizons vector row from AU and AU/day to game units."""
    x, y, z, vx, vy, vz = _finite_values(row, ("x", "y", "z", "vx", "vy", "vz"))
    velocity_scale = AU_KM / DAY_SEC
    return {
        "positionKm": [x * AU_KM, y * AU_KM, z * AU_KM],
        "velocityKmS": [vx * velocity_scale, vy * velocity_scale, vz * velocity_scale],
    }


def sphere_of_influence_km(
    semi_major_axis_km: float, child_mu_km3_s2: float, parent_mu_km3_s2: float
) -> float:
    """Compute |a|*(m/M)^(2/5); the GM ratio equals the mass ratio."""
    return abs(semi_major_axis_km) * (
        child_mu_km3_s2 / parent_mu_km3_s2
    ) ** (2.0 / 5.0)


def build_catalog(elements_by_id: Mapping[str, Mapping[str, float]]) -> Dict[str, Any]:
    bodies: List[Dict[str, Any]] = []
    for definition in BODY_DEFINITIONS:
        elements = None if definition.parent_id is None else dict(elements_by_id[definition.id])
        soi_radius_km = None
        if elements is not None:
            parent = DEFINITION_BY_ID[definition.parent_id]
            soi_radius_km = sphere_of_influence_km(
                elements["semiMajorAxisKm"], definition.mu_km3_s2, parent.mu_km3_s2
            )
        bodies.append(
            {
                "id": definition.id,
                "name": definition.name,
                "kind": definition.kind,
                "horizonsId": definition.horizons_id,
                "parentId": definition.parent_id,
                "muKm3S2": definition.mu_km3_s2,
                "meanRadiusKm": definition.mean_radius_km,
                "siderealRotationPeriodSec": definition.sidereal_rotation_period_sec,
                "axialTiltRad": definition.axial_tilt_rad,
                "geometricAlbedo": definition.geometric_albedo,
                "soiRadiusKm": soi_radius_km,
                "elements": elements,
                "surface": {"kind": definition.surface_kind, "atmosphereTopKm": None},
                "visual": {
                    "albedoColor": definition.albedo_color,
                    "assetRef": None,
                    "proceduralSeed": definition.procedural_seed,
                },
            }
        )
    return {
        "schemaVersion": 1,
        "epoch": {"name": "J2026", "jdTdb": EPOCH_JD_TDB},
        "frame": FRAME,
        "bodies": bodies,
    }


def build_checks(vectors_by_id: Mapping[str, Sequence[Mapping[str, List[float]]]]) -> Dict[str, Any]:
    samples: List[Dict[str, Any]] = []
    for sample_index, offset_days in enumerate(CHECK_OFFSETS_DAYS):
        states: Dict[str, Any] = {}
        for body_id in BODY_IDS:
            if body_id == "sun":
                states[body_id] = {
                    "positionKm": [0.0, 0.0, 0.0],
                    "velocityKmS": [0.0, 0.0, 0.0],
                }
            else:
                states[body_id] = dict(vectors_by_id[body_id][sample_index])
        samples.append(
            {
                "offsetDays": offset_days,
                "jdTdb": EPOCH_JD_TDB + offset_days,
                "states": states,
            }
        )
    return {"schemaVersion": 1, "frame": FRAME, "samples": samples}


def query_body(
    definition: BodyDefinition, horizons_factory: Any = None, cache: bool = True
) -> Any:
    """Query one body's epoch elements and three heliocentric check vectors."""
    if horizons_factory is None:
        from astroquery.jplhorizons import Horizons

        horizons_factory = Horizons

    parent = DEFINITION_BY_ID[definition.parent_id]
    element_center = (
        "500@10" if definition.parent_id == "sun" else f"500@{parent.horizons_id}"
    )
    element_query = horizons_factory(
        id=str(definition.horizons_id),
        id_type=definition.horizons_id_type,
        location=element_center,
        epochs=EPOCH_JD_TDB,
    )
    element_rows = element_query.elements(refplane="ecliptic", cache=cache)
    if len(element_rows) != 1:
        raise ValueError(f"expected one element row, received {len(element_rows)}")
    _validate_row_epoch(element_rows[0], EPOCH_JD_TDB, "element row")

    vector_epochs = [EPOCH_JD_TDB + offset for offset in CHECK_OFFSETS_DAYS]
    vector_query = horizons_factory(
        id=str(definition.horizons_id),
        id_type=definition.horizons_id_type,
        location="500@10",
        epochs=vector_epochs,
    )
    vector_rows = vector_query.vectors(refplane="ecliptic", cache=cache)
    if len(vector_rows) != len(CHECK_OFFSETS_DAYS):
        raise ValueError(
            f"expected {len(CHECK_OFFSETS_DAYS)} vector rows, received {len(vector_rows)}"
        )
    for index, (row, offset_days) in enumerate(zip(vector_rows, CHECK_OFFSETS_DAYS)):
        _validate_row_epoch(row, EPOCH_JD_TDB + offset_days, f"vector row {index}")
    return elements_from_row(element_rows[0]), [state_from_row(row) for row in vector_rows]


def _validate_row_epoch(row: Mapping[str, Any], expected_jd: float, label: str) -> None:
    actual_jd = _finite_values(row, ("datetime_jd",))[0]
    if not math.isclose(actual_jd, expected_jd, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError(f"{label} epoch {actual_jd} does not match requested {expected_jd}")


def _serialized_json(document: Mapping[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def _write_utf8_text(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as output:
        output.write(content)


def atomic_write_json(path: Path, document: Mapping[str, Any]) -> None:
    """Write deterministic JSON to a sibling temporary file, then replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = Path(f"{path}.tmp")
    try:
        _write_utf8_text(temporary_path, _serialized_json(document))
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _publish_json_pair(
    catalog_path: Path,
    catalog: Mapping[str, Any],
    checks_path: Path,
    checks: Mapping[str, Any],
) -> None:
    """Publish a consistent pair, rolling both files back on a replace failure."""
    paths = (catalog_path, checks_path)
    documents = (catalog, checks)
    temporary_paths = tuple(Path(f"{path}.tmp") for path in paths)
    backup_paths = tuple(Path(f"{path}.bak") for path in paths)
    existed = tuple(path.exists() for path in paths)
    published = [False, False]
    preserve_backup = [False, False]

    try:
        for temporary_path, document in zip(temporary_paths, documents):
            _write_utf8_text(temporary_path, _serialized_json(document))
        for path, backup_path, path_existed in zip(paths, backup_paths, existed):
            if path_existed:
                shutil.copyfile(path, backup_path)
        for index, (temporary_path, path) in enumerate(zip(temporary_paths, paths)):
            os.replace(temporary_path, path)
            published[index] = True
    except Exception as publish_error:
        rollback_failures = []
        for index, (path, backup_path, path_existed) in enumerate(
            zip(paths, backup_paths, existed)
        ):
            if not published[index]:
                continue
            try:
                if path_existed:
                    os.replace(backup_path, path)
                else:
                    path.unlink(missing_ok=True)
            except Exception as rollback_error:
                preserve_backup[index] = path_existed and backup_path.exists()
                rollback_failures.append(f"{path}: {rollback_error}")
        if rollback_failures:
            recovery_paths = [
                str(backup_paths[index])
                for index, preserve in enumerate(preserve_backup)
                if preserve
            ]
            raise RuntimeError(
                "publication failed and rollback failed; "
                f"recovery backups preserved at {', '.join(recovery_paths)}; "
                f"rollback errors: {'; '.join(rollback_failures)}"
            ) from publish_error
        raise
    finally:
        for working_path in temporary_paths:
            working_path.unlink(missing_ok=True)
        for index, backup_path in enumerate(backup_paths):
            if not preserve_backup[index]:
                backup_path.unlink(missing_ok=True)


def _load_existing(output_dir: Path) -> Any:
    catalog_path = output_dir / "bodies.json"
    checks_path = output_dir / "ephemerides-check.json"
    if not catalog_path.exists() or not checks_path.exists():
        raise ValueError("partial bake requires existing bodies.json and ephemerides-check.json")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    checks = json.loads(checks_path.read_text(encoding="utf-8"))
    elements_by_id = {
        body["id"]: body["elements"]
        for body in catalog["bodies"]
        if body["id"] != "sun"
    }
    vectors_by_id = {
        body_id: [sample["states"][body_id] for sample in checks["samples"]]
        for body_id in BODY_IDS
        if body_id != "sun"
    }
    return elements_by_id, vectors_by_id


def bake(
    output_dir: Path,
    selected_ids: Optional[Sequence[str]] = None,
    cache: bool = True,
    query_function: Any = query_body,
    horizons_factory: Any = None,
) -> Any:
    """Query all selected bodies, then atomically publish both documents."""
    output_dir = Path(output_dir)
    query_ids = [body_id for body_id in (selected_ids or BODY_IDS) if body_id != "sun"]
    full_bake = selected_ids is None or set(selected_ids) == set(BODY_IDS)
    if full_bake:
        elements_by_id: Dict[str, Any] = {}
        vectors_by_id: Dict[str, Any] = {}
    else:
        elements_by_id, vectors_by_id = _load_existing(output_dir)

    for body_id in query_ids:
        if body_id not in DEFINITION_BY_ID:
            raise ValueError(f"unknown body id: {body_id}")
        definition = DEFINITION_BY_ID[body_id]
        try:
            elements, vectors = query_function(definition, horizons_factory, cache)
        except Exception as error:
            raise RuntimeError(f"{body_id} Horizons query failed: {error}") from error
        elements_by_id[body_id] = elements
        vectors_by_id[body_id] = vectors

    catalog = build_catalog(elements_by_id)
    checks = build_checks(vectors_by_id)
    catalog_path = output_dir / "bodies.json"
    checks_path = output_dir / "ephemerides-check.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    _publish_json_pair(catalog_path, catalog, checks_path, checks)
    return catalog, checks


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only",
        action="append",
        choices=BODY_IDS,
        dest="selected_ids",
        help="replace one body in existing outputs; repeat for multiple bodies",
    )
    parser.add_argument("--no-cache", action="store_true", help="bypass Astroquery cache")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data",
        help="directory for bodies.json and ephemerides-check.json",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    catalog, checks = bake(
        args.output_dir,
        selected_ids=args.selected_ids,
        cache=not args.no_cache,
    )
    print(
        f"Baked {len(catalog['bodies'])} bodies and {len(checks['samples'])} check epochs "
        f"to {args.output_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
