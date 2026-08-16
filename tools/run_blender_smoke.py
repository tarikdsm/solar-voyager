"""Run Blender headless and prove its authored GLB passes the runtime ingest."""

import json
import hashlib
import math
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
SMALL_BODY_CASE = REPOSITORY_ROOT / "tools" / "tests" / "blender_small_body_case.py"
SMALL_BODY_VALIDATOR = REPOSITORY_ROOT / "tools" / "tests" / "validateAuthoredAsset.mjs"
SMALL_BODY_ASSETS = (
    ("asteroids", "vesta", ("vesta.glb", "vesta_albedo.png", "SOURCES.md")),
    ("comets", "67p", ("67p.glb", "67p_albedo.png", "SOURCES.md")),
)
COMET_ANCHOR_NAMES = ("coma_anchor", "tail_anchor")
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


def read_glb(path):
    with pathlib.Path(path).open("rb") as stream:
        magic, version, length = struct.unpack("<4sII", stream.read(12))
        if magic != b"glTF" or version != 2:
            raise RuntimeError(f"Not a glTF 2 GLB: {path}")
        document = None
        binary = None
        while stream.tell() < length:
            chunk_length, chunk_type = struct.unpack("<I4s", stream.read(8))
            chunk = stream.read(chunk_length)
            if chunk_type == b"JSON":
                document = json.loads(chunk.decode("utf-8"))
            elif chunk_type == b"BIN\0":
                binary = chunk
        if document is None or binary is None:
            raise RuntimeError(f"GLB must contain JSON and BIN chunks: {path}")
        return document, binary


def read_glb_json(path):
    return read_glb(path)[0]


def read_float_vectors(document, binary, accessor_index, components):
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    if accessor["componentType"] != 5126 or accessor["type"] != f"VEC{components}":
        raise RuntimeError("Expected a floating-point vector accessor")
    stride = view.get("byteStride", components * 4)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [
        struct.unpack_from(f"<{components}f", binary, offset + index * stride)
        for index in range(accessor["count"])
    ]


def read_indices(document, binary, accessor_index):
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    formats = {5121: "B", 5123: "H", 5125: "I"}
    format_code = formats.get(accessor["componentType"])
    if format_code is None:
        raise RuntimeError("Unsupported index component type")
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return struct.unpack_from(f'<{accessor["count"]}{format_code}', binary, offset)


def validate_quad_sphere_glb(path):
    document, binary = read_glb(path)
    primitive = document["meshes"][0]["primitives"][0]
    positions = read_float_vectors(document, binary, primitive["attributes"]["POSITION"], 3)
    texcoords = read_float_vectors(document, binary, primitive["attributes"]["TEXCOORD_0"], 2)
    if len(positions) != len(texcoords):
        raise RuntimeError("Quad sphere position and UV counts differ")
    for (x, y, z), (u, v) in zip(positions, texcoords):
        radius = math.sqrt(x * x + y * y + z * z)
        expected_v = 0.5 - math.asin(max(-1.0, min(1.0, y / radius))) / math.pi
        if abs(v - expected_v) > 1e-5:
            raise RuntimeError("Exported quad sphere V is not glTF latitude mapped")
        if math.hypot(x, z) > 1e-7:
            expected_u = (0.5 + math.atan2(z, x) / (2.0 * math.pi)) % 1.0
            wrapped_error = min(abs(u - expected_u), abs(u - expected_u - 1.0))
            if wrapped_error > 1e-5:
                raise RuntimeError("Exported quad sphere U is not glTF longitude mapped")
    indices = read_indices(document, binary, primitive["indices"])
    for offset in range(0, len(indices), 3):
        triangle_u = [texcoords[index][0] for index in indices[offset : offset + 3]]
        if max(triangle_u) - min(triangle_u) > 0.5 + 1e-5:
            raise RuntimeError("Exported quad sphere triangle crosses the equirectangular seam")


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


def run_ship_builder(blender, output_root):
    return run_checked(
        (
            blender,
            "--background",
            "--python",
            REPOSITORY_ROOT / "tools" / "blender" / "build_ship.py",
            "--",
            "--output-root",
            output_root,
        )
    )


