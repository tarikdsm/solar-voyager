"""Repository paths and body catalog lookup for builders."""

import json
import pathlib


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
KIND_CATEGORIES = {
    "asteroid": "asteroids",
    "comet": "comets",
    "dwarf": "dwarfs",
    "moon": "moons",
    "planet": "planets",
    "star": "sun",
}


def body_by_id(body_id, catalog_path=CATALOG_PATH):
    with pathlib.Path(catalog_path).open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    matches = [body for body in catalog["bodies"] if body["id"] == body_id]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one body id "{body_id}" in {catalog_path}')
    return matches[0]


def asset_category(body):
    try:
        return KIND_CATEGORIES[body["kind"]]
    except KeyError as error:
        raise ValueError(f'Body "{body.get("id", "<unknown>")}" has unsupported kind') from error
