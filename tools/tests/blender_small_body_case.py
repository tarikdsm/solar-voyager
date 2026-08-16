"""Blender-side small-body case for `tools/run_blender_smoke.py`.

Builds one procedural asteroid and one comet whose nucleus comes from a shape
model, so a single run exercises both geometry paths, the comet anchor contract
and the decimation code. The shape model is synthesised here and pinned by its own
SHA-256: no PDS download is pinned in `tools/fetch_textures.py` yet, and this case
must not depend on the network either way.

Run headless:
  blender --background --python tools/tests/blender_small_body_case.py -- \
      --output-root build/blender-smoke/small-bodies --shape-root build/blender-smoke/shape-src
"""

import argparse
import hashlib
import pathlib
import sys


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
BLENDER_DIR = REPOSITORY_ROOT / "tools" / "blender"
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import build_asteroid  # noqa: E402
import build_comet  # noqa: E402
import small_body_config  # noqa: E402
from common.geodesic import geodesic_sphere  # noqa: E402


ASTEROID_ID = "vesta"
COMET_ID = "67p"
SYNTHETIC_FREQUENCY = 24
SYNTHETIC_SQUASH = (1.0, 0.86, 0.52)


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=pathlib.Path, required=True)
    parser.add_argument("--shape-root", type=pathlib.Path, required=True)
    return parser.parse_args(arguments)


def write_synthetic_shape_model(path):
    """A deterministic over-budget OBJ standing in for the pinned PDS download."""
    vertices, faces = geodesic_sphere(SYNTHETIC_FREQUENCY)
    lines = ["# synthetic stand-in for the pinned PDS SBN shape model"]
    for x, y, z in vertices:
        lines.append(f"v {x * SYNTHETIC_SQUASH[0]!r} {y * SYNTHETIC_SQUASH[1]!r} {z * SYNTHETIC_SQUASH[2]!r}")
    lines.extend(f"f {a + 1} {b + 1} {c + 1}" for a, b, c in faces)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"Synthetic shape model: {len(faces)} facets at {path}", flush=True)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pin_synthetic_source(body_id, digest):
    source = small_body_config.SHAPE_MODEL_SOURCES[body_id]
    small_body_config.SHAPE_MODEL_SOURCES[body_id] = source._replace(
        source_url="https://pds-smallbodies.astro.umd.edu/synthetic-smoke-fixture.obj",
        sha256=digest,
    )


def main(argv=None):
    arguments = parse_arguments(arguments_after_separator(sys.argv) if argv is None else argv)
    output_root = arguments.output_root.resolve()
    shape_root = arguments.shape_root.resolve()

    source = small_body_config.SHAPE_MODEL_SOURCES[COMET_ID]
    digest = write_synthetic_shape_model(shape_root / COMET_ID / source.output_name)
    pin_synthetic_source(COMET_ID, digest)

    build_asteroid.build(ASTEROID_ID, output_root, "procedural", shape_root)
    manifest = build_comet.build(COMET_ID, output_root, "real", shape_root)
    if manifest["shapeSource"] != "shape-model":
        raise RuntimeError("Comet smoke case did not take the shape-model path")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Small-body case failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
