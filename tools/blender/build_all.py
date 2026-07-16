"""Deterministic headless entry point for implemented Blender body builders."""

import argparse
import json
import pathlib
import runpy
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIR.parents[1]
CATALOG_PATH = REPOSITORY_ROOT / "data" / "bodies.json"
EXCLUDED_BUILDERS = {"all", "planet", "test_sphere"}


def load_catalog_ids(catalog_path=CATALOG_PATH):
    with pathlib.Path(catalog_path).open("r", encoding="utf-8") as stream:
        catalog = json.load(stream)
    return {body["id"] for body in catalog["bodies"]} | {"ship"}


def discover_builders(directory=SCRIPT_DIR, catalog_ids=None):
    directory = pathlib.Path(directory)
    catalog_ids = load_catalog_ids() if catalog_ids is None else set(catalog_ids)
    builders = {}
    for path in sorted(directory.glob("build_*.py"), key=lambda candidate: candidate.name):
        body_id = path.stem.removeprefix("build_")
        if body_id in EXCLUDED_BUILDERS:
            continue
        if body_id not in catalog_ids:
            raise ValueError(
                f'Builder "{path.name}" has unknown id "{body_id}"; add it to data/bodies.json first'
            )
        builders[body_id] = path
    return dict(sorted(builders.items()))


def parse_build_request(arguments, builders):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--only", action="append", default=[])
    namespace, unknown = parser.parse_known_args(arguments)
    if unknown:
        raise ValueError(f"Unknown build arguments: {' '.join(unknown)}")
    if namespace.all == bool(namespace.only):
        raise ValueError("Specify exactly one of --all or one-or-more --only <id>")
    if namespace.all:
        return tuple(sorted(builders))
    if len(namespace.only) != len(set(namespace.only)):
        raise ValueError("A duplicate --only id was requested")
    unsupported = sorted(set(namespace.only) - set(builders))
    if unsupported:
        raise ValueError(
            f"unsupported builder id(s): {', '.join(unsupported)}; supported: {', '.join(sorted(builders))}"
        )
    return tuple(sorted(namespace.only))


def _run_builder(path):
    runpy.run_path(str(path), run_name="__main__")


def run_builders(body_ids, builders, runner=_run_builder):
    for body_id in body_ids:
        print(f"=== BUILD {body_id} ===", flush=True)
        runner(builders[body_id])


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def main(argv=None):
    builders = discover_builders()
    arguments = arguments_after_separator(sys.argv if argv is None else argv)
    body_ids = parse_build_request(arguments, builders)
    run_builders(body_ids, builders)
    print(f"Built {len(body_ids)} asset(s): {', '.join(body_ids)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Asset build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
