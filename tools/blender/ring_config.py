"""Pure Blender-free configuration for the four ringed giant builders."""

import json
import math
from pathlib import Path
from typing import NamedTuple, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
RINGS_PATH = REPOSITORY_ROOT / "data" / "rings.json"
MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
TEXTURES_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"
RINGED_PLANET_IDS = frozenset(("jupiter", "saturn", "uranus", "neptune"))


class SourceFile(NamedTuple):
    role: str
    path: Path
    output_name: str


class RingPlanetConfig(NamedTuple):
    body_id: str
    name: str
    category: str
    output_dir: Path
    procedural_seed: int
    polar_radius_ratio: float
    reference_radius_km: float
    inner_radius_ratio: float
    outer_radius_ratio: float
    angular_segments: int
    radial_segments: int
    surface_material_name: str
    ring_material_name: str
    source_files: Tuple[SourceFile, ...]


def _load_document(path, schema_version, label):
    resolved = Path(path).resolve()
    with resolved.open("r", encoding="utf-8") as stream:
        document = json.load(stream)
    if document.get("schemaVersion") != schema_version:
        raise ValueError(f"{label} requires schemaVersion {schema_version}: {resolved}")
    return document


def _single(items, key, value, label):
    matches = [item for item in items if item.get(key) == value]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one {label} "{value}"')
    return matches[0]


def _positive_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{label} must be positive and finite")
    return result


def ring_planet_config(
    body_id,
    *,
    catalog_path=CATALOG_PATH,
    rings_path=RINGS_PATH,
    models_root=MODELS_ROOT,
    textures_root=TEXTURES_ROOT,
):
    """Resolve a validated authoring contract for one ringed giant."""
    if body_id not in RINGED_PLANET_IDS:
        raise ValueError(f'unknown ringed planet "{body_id}"')
    catalog = _load_document(catalog_path, 2, "Ringed planet builders")
    body = _single(catalog.get("bodies", ()), "id", body_id, "catalog body")
    if body.get("kind") != "planet":
        raise ValueError(f'Ringed body "{body_id}" must be a planet')
    rings = _load_document(rings_path, 1, "Ringed planet builders")
    system = _single(rings.get("systems", ()), "bodyId", body_id, "ring system")

    reference_radius = _positive_number(system.get("referenceRadiusKm"), "referenceRadiusKm")
    inner_radius = _positive_number(system.get("innerRadiusKm"), "innerRadiusKm")
    outer_radius = _positive_number(system.get("outerRadiusKm"), "outerRadiusKm")
    if not inner_radius < outer_radius:
        raise ValueError(f'Ring system "{body_id}" must have increasing radii')

    visual = body.get("visual", {})
    polar_ratio = _positive_number(visual.get("polarRadiusRatio"), "polarRadiusRatio")
    if polar_ratio > 1:
        raise ValueError(f'Ringed body "{body_id}" polarRadiusRatio must be <= 1')
    seed = visual.get("proceduralSeed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError(f'Ringed body "{body_id}" has invalid proceduralSeed')

    source_dir = Path(textures_root).resolve() / body_id
    source_files = (
        SourceFile("planet albedo", source_dir / f"{body_id}_albedo.jpg", f"{body_id}_albedo.jpg"),
        SourceFile(
            "detail albedo",
            source_dir / f"{body_id}_detail_albedo.jpg",
            f"{body_id}_detail_albedo.jpg",
        ),
        SourceFile(
            "detail normal",
            source_dir / f"{body_id}_detail_normal.png",
            f"{body_id}_detail_normal.png",
        ),
        SourceFile("ring texture", source_dir / f"{body_id}_rings.png", f"{body_id}_rings.png"),
        SourceFile("provenance", source_dir / "SOURCES.md", "SOURCES.md"),
    )
    for source in source_files:
        if not source.path.is_file():
            raise FileNotFoundError(
                f'Missing source for ringed planet "{body_id}": '
                f"{source.role} {source.path.name}"
            )

    return RingPlanetConfig(
        body_id=body_id,
        name=str(body.get("name", body_id)),
        category="planets",
        output_dir=Path(models_root).resolve() / "planets" / body_id,
        procedural_seed=seed,
        polar_radius_ratio=polar_ratio,
        reference_radius_km=reference_radius,
        inner_radius_ratio=inner_radius / reference_radius,
        outer_radius_ratio=outer_radius / reference_radius,
        angular_segments=256,
        radial_segments=4,
        surface_material_name="mat_surface",
        ring_material_name="mat_rings",
        source_files=source_files,
    )
