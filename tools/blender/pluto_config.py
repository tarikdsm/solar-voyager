"""Pure catalog and file configuration for the Pluto builder."""

import json
import math
from pathlib import Path
from typing import NamedTuple, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
TEXTURES_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"
SOURCE_MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"


class PublishFile(NamedTuple):
    role: str
    source_path: Path
    output_name: str


class PlutoConfig(NamedTuple):
    body_id: str
    name: str
    category: str
    output_dir: Path
    procedural_seed: int
    mean_radius_km: float
    polar_radius_ratio: float
    preview_albedo_path: Path
    publish_files: Tuple[PublishFile, ...]


def _load_body(body_id, catalog_path):
    with Path(catalog_path).resolve().open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    if catalog.get("schemaVersion") != 2:
        raise ValueError("Pluto builder requires body catalog schemaVersion 2")
    matches = [body for body in catalog.get("bodies", ()) if body.get("id") == body_id]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one body id "{body_id}"')
    return matches[0]


def _finite_positive(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and value > 0
    )


def pluto_config(
    body_id="pluto",
    catalog_path=CATALOG_PATH,
    models_root=MODELS_ROOT,
    textures_root=TEXTURES_ROOT,
    source_models_root=SOURCE_MODELS_ROOT,
):
    body = _load_body(body_id, catalog_path)
    if body.get("kind") != "dwarf":
        raise ValueError(f'Body "{body_id}" is not a dwarf')
    if body_id != "pluto":
        raise ValueError(f'Body "{body_id}" does not have an implemented Pluto texture contract')

    radius = body.get("meanRadiusKm")
    visual = body.get("visual", {})
    ratio = visual.get("polarRadiusRatio")
    seed = visual.get("proceduralSeed")
    if not _finite_positive(radius):
        raise ValueError(f'Body "{body_id}" has invalid meanRadiusKm')
    if not _finite_positive(ratio) or ratio > 1.0:
        raise ValueError(f'Body "{body_id}" has invalid polarRadiusRatio')
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError(f'Body "{body_id}" has invalid proceduralSeed')

    texture_dir = Path(textures_root).resolve() / body_id
    source_dir = Path(source_models_root).resolve() / "dwarfs" / body_id
    albedo = texture_dir / "2k_pluto.jpg"
    preview = texture_dir / "4k_pluto.jpg"
    if not preview.is_file():
        preview = albedo
    publish_files = (
        PublishFile("albedo", albedo, "pluto_albedo.jpg"),
        PublishFile("detail_albedo", source_dir / "pluto_detail_albedo.jpg", "pluto_detail_albedo.jpg"),
        PublishFile("detail_normal", source_dir / "pluto_detail_normal.png", "pluto_detail_normal.png"),
        PublishFile("provenance", source_dir / "SOURCES.md", "SOURCES.md"),
    )
    required = (preview, *(item.source_path for item in publish_files))
    missing = sorted({path.name for path in required if not path.is_file()})
    if missing:
        raise FileNotFoundError(
            f'Missing source files for Pluto "{body_id}": {", ".join(missing)}'
        )

    return PlutoConfig(
        body_id=body_id,
        name=str(body.get("name", body_id)),
        category="dwarfs",
        output_dir=Path(models_root).resolve() / "dwarfs" / body_id,
        procedural_seed=seed,
        mean_radius_km=float(radius),
        polar_radius_ratio=float(ratio),
        preview_albedo_path=preview,
        publish_files=publish_files,
    )
