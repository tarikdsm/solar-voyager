"""Pure catalog and texture configuration for the Moon builder."""

import json
import math
from pathlib import Path
from typing import NamedTuple, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
TEXTURES_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"
RELIEF_RANGE_KM = 20.0


class TextureSpec(NamedTuple):
    role: str
    source_path: Path
    output_name: str


class MoonConfig(NamedTuple):
    body_id: str
    name: str
    category: str
    output_dir: Path
    procedural_seed: int
    mean_radius_km: float
    relief_range_km: float
    textures: Tuple[TextureSpec, ...]


MOON_TEXTURE_SPECS = (
    ("albedo", "moon_albedo.jpg"),
    ("height", "moon_height.png"),
    ("normal", "moon_normal.png"),
    ("detail_albedo", "moon_detail_albedo.jpg"),
    ("detail_normal", "moon_detail_normal.png"),
)


def normalized_relief_radius(height_sample, mean_radius_km, relief_range_km):
    sample = float(height_sample)
    radius = float(mean_radius_km)
    relief = float(relief_range_km)
    if not math.isfinite(sample) or not 0.0 <= sample <= 1.0:
        raise ValueError("Moon height sample must be finite and in [0, 1]")
    if not math.isfinite(radius) or radius <= 0 or not math.isfinite(relief) or relief < 0:
        raise ValueError("Moon physical radius and relief range are invalid")
    return 1.0 - (1.0 - sample) * relief / radius


def _load_body(body_id, catalog_path):
    with Path(catalog_path).resolve().open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    if catalog.get("schemaVersion") != 2:
        raise ValueError("Moon builder requires body catalog schemaVersion 2")
    matches = [body for body in catalog.get("bodies", ()) if body.get("id") == body_id]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one body id "{body_id}"')
    return matches[0]


def moon_config(body_id="moon", catalog_path=CATALOG_PATH, models_root=MODELS_ROOT, textures_root=TEXTURES_ROOT):
    body = _load_body(body_id, catalog_path)
    if body.get("kind") != "moon":
        raise ValueError(f'Body "{body_id}" is not a moon')
    if body_id != "moon":
        raise ValueError(f'Body "{body_id}" does not have an implemented Moon texture contract')
    radius = body.get("meanRadiusKm")
    seed = body.get("visual", {}).get("proceduralSeed")
    if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
        raise ValueError(f'Body "{body_id}" has invalid meanRadiusKm')
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError(f'Body "{body_id}" has invalid proceduralSeed')

    source_dir = Path(textures_root).resolve() / body_id
    textures = tuple(
        TextureSpec(role, source_dir / source_name, source_name)
        for role, source_name in MOON_TEXTURE_SPECS
    )
    missing = [texture.source_path.name for texture in textures if not texture.source_path.is_file()]
    if missing:
        raise FileNotFoundError(f'Missing texture role files for moon "{body_id}": {", ".join(missing)}')
    return MoonConfig(
        body_id=body_id,
        name=str(body.get("name", body_id)),
        category="moons",
        output_dir=Path(models_root).resolve() / "moons" / body_id,
        procedural_seed=seed,
        mean_radius_km=float(radius),
        relief_range_km=RELIEF_RANGE_KM,
        textures=textures,
    )
