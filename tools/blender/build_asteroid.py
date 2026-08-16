"""Build a normalized asteroid authoring asset from the body catalog.

Two geometry paths, one export contract:

* **Real shape model** — Eros (NEAR), Bennu (OSIRIS-REx) and Ryugu (Hayabusa2)
  have public-domain plate models archived at the PDS Small Bodies Node. The
  pinned OBJ is fetched and checksum-verified by T0132's manifest, then decimated
  here to at most 5,000 triangles by deterministic vertex clustering.
* **Procedural fallback** — a displaced geodesic icosphere (frequency 15, 4,500
  triangles) seeded entirely by the catalog's `visual.proceduralSeed`, for every
  asteroid no mission has imaged.

Run headless:
  blender --background --python tools/blender/build_asteroid.py -- --id vesta
  blender --background --python tools/blender/build_asteroid.py -- --id eros --shape real
"""

import argparse
import pathlib
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from small_body_builder import SHAPE_MODES, build_small_body  # noqa: E402
from small_body_config import MODELS_ROOT, SHAPE_ROOT  # noqa: E402


BUILDER = "tools/blender/build_asteroid.py"


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True)
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    parser.add_argument("--shape-root", type=pathlib.Path, default=SHAPE_ROOT)
    parser.add_argument("--shape", choices=SHAPE_MODES, default="auto")
    return parser.parse_args(arguments)


def build(body_id, output_root=MODELS_ROOT, shape_mode="auto", shape_root=SHAPE_ROOT):
    return build_small_body(
        body_id,
        expected_kind="asteroid",
        builder=BUILDER,
        output_root=output_root,
        shape_mode=shape_mode,
        shape_root=shape_root,
    )


def main(argv=None):
    arguments = parse_arguments(arguments_after_separator(sys.argv) if argv is None else argv)
    build(arguments.id, arguments.output_root, arguments.shape, arguments.shape_root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Asteroid build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
