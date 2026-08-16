"""Catalog-driven authoring contract for asteroid and comet builders.

Pure Python (no Blender), so every rule here is unit-tested on the system
interpreter. Holds three things:

* the catalog identity checks both builders share;
* the authored procedural shape parameters (triaxial proportions, relief, crater
  budget) that `data/bodies.json` deliberately does not carry — adding them to the
  catalog would be a schema change and therefore an ADR;
* the published shape-model registry, which is the seam against
  `tools/fetch_textures.py`'s checksummed manifest (ADR-039).
"""

import json
import math
import re
from pathlib import Path
from typing import NamedTuple, Optional, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
# Where T0132's checksummed fetch manifest lands verified source bytes
# (`TextureRecipe.dest` = `assets/textures-src/<body_id>/<output_name>`); the
# directory is gitignored except for SOURCES.md, so shape models are never committed.
SHAPE_ROOT = REPOSITORY_ROOT / "assets" / "textures-src"

KIND_CATEGORIES = {"asteroid": "asteroids", "comet": "comets"}
TRIANGLE_LIMIT = 5_000
ALBEDO_WIDTH = 1024
ALBEDO_HEIGHT = 512
MAX_SEED = 0xFFFFFFFF

#: Frozen API consumed by T0139's coma/tail visuals. Do not rename.
COMA_ANCHOR_NAME = "coma_anchor"
TAIL_ANCHOR_NAME = "tail_anchor"
ANCHOR_NAMES = (COMA_ANCHOR_NAME, TAIL_ANCHOR_NAME)

_COLOR_PATTERN = re.compile(r"^#([0-9a-fA-F]{6})$")


class ShapeParameters(NamedTuple):
    """Authored relief for the procedural path, seeded by `proceduralSeed`."""

    relief: float
    crater_count: int
    crater_depth: float
    axis_ratios: Tuple[float, float, float]


class ComaParameters(NamedTuple):
    """Anchor magnitudes in nucleus radii, exported as node scale."""

    coma_radius_ratio: float
    tail_length_ratio: float


class ShapeModelSource(NamedTuple):
    """One published shape model.

    Field-compatible with `tools/fetch_textures.py`'s `TextureRecipe` (ADR-039),
    which grew `kind="file"` for exactly this case: non-image sources copied
    byte-for-byte after checksum verification. Every field here except `dataset`
    and `model_format` maps one-to-one onto a `TextureRecipe` keyword, and the
    fetched file lands at `TextureRecipe.dest`, which is what `resolve_shape_path`
    reconstructs.

    `source_url` and `sha256` are the two fields the fetch manifest owns, and both
    stay `None` until a `RECIPES` entry pins them. `validate_shape_source` refuses
    an unpinned entry, so the real-model path can never quietly degrade into the
    procedural one.
    """

    id: str
    body_id: str
    role: str
    source_url: Optional[str]
    product_url: str
    dataset: str
    license: str
    credit: str
    sha256: Optional[str]
    output_name: str
    model_format: str


class SmallBodyConfig(NamedTuple):
    body_id: str
    name: str
    kind: str
    category: str
    output_dir: Path
    procedural_seed: int
    mean_radius_km: float
    albedo_color: Tuple[float, float, float]
    albedo_name: str
    shape: ShapeParameters
    shape_model: Optional[ShapeModelSource]
    coma: Optional[ComaParameters]


# Authored silhouette proportions (longest axis = 1.0) and relief budgets. These
# approximate the published gross proportions of each body; T0138/T0139 refine
# them per body against the mission shape models when they author the assets.
DEFAULT_SHAPE = ShapeParameters(
    relief=0.14, crater_count=18, crater_depth=0.09, axis_ratios=(1.0, 0.92, 0.86)
)
SHAPE_PARAMETERS = {
    "vesta": ShapeParameters(0.10, 14, 0.13, (1.0, 0.97, 0.78)),
    "pallas": ShapeParameters(0.12, 16, 0.09, (1.0, 0.94, 0.87)),
    "hygiea": ShapeParameters(0.08, 12, 0.07, (1.0, 0.98, 0.96)),
    "eros": ShapeParameters(0.13, 20, 0.10, (1.0, 0.33, 0.33)),
    "bennu": ShapeParameters(0.09, 22, 0.06, (1.0, 0.95, 0.90)),
    "ryugu": ShapeParameters(0.08, 18, 0.06, (1.0, 1.0, 0.87)),
    "1p": ShapeParameters(0.15, 12, 0.08, (1.0, 0.53, 0.53)),
    "67p": ShapeParameters(0.18, 14, 0.11, (1.0, 0.80, 0.44)),
}

# Coma radius and tail length in nucleus radii. Authored magnitudes only: T0139
# owns activation (r_helio < 3 AU) and direction (anti-sunward with dust lag).
DEFAULT_COMA = ComaParameters(coma_radius_ratio=12.0, tail_length_ratio=600.0)
COMA_PARAMETERS = {
    "1p": ComaParameters(coma_radius_ratio=16.0, tail_length_ratio=900.0),
    "67p": ComaParameters(coma_radius_ratio=12.0, tail_length_ratio=450.0),
}

_PDS_SBN = "https://pds-smallbodies.astro.umd.edu/"
_PUBLIC_DOMAIN = "NASA/PDS Small Bodies Node — public domain (US Government work)"