#: Node names other tasks resolve by string; see tools/blender/ship_config.py.
SHIP_CONTRACT_NODES = (
    "canopy",
    "cockpit_eye",
    "engine_nozzle",
    "hull_tip",
    "light_beacon",
    "light_nav_l",
    "light_nav_r",
    "rcs_pod_1",
    "rcs_pod_2",
    "rcs_pod_3",
    "rcs_pod_4",
)
SHIP_TRIANGLE_MINIMUM = 18_000
SHIP_TRIANGLE_MAXIMUM = 28_000


def validate_ship_glb(path):
    """Gate the T0121 contracts on the real exported bytes, not on the builder."""
    document, _ = read_glb(path)
    for forbidden in ("animations", "cameras", "images"):
        if document.get(forbidden):
            raise RuntimeError(f"Ship GLB unexpectedly contains {forbidden}")
    extensions = set(document.get("extensionsUsed", ())) | set(document.get("extensionsRequired", ()))
    if "KHR_draco_mesh_compression" in extensions:
        raise RuntimeError("Authored ship GLB must not contain Draco compression")
    if "KHR_lights_punctual" in extensions:
        raise RuntimeError("Authored ship GLB must not contain punctual lights")

    nodes = {node.get("name"): node for node in document.get("nodes", ())}
    missing = [name for name in SHIP_CONTRACT_NODES if name not in nodes]
    if missing:
        raise RuntimeError(f'Ship GLB is missing contract nodes: {", ".join(missing)}')
    if "mesh" in nodes["cockpit_eye"]:
        raise RuntimeError("cockpit_eye must stay a meshless marker node")

    tip = nodes["hull_tip"].get("translation", (0.0, 0.0, 0.0))
    nozzle = nodes["engine_nozzle"].get("translation", (0.0, 0.0, 0.0))
    delta = [tip[index] - nozzle[index] for index in range(3)]
    length = math.sqrt(sum(value * value for value in delta))
    if length <= 1e-6 or delta[0] / length < 0.999:
        raise RuntimeError(f"Ship nose must align with local +X per ADR-025; measured {delta}")

    triangles = 0
    for mesh in document.get("meshes", ()):
        for primitive in mesh.get("primitives", ()):
            triangles += document["accessors"][primitive["indices"]]["count"] // 3
    if not SHIP_TRIANGLE_MINIMUM <= triangles <= SHIP_TRIANGLE_MAXIMUM:
        raise RuntimeError(
            f"Ship GLB has {triangles} triangles; expected "
            f"{SHIP_TRIANGLE_MINIMUM}-{SHIP_TRIANGLE_MAXIMUM}"
        )
    return triangles


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def run_small_body_case(blender, run_root):
    return run_checked(
        (
            blender,
            "--background",
            "--python",
            SMALL_BODY_CASE,
            "--",
            "--output-root",
            run_root / "models",
            "--shape-root",
            run_root / "shape-src",
        )
    )


def validate_small_body_contract(models_root):
    """The comet anchor nodes are API for T0139: assert their exported shape."""
    comet_glb = models_root / "comets" / "67p" / "67p.glb"
    document = read_glb_json(comet_glb)
    nodes = {node.get("name"): node for node in document.get("nodes", ())}
    if [node.get("name") for node in document.get("nodes", ()) if "mesh" in node] != ["67p"]:
        raise RuntimeError("Comet GLB must contain exactly the nucleus mesh node")
    for name in COMET_ANCHOR_NAMES:
        node = nodes.get(name)
        if node is None:
            raise RuntimeError(f'Comet GLB is missing the required "{name}" node')
        if "mesh" in node:
            raise RuntimeError(f'Comet anchor "{name}" must stay mesh-less')
        if any(abs(value) > 1e-6 for value in node.get("translation", (0.0, 0.0, 0.0))):
            raise RuntimeError(f'Comet anchor "{name}" must sit at the nucleus origin')
        scale = node.get("scale")
        if scale is None or len(set(scale)) != 1 or scale[0] <= 1.0:
            raise RuntimeError(f'Comet anchor "{name}" must carry a uniform scale above 1.0')

    for category, body_id, _ in SMALL_BODY_ASSETS:
        run_checked(
            (
                "node",
                SMALL_BODY_VALIDATOR,
                models_root / category / body_id,
                body_id,
                category,
            )
        )


