"""Build a normalized comet nucleus with the coma/tail anchor nodes.

Geometry follows the same two paths as `build_asteroid.py`: 67P has a
public-domain Rosetta nucleus shape model at the PDS Small Bodies Node, decimated
here to at most 5,000 triangles; 1P/Halley has no usable published mesh and gets
the displaced geodesic icosphere seeded by `visual.proceduralSeed`.

**Anchor API — consumed by T0139.** Every comet GLB carries two mesh-less nodes at
the scene root, in the normalized body frame (1.0 unit = nucleus radius, +Y up
after glTF export):

* `coma_anchor` — origin, identity rotation, uniform scale = authored coma radius
  in nucleus radii.
* `tail_anchor` — origin, identity rotation, uniform scale = authored tail length
  in nucleus radii.

Neither carries a direction: T0139 computes the anti-sunward tail vector from sim
state. The names, the mesh-less shape and the scale-carries-magnitude convention
are API — `verify_anchors` fails the build if any of them drifts.

Run headless:
  blender --background --python tools/blender/build_comet.py -- --id 1p
  blender --background --python tools/blender/build_comet.py -- --id 67p --shape real
"""

import argparse
import pathlib
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from small_body_builder import SHAPE_MODES, build_small_body  # noqa: E402
from small_body_config import MODELS_ROOT, SHAPE_ROOT  # noqa: E402


BUILDER = "tools/blender/build_comet.py"


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
        expected_kind="comet",
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
        print(f"Comet build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
