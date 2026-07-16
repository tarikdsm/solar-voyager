"""Bake the Solar Voyager J2026 body catalog from JPL Horizons data."""

from dataclasses import dataclass
import math
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


def _days(value: float) -> float:
    return value * DAY_SEC


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
    BodyDefinition("jupiter", "Jupiter", "planet", 599, "sun", 126_686_534.911, 69_911.0, _days(0.41354), math.radians(3.13), 0.538, "gas", "#c9a477", 599),
    BodyDefinition("saturn", "Saturn", "planet", 699, "sun", 37_931_207.8, 58_232.0, _days(0.44401), math.radians(26.73), 0.499, "gas", "#d8c28e", 699),
    BodyDefinition("uranus", "Uranus", "planet", 799, "sun", 5_793_951.322, 25_362.0, _days(-0.71833), math.radians(97.77), 0.488, "gas", "#9ccbd3", 799),
    BodyDefinition("neptune", "Neptune", "planet", 899, "sun", 6_835_099.5, 24_622.0, _days(0.67125), math.radians(28.32), 0.442, "gas", "#4169a9", 899),
)

BODY_IDS = [definition.id for definition in BODY_DEFINITIONS]
DEFINITION_BY_ID = {definition.id: definition for definition in BODY_DEFINITIONS}


def _finite_values(row: Mapping[str, Any], keys: Sequence[str]) -> List[float]:
    missing = [key for key in keys if key not in row]
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
    """Compute a*(m/M)^(2/5); the GM ratio equals the mass ratio."""
    return semi_major_axis_km * (child_mu_km3_s2 / parent_mu_km3_s2) ** (2.0 / 5.0)


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
