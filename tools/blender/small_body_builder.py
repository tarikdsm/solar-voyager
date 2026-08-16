"""Shared authoring core for `build_asteroid.py` and `build_comet.py`.

One geometry path serves both the seeded procedural relief and the decimated
published shape model: whichever supplies the vertices, the mesh is normalized to
radius 1.0 about the origin, given equirectangular UVs, exported through the
strict GLB boundary and then has its normals re-derived from the exported
positions so two builds are byte-identical.
"""

from array import array
import pathlib

import bpy

from common import (
    DEFAULT_FREQUENCY,
    ProceduralShape,
    build_manifest,
    canonicalize_mesh_normals,
    create_anchor,
    create_displaced_body,
    create_pbr_material,
    export_glb,
    geodesic_sphere,
    load_shape_model,
    normalize_unit_radius,
    print_manifest,
    read_gltf_json,
    reset_scene,
    shade_field,
)
from small_body_config import (
    ALBEDO_HEIGHT,
    ALBEDO_WIDTH,
    ANCHOR_NAMES,
    COMA_ANCHOR_NAME,
    SHAPE_ROOT,
    TAIL_ANCHOR_NAME,
    TRIANGLE_LIMIT,
    resolve_shape_path,
    small_body_config,
    validate_shape_source,
)


SHAPE_MODES = ("auto", "procedural", "real")
SURFACE_MATERIAL_NAME = "mat_surface"
SURFACE_ROUGHNESS = 0.95
# Regolith mottling spans roughly +/-38% around the catalogued albedo colour.
ALBEDO_FLOOR = 0.62
ALBEDO_RANGE = 0.76
RADIUS_TOLERANCE = 1e-5
ANCHOR_SCALE_TOLERANCE = 1e-6


def _srgb_to_linear(channel):
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def _procedural_shape(config):
    return ProceduralShape(
        seed=config.procedural_seed,
        relief=config.shape.relief,
        crater_count=config.shape.crater_count,
        crater_depth=config.shape.crater_depth,
        axis_ratios=config.shape.axis_ratios,
    )


def _procedural_geometry(config, shape):
    directions, faces = geodesic_sphere(DEFAULT_FREQUENCY)
    vertices, _, _ = normalize_unit_radius(tuple(shape.point(d) for d in directions))
    provenance = (
        f"displaced geodesic icosphere, frequency {DEFAULT_FREQUENCY} "
        f"({len(faces):,} triangles), seed {config.procedural_seed}"
    )
    return vertices, faces, provenance


def _real_geometry(config, shape_root):
    source = validate_shape_source(config.shape_model)
    path = resolve_shape_path(shape_root, source)
    vertices, faces = load_shape_model(
        path,
        sha256=source.sha256,
        model_format=source.model_format,
        max_triangles=TRIANGLE_LIMIT,
    )
    provenance = (
        f"{source.dataset}, reduced to {len(faces):,} triangles by deterministic vertex clustering; "
        f"source SHA-256 `{source.sha256}`"
    )
    return vertices, faces, provenance


def _shape_model_is_available(config, shape_root):
    if config.shape_model is None or config.shape_model.sha256 is None:
        return False
    try:
        return resolve_shape_path(shape_root, config.shape_model).is_file()
    except ValueError:
        return False


def resolve_geometry(config, shape_mode, shape_root):
    """Return `(vertices, faces, provenance, used_shape_model)`."""
    if shape_mode not in SHAPE_MODES:
        raise ValueError(f'Unknown shape mode "{shape_mode}"; expected one of {", ".join(SHAPE_MODES)}')
    if shape_mode == "real":
        if config.shape_model is None:
            raise ValueError(f'No published shape model is registered for "{config.body_id}"')
        return (*_real_geometry(config, shape_root), True)
    if shape_mode == "auto" and _shape_model_is_available(config, shape_root):
        return (*_real_geometry(config, shape_root), True)
    return (*_procedural_geometry(config, _procedural_shape(config)), False)


