"""Build the deterministic Solar Voyager ship authoring asset (build_ship.py v2).

Geometry, node names and material parameters live in `ship_config.py`, which is
Blender-free and unit-tested. This module is the adapter: it copies the authored
PBR maps out of `assets/textures-src/ship/`, wires the Principled materials,
turns each :class:`ShipPart` into a Blender object with analytic split normals,
asserts the ADR-025 axis and node contracts, and exports through the strict
`common/export.py` boundary.

Determinism: every vertex, UV and normal is computed by pure arithmetic in
`ship_geometry.py`, the textures are byte copies of committed sources, and
`common/export.py` canonicalises triangle order and rounds texcoords. Two clean
runs therefore produce identical GLB bytes; `tools/run_blender_smoke.py` proves
it by building twice and comparing SHA-256.
"""

import argparse
import math
import pathlib
import shutil
import sys

import bpy
from mathutils import Vector


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from common import (  # noqa: E402
    REPOSITORY_ROOT,
    build_manifest,
    create_pbr_material,
    export_glb,
    print_manifest,
    reset_scene,
)
from ship_config import (  # noqa: E402
    LIGHT_FIXTURES,
    MATERIALS,
    NOZZLE_SEGMENTS,
    RCS_POD_STATIONS,
    REQUIRED_NODE_NAMES,
    SHIP_LENGTH_METERS,
    ship_parts,
)


MODELS_ROOT = REPOSITORY_ROOT / "assets" / "models"
TEXTURES_SOURCE_ROOT = REPOSITORY_ROOT / "assets" / "textures-src" / "ship"
EXPECTED_NOZZLE_NAME = "engine_nozzle"
TEXTURE_WIDTH = 2048
TEXTURE_HEIGHT = 1024
#: The pipeline budget (`tools/assets/config.mjs`). The band below is tighter.
TRIANGLE_LIMIT = 30_000
#: T0121 acceptance band: enough detail to survive a close-up, with headroom.
TRIANGLE_MINIMUM = 18_000
TRIANGLE_MAXIMUM = 28_000
LENGTH_TOLERANCE_METERS = 0.02
TEXTURE_FILENAMES = (
    "ship_mat_engine_glow__emissive.png",
    "ship_mat_hull__albedo.png",
    "ship_mat_hull__metallic.png",
    "ship_mat_hull__normal.png",
)


def arguments_after_separator(argv):
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parse_arguments(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=pathlib.Path, default=MODELS_ROOT)
    parser.add_argument("--textures-root", type=pathlib.Path, default=TEXTURES_SOURCE_ROOT)
    return parser.parse_args(arguments)


def _publish_textures(textures_root, output_dir):
    """Copy the authored maps verbatim and verify the authoring resolution."""
    textures_root = pathlib.Path(textures_root).resolve()
    missing = [name for name in TEXTURE_FILENAMES if not (textures_root / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"Missing authored ship textures in {textures_root}: {', '.join(missing)}. "
            "Run `npm run textures:ship` to regenerate them."
        )
    published = []
    for name in TEXTURE_FILENAMES:
        destination = output_dir / name
        shutil.copyfile(textures_root / name, destination)
        image = bpy.data.images.load(str(destination), check_existing=True)
        try:
            if tuple(image.size) != (TEXTURE_WIDTH, TEXTURE_HEIGHT):
                raise RuntimeError(
                    f"{name} must be {TEXTURE_WIDTH}x{TEXTURE_HEIGHT}; measured "
                    f"{image.size[0]}x{image.size[1]}"
                )
        finally:
            bpy.data.images.remove(image)
        published.append(destination)
    return tuple(published)


def _wire_metallic_roughness(material, path):
    """Bind the packed glTF metallic-roughness map: G is rough, B is metal."""
    image = bpy.data.images.load(str(path.resolve()), check_existing=True)
    image.colorspace_settings.name = "Non-Color"
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "external_metallic"
    texture.label = "external_metallic"
    texture.image = image
    separate = nodes.new("ShaderNodeSeparateColor")
    links.new(texture.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], principled.inputs["Roughness"])
    links.new(separate.outputs["Blue"], principled.inputs["Metallic"])


def _materials(output_dir):
    """Instantiate every `ship_config.MATERIALS` entry, textured where authored."""
    created = {}
    for spec in MATERIALS:
        keywords = {
            "base_color": spec.base_color,
            "roughness": spec.roughness,
            "metallic": spec.metallic,
        }
        if spec.name == "mat_hull":
            keywords["albedo_path"] = output_dir / "ship_mat_hull__albedo.png"
            keywords["normal_path"] = output_dir / "ship_mat_hull__normal.png"
        if spec.name == "mat_engine_glow":
            keywords["emissive_path"] = output_dir / "ship_mat_engine_glow__emissive.png"
            keywords["emissive_strength"] = spec.emissive_strength
        elif spec.emissive_color is not None:
            keywords["emissive_color"] = spec.emissive_color
            keywords["emissive_strength"] = spec.emissive_strength
        material = create_pbr_material(spec.name, **keywords)
        if spec.name == "mat_hull":
            _wire_metallic_roughness(material, output_dir / "ship_mat_hull__metallic.png")
        created[spec.name] = material
    return created


