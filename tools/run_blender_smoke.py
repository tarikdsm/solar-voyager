"""Run Blender headless and prove its authored GLB passes the runtime ingest."""

import json
import hashlib
import os
import pathlib
import shutil
import struct
import subprocess
import sys


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILD_ROOT = REPOSITORY_ROOT / "build" / "blender-smoke"
AUTHORED_ROOT = BUILD_ROOT / "assets" / "models"
AUTHORED_REPEAT_ROOT = BUILD_ROOT / "assets-repeat" / "models"
PUBLISHED_ROOT = BUILD_ROOT / "public" / "assets"
KNOWN_WINDOWS_BLENDER = pathlib.Path(
    r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
)


def find_blender():
    configured = os.environ.get("BLENDER_PATH")
    candidates = (pathlib.Path(configured) if configured else None, shutil.which("blender"), KNOWN_WINDOWS_BLENDER)
    for candidate in candidates:
        if candidate is not None and pathlib.Path(candidate).is_file():
            return pathlib.Path(candidate).resolve()
    raise FileNotFoundError("Blender not found; set BLENDER_PATH to the executable")


def reset_build_root():
    resolved = BUILD_ROOT.resolve()
    expected_parent = (REPOSITORY_ROOT / "build").resolve()
    if resolved.parent != expected_parent:
        raise RuntimeError(f"Refusing to clean unexpected smoke directory: {resolved}")
    shutil.rmtree(resolved, ignore_errors=True)
    AUTHORED_ROOT.mkdir(parents=True)


def run_checked(command):
    result = subprocess.run(
        [str(part) for part in command],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    if result.returncode != 0:
        raise RuntimeError(f'Command failed ({result.returncode}): {" ".join(map(str, command))}')
    return result.stdout


def read_glb_json(path):
    with pathlib.Path(path).open("rb") as stream:
        magic, version, _length = struct.unpack("<4sII", stream.read(12))
        if magic != b"glTF" or version != 2:
            raise RuntimeError(f"Not a glTF 2 GLB: {path}")
        chunk_length, chunk_type = struct.unpack("<I4s", stream.read(8))
        if chunk_type != b"JSON":
            raise RuntimeError(f"First GLB chunk is not JSON: {path}")
        return json.loads(stream.read(chunk_length).decode("utf-8"))


def validate_authored_glb(path):
    document = read_glb_json(path)
    for forbidden in ("animations", "cameras", "images"):
        if document.get(forbidden):
            raise RuntimeError(f"Authored GLB unexpectedly contains {forbidden}")
    extensions = set(document.get("extensionsUsed", ())) | set(document.get("extensionsRequired", ()))
    if "KHR_draco_mesh_compression" in extensions:
        raise RuntimeError("Authored GLB must not contain Draco compression")
    if [material.get("name") for material in document.get("materials", ())] != ["mat_surface"]:
        raise RuntimeError("Authored GLB must contain exactly the mat_surface material")
    if [node.get("name") for node in document.get("nodes", ()) if "mesh" in node] != ["sun"]:
        raise RuntimeError("Authored GLB must contain exactly the sun mesh node")


def run_builder(blender, output_root):
    return run_checked(
        (
            blender,
            "--background",
            "--python",
            REPOSITORY_ROOT / "tools" / "blender" / "build_test_sphere.py",
            "--",
            "--output-root",
            output_root,
        )
    )


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def main():
    reset_build_root()
    blender = find_blender()
    builder_output = run_builder(blender, AUTHORED_ROOT)
    if "=== ASSET MANIFEST ===" not in builder_output:
        raise RuntimeError("Blender builder did not print its asset manifest")

    authored_glb = AUTHORED_ROOT / "sun" / "sun.glb"
    validate_authored_glb(authored_glb)
    repeated_output = run_builder(blender, AUTHORED_REPEAT_ROOT)
    if "=== ASSET MANIFEST ===" not in repeated_output:
        raise RuntimeError("Repeated Blender builder did not print its asset manifest")
    repeated_glb = AUTHORED_REPEAT_ROOT / "sun" / "sun.glb"
    if sha256(authored_glb) != sha256(repeated_glb):
        raise RuntimeError("Two identical Blender builds emitted different GLB bytes")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise FileNotFoundError("npm not found on PATH")
    run_checked(
        (
            npm,
            "run",
            "assets:ingest",
            "--",
            "--models",
            AUTHORED_ROOT,
            "--output",
            PUBLISHED_ROOT,
            "--only",
            "sun",
        )
    )
    runtime_glb = PUBLISHED_ROOT / "models" / "sun.glb"
    runtime_document = read_glb_json(runtime_glb)
    if "KHR_draco_mesh_compression" not in runtime_document.get("extensionsRequired", ()):
        raise RuntimeError("Ingested GLB does not require Draco compression")
    print(f"Blender smoke accepted: {authored_glb.relative_to(REPOSITORY_ROOT)}")
    print(f"Runtime ingest accepted: {runtime_glb.relative_to(REPOSITORY_ROOT)}")


if __name__ == "__main__":
    main()