def write_albedo(config, path):
    """Deterministic 1024x512 equirectangular regolith albedo.

    Ingest requires a 1k-2k 2:1 albedo for every asteroid and comet, so this is
    part of the contract rather than a nicety. Texel directions use the same
    longitude/latitude convention the mesh UVs do, and the mottling rides an
    independent noise channel of the same `proceduralSeed`.
    """
    base = tuple(_srgb_to_linear(channel) for channel in config.albedo_color)
    field = shade_field(_procedural_shape(config), ALBEDO_WIDTH, ALBEDO_HEIGHT)
    pixels = array("f", [0.0]) * (ALBEDO_WIDTH * ALBEDO_HEIGHT * 4)
    offset = 0
    for value in field:
        gain = ALBEDO_FLOOR + ALBEDO_RANGE * value
        pixels[offset] = base[0] * gain
        pixels[offset + 1] = base[1] * gain
        pixels[offset + 2] = base[2] * gain
        pixels[offset + 3] = 1.0
        offset += 4

    image = bpy.data.images.new(
        config.albedo_name.removesuffix(".png"),
        width=ALBEDO_WIDTH,
        height=ALBEDO_HEIGHT,
        alpha=False,
        float_buffer=False,
    )
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.filepath_raw = str(path)
    image.save()
    bpy.data.images.remove(image)
    return path


def _anchor_records(config):
    if config.coma is None:
        return ()
    return (
        (COMA_ANCHOR_NAME, config.coma.coma_radius_ratio),
        (TAIL_ANCHOR_NAME, config.coma.tail_length_ratio),
    )


def verify_anchors(glb_path, config):
    """Assert the T0139 anchor contract survived the export."""
    records = _anchor_records(config)
    if not records:
        return ()
    document = read_gltf_json(glb_path)
    nodes = {node.get("name"): node for node in document.get("nodes", ())}
    for name, scale in records:
        node = nodes.get(name)
        if node is None:
            raise RuntimeError(f'Comet GLB is missing the required "{name}" node')
        if "mesh" in node:
            raise RuntimeError(f'Anchor "{name}" must stay mesh-less')
        if any(abs(value) > ANCHOR_SCALE_TOLERANCE for value in node.get("translation", (0.0, 0.0, 0.0))):
            raise RuntimeError(f'Anchor "{name}" must sit at the nucleus origin')
        rotation = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
        if any(abs(value) > ANCHOR_SCALE_TOLERANCE for value in rotation[:3]) or abs(
            abs(rotation[3]) - 1.0
        ) > ANCHOR_SCALE_TOLERANCE:
            raise RuntimeError(f'Anchor "{name}" must keep an identity rotation')
        exported = node.get("scale")
        if exported is None or any(
            abs(value - scale) > ANCHOR_SCALE_TOLERANCE for value in exported
        ):
            raise RuntimeError(f'Anchor "{name}" must export uniform scale {scale}')
    return ANCHOR_NAMES