def _create_mesh_object(part, material):
    """One `ShipPart` becomes one Blender object with exact split normals."""
    data = part.mesh
    mesh = bpy.data.meshes.new(f"mesh_{part.name}")
    mesh.from_pydata(data.vertices, (), data.faces)
    mesh.update(calc_edges=True)

    uv_present = tuple(len(uv_face) > 0 for uv_face in data.uv_faces)
    if any(uv_present) and not all(uv_present):
        raise RuntimeError(f'Part "{part.name}" mixes UV-mapped and unmapped faces')
    if all(uv_present) and data.uv_faces:
        uv_layer = mesh.uv_layers.new(name="hull")
        for polygon, uv_face in zip(mesh.polygons, data.uv_faces):
            if len(uv_face) != len(polygon.loop_indices):
                raise RuntimeError(f'Part "{part.name}" has a UV face of the wrong arity')
            for loop_index, uv in zip(polygon.loop_indices, uv_face):
                uv_layer.data[loop_index].uv = uv

    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.normals_split_custom_set(
        [normal for normal_face in data.normal_faces for normal in normal_face]
    )
    mesh.materials.append(material)

    obj = bpy.data.objects.new(part.name, mesh)
    obj.location = part.origin
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _create_marker_object(part):
    """Meshless nodes (the cockpit eye) export as bare glTF nodes."""
    obj = bpy.data.objects.new(part.name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.25
    obj.location = part.origin
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _build_objects(materials):
    mesh_objects = []
    marker_objects = []
    for part in ship_parts():
        if part.mesh is None:
            marker_objects.append(_create_marker_object(part))
            continue
        material = materials.get(part.material)
        if material is None:
            raise RuntimeError(f'Part "{part.name}" references unknown material {part.material}')
        mesh_objects.append(_create_mesh_object(part, material))
    bpy.context.view_layer.update()
    return tuple(mesh_objects), tuple(marker_objects)


def _boundary_edge_count(mesh):
    counts = {}
    for polygon in mesh.polygons:
        for key in polygon.edge_keys:
            counts[key] = counts.get(key, 0) + 1
    return sum(1 for value in counts.values() if value == 1)


def _ship_length(objects):
    x_values = []
    for obj in objects:
        for corner in obj.bound_box:
            x_values.append((obj.matrix_world @ Vector(corner)).x)
    return max(x_values) - min(x_values)


def _assert_contracts(objects):
    """Fail the build, not the game, when a consumed node name goes missing."""
    by_name = {obj.name: obj for obj in objects}
    missing = [name for name in REQUIRED_NODE_NAMES if name not in by_name]
    if missing:
        raise RuntimeError(f'Missing required ship nodes: {", ".join(missing)}')

    nozzle = by_name[EXPECTED_NOZZLE_NAME]
    if _boundary_edge_count(nozzle.data) < NOZZLE_SEGMENTS:
        raise RuntimeError("engine_nozzle must stay open so the recessed glow well reads")

    tip = by_name["hull_tip"]
    nose_axis = tip.matrix_world.translation - nozzle.matrix_world.translation
    if nose_axis.length <= 1e-6 or nose_axis.x / nose_axis.length < 0.999999:
        raise RuntimeError("Ship nose must align with local +X per ADR-025")

    # `shipVisual.ts` measures hull_tip against the model root, not the nozzle.
    tip_offset = tip.matrix_world.translation
    if tip_offset.length <= 1e-6 or tip_offset.x / tip_offset.length < 0.999999:
        raise RuntimeError("hull_tip must sit on the +X axis through the model origin")

    for index in range(len(RCS_POD_STATIONS)):
        pod = by_name[f"rcs_pod_{index + 1}"]
        if pod.matrix_world.translation.length <= 1e-6:
            raise RuntimeError(f"rcs_pod_{index + 1} must be offset from the model origin")
    for name, origin, _ in LIGHT_FIXTURES:
        # Blender object locations are float32, so this compares at float32
        # precision rather than pretending the f64 literal survives the round
        # trip. T0122 resolves these nodes by name and reads their world origin.
        placed = by_name[name].matrix_world.translation
        if max(abs(placed[axis] - origin[axis]) for axis in range(3)) > 1e-5:
            raise RuntimeError(f"{name} was not placed at its authored origin")


def _write_sources(output_dir, triangles, node_names):
    records = [
        "# Sources — Ship",
        "",
        "- `ship.glb` — `tools/blender/build_ship.py` + `tools/blender/ship_config.py` — Solar Voyager original asset; all rights reserved for project distribution — deterministic Blender 5.1 hard-surface model: lathed fuselage with stepped plating, nose cap, canopy, four RCS quads, nozzle assembly with a lined bell, radiators and running-light housings.",
        "- `ship_mat_hull__albedo.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 sRGB hull plating: irregular bay layout, panel grooves, rivet rows, painted service panels and aft engine soot.",
        "- `ship_mat_hull__normal.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 tangent-space normal, central-differenced from the same height field as the albedo, seamless in U.",
        "- `ship_mat_hull__metallic.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 glTF metallic-roughness map (G roughness, B metalness).",
        "- `ship_mat_engine_glow__emissive.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — deterministic 2048×1024 photon-drive throat emission, mapped radially (U is the glow-disc radius fraction).",
        "",
        "Regenerate the maps with `npm run textures:ship` (they are written to",
        "`assets/textures-src/ship/`, which carries the full authoring recipe), then",
        "rebuild the model with `build_ship.py`; the builder copies them here verbatim.",
        "",
        "## Authoring contract",
        "",
        f"One Blender unit equals one metre. Length: {SHIP_LENGTH_METERS:.2f} m; nose and drive axis point toward local +X per ADR-025. Applied geometry: {triangles:,} triangles (budget ≤{TRIANGLE_LIMIT:,}).",
        "",
        "### Node names consumed by other code (API — do not rename)",
        "",
        "| Node | Meaning |",
        "| --- | --- |",
        "| `hull_tip` | Nose marker; `src/render/shipVisual.ts` dots its world offset from the model root against the physics forward vector. |",
        "| `engine_nozzle` | Plume attachment (T0122). Origin at the throat; the bell opens aft to the tail extreme. |",
        "| `rcs_pod_1` … `rcs_pod_4` | RCS puff emitters (T0122): 1 forward port, 2 forward starboard, 3 aft port, 4 aft starboard. |",
        "| `light_nav_l` / `light_nav_r` | Port (red) and starboard (green) navigation lights, at the radiator tips. |",
        "| `light_beacon` | Dorsal anti-collision beacon on the spine. |",
        "| `cockpit_eye` | Meshless marker at the pilot eye point for the T0124 cockpit camera. |",
        "| `canopy` | The glass shell, kept separate so the cockpit view can treat it as the frame silhouette. |",
        "",
        "Exported nodes: " + ", ".join(f"`{name}`" for name in node_names) + ".",
        "",
        "Material names are the engine's attachment convention: `mat_engine_glow` receives",
        "the emissive animation, `mat_hull` carries the three authored maps, and the three",
        "`mat_light_*` materials are the running lights T0122 drives.",
        "",
    ]
    (output_dir / "SOURCES.md").write_text(
        "\n".join(records), encoding="utf-8", newline="\n"
    )


def build(output_root, textures_root=TEXTURES_SOURCE_ROOT):
    output_dir = pathlib.Path(output_root).resolve() / "ship"
    output_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()
    texture_paths = _publish_textures(textures_root, output_dir)
    mesh_objects, marker_objects = _build_objects(_materials(output_dir))
    exported = mesh_objects + marker_objects
    _assert_contracts(exported)

    glb_path = export_glb(exported, output_dir / "ship.glb", active=mesh_objects[0])
    manifest = build_manifest("ship", "ship", mesh_objects, glb_path, texture_paths)
    ship_length = _ship_length(mesh_objects)
    manifest["lengthMeters"] = round(ship_length, 6)
    manifest["nodes"] = [obj.name for obj in exported]
    _write_sources(output_dir, manifest["triangles"], manifest["nodes"])
    print_manifest(manifest)

    if not TRIANGLE_MINIMUM <= manifest["triangles"] <= TRIANGLE_MAXIMUM:
        raise RuntimeError(
            f'Ship emitted {manifest["triangles"]} triangles; expected '
            f"{TRIANGLE_MINIMUM}–{TRIANGLE_MAXIMUM} against the {TRIANGLE_LIMIT} budget"
        )
    if not math.isfinite(ship_length):
        raise RuntimeError("Ship length must be finite")
    if abs(ship_length - SHIP_LENGTH_METERS) > LENGTH_TOLERANCE_METERS:
        raise RuntimeError(
            f"Ship length is {ship_length:.6f} m, expected {SHIP_LENGTH_METERS:.2f} m"
        )
    if tuple(path.name for path in texture_paths) != TEXTURE_FILENAMES:
        raise RuntimeError("Ship texture manifest is incomplete or not canonical")
    return manifest


def main(argv=None):
    arguments = parse_arguments(
        arguments_after_separator(sys.argv) if argv is None else argv
    )
    build(arguments.output_root, arguments.textures_root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Ship build failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from error