def verify_small_bodies(blender):
    first_root = BUILD_ROOT / "small-bodies"
    second_root = BUILD_ROOT / "small-bodies-repeat"
    for run_root in (first_root, second_root):
        output = run_small_body_case(blender, run_root)
        if output.count("=== ASSET MANIFEST ===") != len(SMALL_BODY_ASSETS):
            raise RuntimeError("Small-body case did not print a manifest per asset")
    validate_small_body_contract(first_root / "models")
    for category, body_id, filenames in SMALL_BODY_ASSETS:
        for filename in filenames:
            relative = pathlib.Path("models") / category / body_id / filename
            if sha256(first_root / relative) != sha256(second_root / relative):
                raise RuntimeError(f"Two identical small-body builds disagree on {relative}")
    print(
        "Small-body builders deterministic: "
        + ", ".join(f"{body_id} ({category})" for category, body_id, _ in SMALL_BODY_ASSETS)
    )


def main():
    reset_build_root()
    blender = find_blender()
    builder_output = run_builder(blender, AUTHORED_ROOT)
    if "=== ASSET MANIFEST ===" not in builder_output:
        raise RuntimeError("Blender builder did not print its asset manifest")

    authored_glb = AUTHORED_ROOT / "sun" / "sun.glb"
    validate_authored_glb(authored_glb)
    quad_glb = AUTHORED_ROOT.parent / "quad-contract.glb"
    validate_quad_sphere_glb(quad_glb)
    repeated_output = run_builder(blender, AUTHORED_REPEAT_ROOT)
    if "=== ASSET MANIFEST ===" not in repeated_output:
        raise RuntimeError("Repeated Blender builder did not print its asset manifest")
    repeated_glb = AUTHORED_REPEAT_ROOT / "sun" / "sun.glb"
    if sha256(authored_glb) != sha256(repeated_glb):
        raise RuntimeError("Two identical Blender builds emitted different GLB bytes")
    repeated_quad_glb = AUTHORED_REPEAT_ROOT.parent / "quad-contract.glb"
    if sha256(quad_glb) != sha256(repeated_quad_glb):
        raise RuntimeError("Two identical quad-sphere builds emitted different GLB bytes")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise FileNotFoundError("npm not found on PATH")

    # The ship's authored PBR maps are generated, not fetched (ADR-039), and
    # `assets/textures-src/**` is gitignored — so regenerate them here rather
    # than assuming a populated working tree. This is what proves the whole
    # chain works from a clean checkout.
    run_checked((npm, "run", "textures:ship"))
    ship_output = run_ship_builder(blender, AUTHORED_ROOT)
    if "=== ASSET MANIFEST ===" not in ship_output:
        raise RuntimeError("Ship builder did not print its asset manifest")
    ship_glb = AUTHORED_ROOT / "ship" / "ship.glb"
    ship_triangles = validate_ship_glb(ship_glb)
    run_ship_builder(blender, AUTHORED_REPEAT_ROOT)
    repeated_ship_glb = AUTHORED_REPEAT_ROOT / "ship" / "ship.glb"
    if sha256(ship_glb) != sha256(repeated_ship_glb):
        raise RuntimeError("Two identical ship builds emitted different GLB bytes")
    for name in sorted(path.name for path in (AUTHORED_ROOT / "ship").glob("*.png")):
        if sha256(AUTHORED_ROOT / "ship" / name) != sha256(AUTHORED_REPEAT_ROOT / "ship" / name):
            raise RuntimeError(f"Two identical ship builds emitted different {name} bytes")

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
            "--only",
            "ship",
        )
    )
    runtime_glb = PUBLISHED_ROOT / "models" / "sun.glb"
    runtime_document = read_glb_json(runtime_glb)
    if "KHR_draco_mesh_compression" not in runtime_document.get("extensionsRequired", ()):
        raise RuntimeError("Ingested GLB does not require Draco compression")
    for suffix in ("", "_2k", "_1k"):
        variant = PUBLISHED_ROOT / "models" / f"ship{suffix}.glb"
        if not variant.is_file():
            raise RuntimeError(f"Ingest did not emit the ship tier variant {variant.name}")
    print(f"Blender smoke accepted: {authored_glb.relative_to(REPOSITORY_ROOT)}")
    print(
        f"Ship smoke accepted: {ship_glb.relative_to(REPOSITORY_ROOT)} "
        f"({ship_triangles:,} triangles, byte-identical on rebuild)"
    )
    print(f"Runtime ingest accepted: {runtime_glb.relative_to(REPOSITORY_ROOT)}")
    verify_small_bodies(blender)


if __name__ == "__main__":
    main()