def _sources_text(config, builder, provenance, used_shape_model, triangles):
    heading = f"# Sources — {config.name}"
    if used_shape_model:
        source = config.shape_model
        geometry = (
            f"- `{config.body_id}.glb` — {source.credit} — {source.license} — {provenance}; "
            f"reprojected to the normalized authoring frame by `{builder}`."
        )
        pinned = (
            "",
            "## Pinned download",
            "",
            f"- Recipe id: `{source.id}` (role `{source.role}`, format `{source.model_format}`)",
            f"- Product page: {source.product_url}",
            f"- Exact download: {source.source_url}",
            f"- Pinned source SHA-256: `{source.sha256}`",
            f"- Fetched to: `assets/textures-src/{source.body_id}/{source.output_name}` "
            'by `tools/fetch_textures.py` (kind="file", ADR-039); verified, cached, never committed.',
        )
    else:
        geometry = (
            f"- `{config.body_id}.glb` — `{builder}`, seed {config.procedural_seed} — Solar Voyager "
            f"original asset; all rights reserved for project distribution — {provenance}."
        )
        pinned = ()

    lines = [
        heading,
        "",
        geometry,
        f"- `{config.albedo_name}` — `{builder}`, seed {config.procedural_seed} — Solar Voyager "
        "original asset; all rights reserved for project distribution — deterministic "
        f"{ALBEDO_WIDTH}×{ALBEDO_HEIGHT} equirectangular regolith albedo tinted by the catalog "
        "`visual.albedoColor`.",
        *pinned,
        "",
        "## Authoring contract",
        "",
        f"Normalized body: mesh radius exactly 1.0 unit, origin centred, north pole +Y after glTF "
        f"export. Applied geometry: {triangles:,} triangles (budget ≤{TRIANGLE_LIMIT:,}).",
    ]
    if config.coma is not None:
        lines.extend(
            (
                "",
                f"Coma and tail visuals (T0139) mount on the mesh-less nodes `{COMA_ANCHOR_NAME}` and "
                f"`{TAIL_ANCHOR_NAME}`. Both sit at the nucleus origin with identity rotation; their "
                "uniform scale carries the authored magnitude in nucleus radii — "
                f"coma radius {config.coma.coma_radius_ratio:g}, tail length "
                f"{config.coma.tail_length_ratio:g}. Direction is computed at runtime, never authored.",
            )
        )
    return "\n".join(lines) + "\n"


def write_sources(config, output_dir, builder, provenance, used_shape_model, triangles):
    path = pathlib.Path(output_dir) / "SOURCES.md"
    path.write_text(
        _sources_text(config, builder, provenance, used_shape_model, triangles),
        encoding="utf-8",
        newline="\n",
    )
    return path


def build_small_body(
    body_id,
    *,
    expected_kind,
    builder,
    output_root,
    shape_mode="auto",
    shape_root=SHAPE_ROOT,
):
    config = small_body_config(body_id, expected_kind=expected_kind, models_root=output_root)
    output_dir = pathlib.Path(config.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    vertices, faces, provenance, used_shape_model = resolve_geometry(config, shape_mode, shape_root)
    if len(faces) > TRIANGLE_LIMIT:
        raise RuntimeError(
            f"{config.name} geometry has {len(faces)} triangles; the budget is {TRIANGLE_LIMIT}"
        )

    reset_scene()
    surface = create_displaced_body(body_id, vertices, faces)
    albedo_path = write_albedo(config, output_dir / config.albedo_name)
    surface.data.materials.append(
        create_pbr_material(
            SURFACE_MATERIAL_NAME, roughness=SURFACE_ROUGHNESS, albedo_path=albedo_path
        )
    )
    anchors = tuple(create_anchor(name, scale) for name, scale in _anchor_records(config))

    glb_path = export_glb((surface, *anchors), output_dir / f"{body_id}.glb", active=surface)
    canonicalize_mesh_normals(glb_path)
    verify_anchors(glb_path, config)

    manifest = build_manifest(body_id, config.category, (surface,), glb_path, (albedo_path,))
    manifest["shapeSource"] = "shape-model" if used_shape_model else "procedural"
    manifest["proceduralSeed"] = config.procedural_seed
    if config.coma is not None:
        manifest["anchors"] = list(ANCHOR_NAMES)
    write_sources(config, output_dir, builder, provenance, used_shape_model, manifest["triangles"])
    print_manifest(manifest)

    if not 0 < manifest["triangles"] <= TRIANGLE_LIMIT:
        raise RuntimeError(
            f'{config.name} emitted {manifest["triangles"]} triangles; expected 1–{TRIANGLE_LIMIT}'
        )
    if abs(manifest["radius"] - 1.0) > RADIUS_TOLERANCE:
        raise RuntimeError(f'{config.name} radius is {manifest["radius"]}, expected 1.0')
    return manifest