def _shape_source(body_id, dataset, credit):
    return ShapeModelSource(
        id=f"{body_id}-shape",
        body_id=body_id,
        role="shape",
        # Copied from the matching kind="file" RECIPES entry in fetch_textures.py
        # once it is pinned and reviewed; see validate_shape_source.
        source_url=None,
        product_url=_PDS_SBN,
        dataset=dataset,
        license=_PUBLIC_DOMAIN,
        credit=credit,
        sha256=None,
        output_name=f"{body_id}_shape.obj",
        model_format="obj",
    )


SHAPE_MODEL_SOURCES = {
    "eros": _shape_source(
        "eros",
        "NEAR Shoemaker MSI/NLR-derived 433 Eros plate model, lowest published tier at or below "
        f"{TRIANGLE_LIMIT} facets",
        "433 Eros shape model: NASA/NEAR Shoemaker, archived at the PDS Small Bodies Node.",
    ),
    "bennu": _shape_source(
        "bennu",
        "OSIRIS-REx OLA/SPC-derived 101955 Bennu shape model, lowest published tier at or below "
        f"{TRIANGLE_LIMIT} facets",
        "101955 Bennu shape model: NASA/Goddard/University of Arizona, archived at the PDS Small Bodies Node.",
    ),
    "ryugu": _shape_source(
        "ryugu",
        "Hayabusa2 SFM/SPC-derived 162173 Ryugu shape model, lowest published tier at or below "
        f"{TRIANGLE_LIMIT} facets",
        "162173 Ryugu shape model: JAXA/University of Aizu and collaborators, archived at the PDS Small Bodies Node.",
    ),
    "67p": _shape_source(
        "67p",
        "Rosetta OSIRIS-derived 67P/Churyumov-Gerasimenko nucleus shape model, lowest published tier "
        f"at or below {TRIANGLE_LIMIT} facets",
        "67P/Churyumov-Gerasimenko nucleus shape model: ESA/Rosetta/DLR, archived at the PDS Small Bodies Node.",
    ),
}


def shape_model_source(body_id):
    """The published shape model for `body_id`, or None where no mission flew."""
    return SHAPE_MODEL_SOURCES.get(body_id)


def validate_shape_source(source):
    """Refuse a shape-model entry the fetch manifest has not pinned yet."""
    if source.source_url is None or source.sha256 is None:
        raise ValueError(
            f'Shape model "{source.id}" has no pinned download: add a kind="file" RECIPES entry in '
            "tools/fetch_textures.py (T0132/ADR-039) and copy its source_url and sha256 here before "
            "the real-model path can be used. Build with --shape procedural until then."
        )
    if not source.source_url.startswith("https://") or not source.product_url.startswith("https://"):
        raise ValueError(f'Shape model "{source.id}" download and product URLs must use HTTPS')
    digest = source.sha256
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f'Shape model "{source.id}" must pin a lowercase SHA-256')
    if source.model_format != "obj":
        raise ValueError(f'Shape model "{source.id}" must be Wavefront OBJ')
    return source


def resolve_shape_path(shape_root, source):
    """Local path of the fetched shape model under `shape_root/<body-id>/`."""
    root = Path(shape_root).resolve()
    if Path(source.output_name).name != source.output_name:
        raise ValueError(f'Shape model "{source.id}" output name escapes the shape root')
    resolved = (root / source.body_id / source.output_name).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f'Shape model "{source.id}" output escapes the shape root') from error
    return resolved


def _load_body(body_id, catalog_path):
    with Path(catalog_path).resolve().open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    if catalog.get("schemaVersion") != 2:
        raise ValueError("Small-body builders require body catalog schemaVersion 2")
    matches = [body for body in catalog.get("bodies", ()) if body.get("id") == body_id]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one body id "{body_id}"')
    return matches[0]


def _albedo_color(body_id, visual):
    value = visual.get("albedoColor")
    match = _COLOR_PATTERN.match(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError(f'Body "{body_id}" has an invalid visual.albedoColor: {value!r}')
    digits = match.group(1)
    return tuple(int(digits[offset : offset + 2], 16) / 255.0 for offset in (0, 2, 4))


def small_body_config(
    body_id,
    expected_kind=None,
    catalog_path=CATALOG_PATH,
    models_root=MODELS_ROOT,
):
    """Resolve the authoring contract for one asteroid or comet."""
    body = _load_body(body_id, catalog_path)
    kind = body.get("kind")
    if kind not in KIND_CATEGORIES:
        raise ValueError(f'Body "{body_id}" is not an asteroid or comet (kind: {kind!r})')
    if expected_kind is not None and kind != expected_kind:
        raise ValueError(f'Body "{body_id}" is not a {expected_kind}')

    radius = body.get("meanRadiusKm")
    if (
        isinstance(radius, bool)
        or not isinstance(radius, (int, float))
        or not math.isfinite(radius)
        or radius <= 0
    ):
        raise ValueError(f'Body "{body_id}" has invalid meanRadiusKm')
    visual = body.get("visual") or {}
    seed = visual.get("proceduralSeed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= MAX_SEED:
        raise ValueError(f'Body "{body_id}" has invalid visual.proceduralSeed')

    category = KIND_CATEGORIES[kind]
    return SmallBodyConfig(
        body_id=body_id,
        name=str(body.get("name", body_id)),
        kind=kind,
        category=category,
        output_dir=Path(models_root) / category / body_id,
        procedural_seed=seed,
        mean_radius_km=float(radius),
        albedo_color=_albedo_color(body_id, visual),
        albedo_name=f"{body_id}_albedo.png",
        shape=SHAPE_PARAMETERS.get(body_id, DEFAULT_SHAPE),
        shape_model=shape_model_source(body_id),
        coma=(COMA_PARAMETERS.get(body_id, DEFAULT_COMA) if kind == "comet" else None),
    )
