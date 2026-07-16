"""Pure catalog and texture configuration for parameterized planet builders."""

import json
import math
from pathlib import Path
from typing import NamedTuple, Optional, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
TEXTURES_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"


class TextureSpec(NamedTuple):
    role: str
    source_path: Path
    output_name: str
    resize_to: Optional[Tuple[int, int]] = None


class PlanetConfig(NamedTuple):
    body_id: str
    name: str
    category: str
    output_dir: Path
    procedural_seed: int
    polar_radius_ratio: float
    textures: Tuple[TextureSpec, ...]


EARTH_TEXTURE_SPECS = (
    ("albedo", "earth_albedo.png", "earth_albedo.png", None),
    ("normal", "8k_earth_normal_map.tif", "earth_normal.png", (4096, 2048)),
    ("emissive", "8k_earth_nightmap.jpg", "earth_emissive_night.jpg", None),
    ("clouds", "8k_earth_clouds.jpg", "earth_clouds.jpg", None),
)


def _load_body(body_id, catalog_path):
    catalog_path = Path(catalog_path).resolve()
    with catalog_path.open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    if catalog.get("schemaVersion") != 2:
        raise ValueError(f"Planet builders require body catalog schemaVersion 2: {catalog_path}")
    matches = [body for body in catalog.get("bodies", ()) if body.get("id") == body_id]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one body id "{body_id}" in {catalog_path}')
    return matches[0]


def _polar_radius_ratio(body):
    ratio = body.get("visual", {}).get("polarRadiusRatio")
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)):
        raise ValueError(f'Body "{body.get("id", "<unknown>")}" has invalid polarRadiusRatio')
    ratio = float(ratio)
    if not math.isfinite(ratio) or not 0.0 < ratio <= 1.0:
        raise ValueError(f'Body "{body["id"]}" has invalid polarRadiusRatio {ratio}')
    return ratio


def planet_config(
    body_id,
    catalog_path=CATALOG_PATH,
    models_root=MODELS_ROOT,
    textures_root=TEXTURES_ROOT,
):
    """Resolve a validated, Blender-free authoring contract for one planet."""
    body = _load_body(body_id, catalog_path)
    if body.get("kind") != "planet":
        raise ValueError(f'Body "{body_id}" is not a planet')
    if body_id != "earth":
        raise ValueError(f'Body "{body_id}" does not have an implemented planet texture contract')

    source_dir = Path(textures_root).resolve() / body_id
    textures = tuple(
        TextureSpec(role, source_dir / source_name, output_name, resize_to)
        for role, source_name, output_name, resize_to in EARTH_TEXTURE_SPECS
    )
    missing = [texture.source_path.name for texture in textures if not texture.source_path.is_file()]
    if missing:
        raise FileNotFoundError(
            f'Missing texture role files for planet "{body_id}": {", ".join(missing)}'
        )

    seed = body.get("visual", {}).get("proceduralSeed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError(f'Body "{body_id}" has invalid proceduralSeed')

    return PlanetConfig(
        body_id=body_id,
        name=str(body.get("name", body_id)),
        category="planets",
        output_dir=Path(models_root).resolve() / "planets" / body_id,
        procedural_seed=seed,
        polar_radius_ratio=_polar_radius_ratio(body),
        textures=textures,
    )
