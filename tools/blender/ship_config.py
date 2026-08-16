"""Blender-free part table for the Solar Voyager ship (build_ship.py v2).

This module owns every dimension, node name and material parameter of the
vessel. It imports nothing from Blender, so the whole model is unit-testable
(`tools/tests/test_blender_ship_config.py`) and the builder stays a thin
adapter that turns :class:`ShipPart` records into Blender objects.

Node-name contract — these names are API, consumed by other code:

===================  =========================================================
``hull_tip``         Nose marker. ``src/render/shipVisual.ts`` reads this node
                     out of the loaded glTF and requires its world offset from
                     the model root to be the ADR-025 forward direction, so its
                     origin must stay exactly on ``+X``.
``engine_nozzle``    Plume attachment (T0122). Its origin is the nozzle throat;
                     the bell opens aft to the tail extreme.
``rcs_pod_1..4``     RCS puff emitters (T0122). Numbering is
                     1 = forward port, 2 = forward starboard,
                     3 = aft port, 4 = aft starboard. Each origin is the pod
                     centre, so a puff spawned at the node origin sits in the
                     middle of its four thruster bells.
``light_nav_l``      Port navigation light (red), at the port radiator tip.
``light_nav_r``      Starboard navigation light (green), at the starboard tip.
``light_beacon``     Dorsal anti-collision beacon (white), on the spine.
``cockpit_eye``      Empty at the pilot eye point inside the canopy, for the
                     T0124 cockpit camera. It carries no geometry.
``canopy``           The glass shell itself, kept separate so T0124 can treat
                     it as the cockpit frame silhouette.
===================  =========================================================

Frame: ``+X`` nose/thrust, ``+Z`` dorsal, ``+Y`` port (see ``ship_geometry``).
One Blender unit is one metre.
"""

import math
from typing import NamedTuple, Optional, Tuple

from ship_geometry import (
    MeshData,
    ProfilePoint,
    Vector3,
    arc_lengths,
    chamfered_box,
    disc,
    lathe,
    merge,
    ring_direction,
    roll_rotation,
    rotation_from_axis,
    torus,
    transform,
)


#: Authored overall length in metres; mirrored by `SHIP_LENGTH_M` in
#: `src/render/shipVisual.ts` and by the chase-camera arm tests. Changing it is
#: a cross-cutting contract change, not a modelling decision.
SHIP_LENGTH_METERS = 26.12
NOSE_TIP_X = 13.12
NOZZLE_EXIT_X = -13.0

HULL_SEGMENTS = 72
NOZZLE_SEGMENTS = 72
TIP_SEGMENTS = 48

#: Where the separately named nose node begins.
TIP_ORIGIN_X = 12.0
#: Nozzle throat: the `engine_nozzle` node origin, on the +X axis.
NOZZLE_ORIGIN_X = -11.5

#: Fuselage profile, tail to nose. `smooth=False` marks a deliberate crease:
#: the radius steps are the primary panel breakup in the silhouette.
HULL_PROFILE: Tuple[ProfilePoint, ...] = (
    ProfilePoint(-10.00, 2.28, False),
    ProfilePoint(-9.60, 2.44, False),
    ProfilePoint(-8.40, 2.46, False),
    ProfilePoint(-8.30, 2.12, False),
    ProfilePoint(-6.20, 2.14, True),
    ProfilePoint(-5.90, 2.24, False),
    ProfilePoint(-4.60, 2.24, False),
    ProfilePoint(-4.45, 2.06, False),
    ProfilePoint(-2.00, 2.08, True),
    ProfilePoint(-1.80, 2.16, False),
    ProfilePoint(1.40, 2.16, False),
    ProfilePoint(1.55, 2.02, False),
    ProfilePoint(4.60, 2.02, True),
    ProfilePoint(5.00, 1.96, True),
    ProfilePoint(6.40, 1.86, True),
    ProfilePoint(7.60, 1.72, True),
    ProfilePoint(8.80, 1.54, True),
    ProfilePoint(9.90, 1.32, True),
    ProfilePoint(10.80, 1.08, True),
    ProfilePoint(11.50, 0.82, True),
    ProfilePoint(TIP_ORIGIN_X, 0.62, False),
)

#: Nose cap, in world stations; the last one fixes the ship's forward extreme.
TIP_PROFILE: Tuple[ProfilePoint, ...] = (
    ProfilePoint(TIP_ORIGIN_X, 0.62, False),
    ProfilePoint(12.24, 0.595, True),
    ProfilePoint(12.48, 0.545, True),
    ProfilePoint(12.70, 0.475, True),
    ProfilePoint(12.88, 0.385, True),
    ProfilePoint(13.02, 0.275, True),
    ProfilePoint(NOSE_TIP_X, 0.10, True),
)

_HULL_UV_PROFILE: Tuple[ProfilePoint, ...] = HULL_PROFILE + TIP_PROFILE[1:]
_HULL_UV_ARC = arc_lengths(_HULL_UV_PROFILE)


class ShipPart(NamedTuple):
    """One exported node: a named mesh with its material, or a bare marker."""

    name: str
    material: Optional[str]
    origin: Vector3
    mesh: Optional[MeshData]


class MaterialSpec(NamedTuple):
    """Principled BSDF parameters; texture wiring lives in the builder."""

    name: str
    base_color: Tuple[float, float, float, float]
    roughness: float
    metallic: float
    emissive_color: Optional[Tuple[float, float, float, float]] = None
    emissive_strength: float = 1.0


MATERIALS: Tuple[MaterialSpec, ...] = (
    MaterialSpec("mat_canopy", (0.008, 0.016, 0.026, 1.0), 0.06, 0.0),
    MaterialSpec("mat_engine_glow", (0.02, 0.05, 0.08, 1.0), 0.2, 0.0, None, 2.0),
    MaterialSpec("mat_hull", (0.72, 0.73, 0.75, 1.0), 0.35, 0.85),
    MaterialSpec("mat_hull_dark", (0.13, 0.14, 0.16, 1.0), 0.45, 0.8),
    # Baseline emission only: the asset should read as "lights on" before T0122
    # exists, while leaving the blink/intensity animation to the render layer.
    MaterialSpec("mat_light_beacon", (0.9, 0.9, 0.92, 1.0), 0.2, 0.0, (1.0, 0.97, 0.92, 1.0), 1.4),
    MaterialSpec("mat_light_nav_l", (0.45, 0.03, 0.03, 1.0), 0.2, 0.0, (1.0, 0.06, 0.05, 1.0), 1.2),
    MaterialSpec("mat_light_nav_r", (0.03, 0.42, 0.08, 1.0), 0.2, 0.0, (0.06, 1.0, 0.18, 1.0), 1.2),
    MaterialSpec("mat_nozzle", (0.18, 0.18, 0.2, 1.0), 0.3, 1.0),
    MaterialSpec("mat_radiator", (0.09, 0.02, 0.02, 1.0), 0.65, 0.2),
)

#: Node names other tasks resolve by string. Losing one is an API break.
REQUIRED_NODE_NAMES: Tuple[str, ...] = (
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


def hull_radius_at(x: float) -> float:
    """Fuselage radius at an axial station, for seating greebles on the skin."""
    profile = _HULL_UV_PROFILE
    if x <= profile[0].x:
        return profile[0].radius
    if x >= profile[-1].x:
        return profile[-1].radius
    for index in range(len(profile) - 1):
        start = profile[index]
        end = profile[index + 1]
        if start.x <= x <= end.x:
            fraction = (x - start.x) / (end.x - start.x)
            return start.radius + (end.radius - start.radius) * fraction
    return profile[-1].radius


def hull_v_at(x: float) -> float:
    """Texture ``V`` for an axial station: profile arc length, tail 0 to nose 1.

    Using arc length rather than ``x`` keeps the panel grid from stretching
    across the radius steps and down the nose taper.
    """
    profile = _HULL_UV_PROFILE
    total = _HULL_UV_ARC[-1]
    if x <= profile[0].x:
        return 0.0
    if x >= profile[-1].x:
        return 1.0
    for index in range(len(profile) - 1):
        start = profile[index]
        end = profile[index + 1]
        if start.x <= x <= end.x:
            fraction = (x - start.x) / (end.x - start.x)
            arc = _HULL_UV_ARC[index] + (_HULL_UV_ARC[index + 1] - _HULL_UV_ARC[index]) * fraction
            return arc / total
    return 1.0


def project_hull_uvs(mesh: MeshData) -> MeshData:
    """Cylindrical hull unwrap: ``U`` is the ring angle, ``V`` is ``hull_v_at``.

    Applied after placement, so ribs, plates and blisters inherit exactly the
    hull's panel grid instead of each carrying its own texture scale. Faces that
    straddle the dorsal seam are shifted past ``u = 1`` the same way
    `common/geometry.py` handles the equirectangular seam.
    """
    uv_faces = []
    for face in mesh.faces:
        corners = []
        for index in face:
            x, y, z = mesh.vertices[index]
            corners.append(
                [(math.atan2(-y, z) / (2.0 * math.pi)) % 1.0, hull_v_at(x), math.hypot(y, z)]
            )
        values = [corner[0] for corner in corners if corner[2] > 1e-9]
        if values and max(values) - min(values) > 0.5:
            for corner in corners:
                if corner[0] < 0.5:
                    corner[0] += 1.0
            values = [corner[0] for corner in corners if corner[2] > 1e-9]
        axis_u = sum(values) / len(values) if values else 0.0
        uv_faces.append(
            tuple(
                (axis_u if corner[2] <= 1e-9 else corner[0], corner[1]) for corner in corners
            )
        )
    return mesh._replace(uv_faces=tuple(uv_faces))


def project_radial_uvs(mesh: MeshData, radius: float) -> MeshData:
    """Glow-disc unwrap: ``U`` is the radius fraction, ``V`` is the ring angle.

    `tools/textures/generateShipTextures.mjs` authors the emissive map against
    exactly this convention, so the white-hot core lands on the throat centre.
    """
    if radius <= 0.0:
        raise ValueError("Radial UV projection requires a positive radius")
    uv_faces = []
    for face in mesh.faces:
        corners = []
        for index in face:
            _, y, z = mesh.vertices[index]
            distance = math.hypot(y, z)
            corners.append(
                [min(1.0, distance / radius), (math.atan2(-y, z) / (2.0 * math.pi)) % 1.0, distance]
            )
        values = [corner[1] for corner in corners if corner[2] > 1e-9]
        if values and max(values) - min(values) > 0.5:
            for corner in corners:
                if corner[1] < 0.5:
                    corner[1] += 1.0
            values = [corner[1] for corner in corners if corner[2] > 1e-9]
        axis_v = sum(values) / len(values) if values else 0.0
        uv_faces.append(
            tuple((corner[0], axis_v if corner[2] <= 1e-9 else corner[1]) for corner in corners)
        )
    return mesh._replace(uv_faces=tuple(uv_faces))


def _on_hull(mesh: MeshData, x: float, angle: float, standoff: float) -> MeshData:
    """Roll a flat-authored greeble onto the hull skin at (station, angle)."""
    direction = ring_direction(angle)
    distance = hull_radius_at(x) + standoff
    return transform(
        mesh,
        rotation=roll_rotation(angle),
        translation=(x, direction[1] * distance, direction[2] * distance),
    )


def _rib(x: float, height: float, half_length: float, standoff: float) -> MeshData:
    radius = hull_radius_at(x) + standoff
    return lathe(
        (
            ProfilePoint(x - half_length, radius - 0.01, False),
            ProfilePoint(x - half_length * 0.6, radius + height, False),
            ProfilePoint(x + half_length * 0.6, radius + height, False),
            ProfilePoint(x + half_length, radius - 0.01, False),
        ),
        HULL_SEGMENTS,
        with_uvs=False,
    )


_HULL_RIB_STATIONS = (-7.2, -3.1, 0.4, 3.6, 6.9)
#: Dark collars sit on constant-radius runs, never on a profile step, so they
#: stay proud of the skin instead of half-swallowed by the neighbouring band.
_HULL_COLLAR_STATIONS = (-9.00, -5.30, 2.60)

#: (station, ring angle in degrees, half extents) for the bolt-on hull plates.
_HULL_PLATES = (
    (-8.90, 40.0, (0.42, 0.30, 0.05)),
    (-8.90, 320.0, (0.42, 0.30, 0.05)),
    (-6.60, 150.0, (0.62, 0.34, 0.055)),
    (-5.20, 210.0, (0.48, 0.26, 0.05)),
    (-3.40, 60.0, (0.70, 0.38, 0.06)),
    (-2.60, 300.0, (0.55, 0.30, 0.05)),
    (-0.60, 120.0, (0.66, 0.36, 0.055)),
    (0.90, 240.0, (0.58, 0.32, 0.05)),
    (2.20, 25.0, (0.50, 0.28, 0.05)),
    (2.90, 335.0, (0.50, 0.28, 0.05)),
    (4.90, 160.0, (0.44, 0.24, 0.045)),
    (5.60, 200.0, (0.44, 0.24, 0.045)),
    (8.00, 45.0, (0.38, 0.20, 0.04)),
    (8.40, 315.0, (0.38, 0.20, 0.04)),
)


def _hull_mesh() -> MeshData:
    parts = [
        lathe(HULL_PROFILE, HULL_SEGMENTS, with_uvs=False),
        disc(HULL_PROFILE[0].x, HULL_PROFILE[0].radius, HULL_SEGMENTS, facing=-1.0, with_uvs=False),
    ]
    for station in _HULL_RIB_STATIONS:
        parts.append(_rib(station, 0.10, 0.18, 0.0))
    for station, degrees, extents in _HULL_PLATES:
        parts.append(
            _on_hull(
                chamfered_box(extents, min(extents) * 0.35),
                station,
                math.radians(degrees),
                extents[2] * 0.5,
            )
        )
    return project_hull_uvs(merge(parts))


def _tip_mesh() -> MeshData:
    shell = lathe(TIP_PROFILE, TIP_SEGMENTS, with_uvs=False)
    cap = disc(NOSE_TIP_X, TIP_PROFILE[-1].radius, TIP_SEGMENTS, facing=1.0, with_uvs=False)
    return project_hull_uvs(merge((shell, cap)))


#: (station, ring angle, half extents) for the dark structural greebles.
_FRAME_BOXES = (
    (-8.00, 0.0, (1.70, 0.28, 0.22)),
    (-4.40, 0.0, (1.70, 0.28, 0.22)),
    (-0.80, 0.0, (1.70, 0.28, 0.22)),
    (2.80, 0.0, (1.70, 0.28, 0.22)),
    (-7.00, 180.0, (1.90, 0.34, 0.18)),
    (-3.00, 180.0, (1.90, 0.34, 0.18)),
    (1.00, 180.0, (1.90, 0.34, 0.18)),
    (-9.10, 75.0, (0.55, 0.40, 0.16)),
    (-9.10, 285.0, (0.55, 0.40, 0.16)),
    (-6.80, 45.0, (0.42, 0.30, 0.13)),
    (-6.80, 315.0, (0.42, 0.30, 0.13)),
    (-1.20, 100.0, (0.36, 0.26, 0.11)),
    (-1.20, 260.0, (0.36, 0.26, 0.11)),
    (3.90, 135.0, (0.34, 0.22, 0.10)),
    (3.90, 225.0, (0.34, 0.22, 0.10)),
    (9.30, 0.0, (0.60, 0.24, 0.12)),
)

#: Canopy frame rails and arches, placed in absolute coordinates.
_CANOPY_FRAME = (
    ((6.65, 0.74, 1.72), (1.62, 0.06, 0.30), 0.02),
    ((6.65, -0.74, 1.72), (1.62, 0.06, 0.30), 0.02),
    ((5.10, 0.0, 1.78), (0.07, 0.42, 0.34), 0.02),
    ((8.20, 0.0, 1.76), (0.07, 0.30, 0.26), 0.02),
)


def _frame_mesh() -> MeshData:
    parts = []
    for station, degrees, extents in _FRAME_BOXES:
        parts.append(
            _on_hull(
                chamfered_box(extents, min(extents) * 0.3), station, math.radians(degrees), extents[2] * 0.55
            )
        )
    for center, extents, chamfer in _CANOPY_FRAME:
        parts.append(transform(chamfered_box(extents, chamfer), translation=center))
    for station in _HULL_COLLAR_STATIONS:
        parts.append(_rib(station, 0.07, 0.14, 0.02))

    # Docking collar around the nose taper.
    parts.append(transform(torus(1.10, 0.10, 48, 8), translation=(11.00, 0.0, 0.0)))

    # Antenna mast and dish on the dorsal spine.
    mast_base = hull_radius_at(-1.50) + 0.18
    mast = lathe(
        (
            ProfilePoint(0.0, 0.075, False),
            ProfilePoint(0.55, 0.065, True),
            ProfilePoint(1.10, 0.055, False),
        ),
        16,
        with_uvs=False,
    )
    mast = merge(
        (
            mast,
            disc(0.0, 0.075, 16, facing=-1.0, with_uvs=False),
            disc(1.10, 0.055, 16, facing=1.0, with_uvs=False),
        )
    )
    parts.append(
        transform(
            mast,
            rotation=rotation_from_axis((0.0, 0.0, 1.0)),
            translation=(-1.50, 0.0, mast_base),
        )
    )
    dish_profile = (
        ProfilePoint(0.0, 0.10, False),
        ProfilePoint(0.06, 0.26, True),
        ProfilePoint(0.14, 0.42, True),
        ProfilePoint(0.24, 0.54, True),
        ProfilePoint(0.34, 0.60, False),
    )
    # Both faces: the flipped copy is the collecting dish the camera sees from
    # above, the unflipped copy its back, so the antenna is not a one-sided
    # sheet that vanishes when the chase camera swings underneath.
    dish = merge(
        (
            lathe(dish_profile, 32, with_uvs=False, flip=True),
            lathe(
                tuple(ProfilePoint(point.x + 0.03, point.radius, point.smooth) for point in dish_profile),
                32,
                with_uvs=False,
            ),
        )
    )
    parts.append(
        transform(
            dish,
            rotation=rotation_from_axis((0.35, 0.0, 0.94)),
            translation=(-1.50, 0.0, mast_base + 1.05),
        )
    )
    return merge(parts)


def _drive_ring_mesh() -> MeshData:
    parts = [transform(torus(3.40, 0.32, 64, 10), translation=(-4.00, 0.0, 0.0))]
    for index in range(4):
        angle = math.radians(45.0 + 90.0 * index)
        direction = ring_direction(angle)
        distance = (hull_radius_at(-4.0) + 3.08) * 0.5
        parts.append(
            transform(
                chamfered_box((0.40, 0.16, 0.58), 0.05),
                rotation=roll_rotation(angle),
                translation=(-4.00, direction[1] * distance, direction[2] * distance),
            )
        )
    return merge(parts)


def _engine_skirt_mesh() -> MeshData:
    skirt = lathe(
        (
            ProfilePoint(-11.60, 2.02, False),
            ProfilePoint(-11.35, 2.20, True),
            ProfilePoint(-10.90, 2.42, True),
            ProfilePoint(-10.35, 2.46, False),
            ProfilePoint(-10.00, 2.30, False),
        ),
        64,
        with_uvs=False,
    )
    parts = [
        skirt,
        disc(-11.60, 2.02, 64, facing=-1.0, with_uvs=False, inner_radius=1.30),
    ]
    for angle_degrees in (55.0, 125.0, 235.0, 305.0):
        angle = math.radians(angle_degrees)
        direction = ring_direction(angle)
        pump = lathe(
            (
                ProfilePoint(-10.95, 0.20, False),
                ProfilePoint(-10.60, 0.24, True),
                ProfilePoint(-10.10, 0.22, False),
            ),
            16,
            with_uvs=False,
        )
        pump = merge(
            (
                pump,
                disc(-10.95, 0.20, 16, facing=-1.0, with_uvs=False),
                disc(-10.10, 0.22, 16, facing=1.0, with_uvs=False),
            )
        )
        parts.append(
            transform(pump, translation=(0.0, direction[1] * 1.72, direction[2] * 1.72))
        )
    for index in range(6):
        angle = math.radians(30.0 + 60.0 * index)
        direction = ring_direction(angle)
        line = merge(
            (
                lathe(
                    (ProfilePoint(-11.30, 0.055, False), ProfilePoint(-9.70, 0.055, False)),
                    10,
                    with_uvs=False,
                ),
                disc(-11.30, 0.055, 10, facing=-1.0, with_uvs=False),
                disc(-9.70, 0.055, 10, facing=1.0, with_uvs=False),
            )
        )
        parts.append(
            transform(line, translation=(0.0, direction[1] * 2.16, direction[2] * 2.16))
        )
    return merge(parts)


def _engine_assembly_mesh() -> MeshData:
    throat = lathe(
        (
            ProfilePoint(-11.50, 1.05, False),
            ProfilePoint(-11.20, 1.12, True),
            ProfilePoint(-10.90, 1.22, True),
            ProfilePoint(-10.60, 1.30, False),
        ),
        48,
        with_uvs=False,
    )
    parts = [
        throat,
        disc(-10.60, 1.30, 48, facing=1.0, with_uvs=False, inner_radius=0.55),
        transform(torus(1.22, 0.13, 40, 8), translation=(-11.50, 0.0, 0.0)),
    ]
    for index in range(16):
        angle = 2.0 * math.pi * index / 16
        direction = ring_direction(angle)
        pipe = lathe(
            (
                ProfilePoint(-11.45, 0.045, False),
                ProfilePoint(-11.00, 0.05, True),
                ProfilePoint(-10.62, 0.045, False),
            ),
            8,
            with_uvs=False,
        )
        parts.append(
            transform(pipe, translation=(0.0, direction[1] * 1.30, direction[2] * 1.30))
        )
    # Stiffener hoops on the bell exterior. Without them the aft three-quarter
    # view — the one the chase camera holds most of the time — is a bare cone.
    for station, radius in _NOZZLE_STIFFENERS:
        parts.append(transform(torus(radius + 0.035, 0.055, 48, 6), translation=(station, 0.0, 0.0)))
    return merge(parts)


#: Bell wall thickness; the liner is this far inside the outer profile.
NOZZLE_WALL = 0.05

#: Bell exterior, local to the `engine_nozzle` origin at the throat.
NOZZLE_PROFILE: Tuple[ProfilePoint, ...] = (
    ProfilePoint(-1.50, 1.94, False),
    ProfilePoint(-1.45, 1.90, True),
    ProfilePoint(-1.37, 1.85, True),
    ProfilePoint(-1.25, 1.78, True),
    ProfilePoint(-1.10, 1.69, True),
    ProfilePoint(-0.92, 1.57, True),
    ProfilePoint(-0.72, 1.44, True),
    ProfilePoint(-0.52, 1.31, True),
    ProfilePoint(-0.32, 1.19, True),
    ProfilePoint(-0.15, 1.10, True),
    ProfilePoint(0.0, 1.05, False),
)

_NOZZLE_STIFFENERS = tuple(
    (NOZZLE_ORIGIN_X + point.x, point.radius)
    for point in (NOZZLE_PROFILE[4], NOZZLE_PROFILE[6], NOZZLE_PROFILE[8])
)


def _nozzle_mesh() -> MeshData:
    """Bell shell, local to the throat origin, open at the throat.

    Modelled as a real shell — outer wall, 5 cm liner, rim annulus — because at
    chase range the camera looks straight into the bell, and a single-sided
    cone would show the inside of the ship through it.
    """
    inner = tuple(
        ProfilePoint(point.x, point.radius - NOZZLE_WALL, point.smooth)
        for point in NOZZLE_PROFILE
    )
    return merge(
        (
            lathe(NOZZLE_PROFILE, NOZZLE_SEGMENTS, with_uvs=False),
            lathe(inner, NOZZLE_SEGMENTS, with_uvs=False, flip=True),
            disc(
                NOZZLE_PROFILE[0].x,
                NOZZLE_PROFILE[0].radius,
                NOZZLE_SEGMENTS,
                facing=-1.0,
                with_uvs=False,
                inner_radius=inner[0].radius,
            ),
        )
    )


def _glow_disc_mesh() -> MeshData:
    well = lathe(
        (
            ProfilePoint(-12.60, 0.10, False),
            ProfilePoint(-12.50, 0.55, True),
            ProfilePoint(-12.40, 0.95, True),
            ProfilePoint(-12.28, 1.28, True),
            ProfilePoint(-12.15, 1.58, False),
        ),
        64,
        with_uvs=False,
        flip=True,
    )
    core = disc(-12.60, 0.10, 64, facing=-1.0, with_uvs=False)
    return project_radial_uvs(merge((well, core)), 1.58)


def _radiator_mesh(sign: float) -> MeshData:
    parts = [transform(chamfered_box((1.55, 1.78, 0.035), 0.025), translation=(1.60, sign * 4.13, 0.0))]
    for index in range(8):
        offset = -1.40 + index * 0.40
        parts.append(
            transform(
                chamfered_box((0.05, 1.74, 0.075), 0.02),
                translation=(1.60 + offset, sign * 4.13, 0.0),
            )
        )
    for offset in (-0.85, 0.85):
        parts.append(
            transform(
                chamfered_box((0.14, 0.42, 0.12), 0.03),
                translation=(1.60 + offset, sign * 2.30, 0.0),
            )
        )
    return merge(parts)


def _canopy_mesh() -> MeshData:
    shell = lathe(
        (
            ProfilePoint(-1.65, 0.08, False),
            ProfilePoint(-1.35, 0.30, True),
            ProfilePoint(-0.95, 0.52, True),
            ProfilePoint(-0.45, 0.70, True),
            ProfilePoint(0.10, 0.78, True),
            ProfilePoint(0.60, 0.75, True),
            ProfilePoint(1.05, 0.63, True),
            ProfilePoint(1.40, 0.42, True),
            ProfilePoint(1.65, 0.10, False),
        ),
        48,
        with_uvs=False,
    )
    return transform(shell, scale=(1.0, 1.0, 0.85), translation=(6.65, 0.0, 1.72))


#: (station, ring angle) of the four RCS quads; index order defines the names.
RCS_POD_STATIONS = (
    (5.60, 270.0),
    (5.60, 90.0),
    (-6.40, 270.0),
    (-6.40, 90.0),
)
RCS_POD_STANDOFF = 0.24


def rcs_pod_origin(index: int) -> Vector3:
    """World origin of ``rcs_pod_<index+1>``; T0122 spawns puffs here."""
    station, degrees = RCS_POD_STATIONS[index]
    angle = math.radians(degrees)
    direction = ring_direction(angle)
    distance = hull_radius_at(station) + RCS_POD_STANDOFF
    return (station, direction[1] * distance, direction[2] * distance)


def _rcs_pod_mesh() -> MeshData:
    """One RCS quad in pod-local axes: ``+Z`` outward, ``+X`` fore, ``+Y`` up."""
    parts = [
        chamfered_box((0.50, 0.30, 0.22), 0.04),
        transform(chamfered_box((0.56, 0.36, 0.06), 0.02), translation=(0.0, 0.0, -0.20)),
    ]
    for direction, position in (
        ((1.0, 0.0, 0.0), (0.52, 0.0, 0.02)),
        ((-1.0, 0.0, 0.0), (-0.52, 0.0, 0.02)),
        ((0.0, 1.0, 0.0), (0.0, 0.32, 0.02)),
        ((0.0, -1.0, 0.0), (0.0, -0.32, 0.02)),
    ):
        bell = lathe(
            (
                ProfilePoint(0.0, 0.05, False),
                ProfilePoint(0.06, 0.075, True),
                ProfilePoint(0.12, 0.105, True),
                ProfilePoint(0.16, 0.13, False),
            ),
            16,
            with_uvs=False,
        )
        parts.append(
            transform(bell, rotation=rotation_from_axis(direction), translation=position)
        )
    return merge(parts)


#: (node name, origin, outward axis) for the three running lights.
LIGHT_FIXTURES = (
    ("light_nav_l", (1.60, 6.02, 0.0), (0.0, 1.0, 0.0)),
    ("light_nav_r", (1.60, -6.02, 0.0), (0.0, -1.0, 0.0)),
    ("light_beacon", (-2.90, 0.0, 2.55), (0.0, 0.0, 1.0)),
)

#: Pilot eye point: inside the canopy shell, low enough to see over the nose.
COCKPIT_EYE_ORIGIN: Vector3 = (6.40, 0.0, 1.75)


def _light_mesh() -> MeshData:
    """Housing plus lens, authored aiming ``+X`` and rotated onto its axis."""
    housing = transform(chamfered_box((0.09, 0.13, 0.13), 0.025), translation=(-0.06, 0.0, 0.0))
    lens = lathe(
        (
            ProfilePoint(0.02, 0.115, False),
            ProfilePoint(0.07, 0.10, True),
            ProfilePoint(0.11, 0.072, True),
            ProfilePoint(0.14, 0.03, False),
        ),
        16,
        with_uvs=False,
    )
    cap = disc(0.14, 0.03, 16, facing=1.0, with_uvs=False)
    return merge((housing, lens, cap))


def ship_parts() -> Tuple[ShipPart, ...]:
    """The complete export list, in the order the builder creates objects."""
    parts = [
        ShipPart("hull", "mat_hull", (0.0, 0.0, 0.0), _hull_mesh()),
        ShipPart(
            "hull_tip",
            "mat_hull",
            (TIP_ORIGIN_X, 0.0, 0.0),
            transform(_tip_mesh(), translation=(-TIP_ORIGIN_X, 0.0, 0.0)),
        ),
        ShipPart("hull_frame", "mat_hull_dark", (0.0, 0.0, 0.0), _frame_mesh()),
        ShipPart("drive_ring", "mat_hull_dark", (0.0, 0.0, 0.0), _drive_ring_mesh()),
        ShipPart("engine_skirt", "mat_hull_dark", (0.0, 0.0, 0.0), _engine_skirt_mesh()),
        ShipPart("engine_assembly", "mat_nozzle", (0.0, 0.0, 0.0), _engine_assembly_mesh()),
        ShipPart("engine_nozzle", "mat_nozzle", (NOZZLE_ORIGIN_X, 0.0, 0.0), _nozzle_mesh()),
        ShipPart("engine_glow_disc", "mat_engine_glow", (0.0, 0.0, 0.0), _glow_disc_mesh()),
        ShipPart("radiator_P", "mat_radiator", (0.0, 0.0, 0.0), _radiator_mesh(1.0)),
        ShipPart("radiator_S", "mat_radiator", (0.0, 0.0, 0.0), _radiator_mesh(-1.0)),
        ShipPart("canopy", "mat_canopy", (0.0, 0.0, 0.0), _canopy_mesh()),
    ]
    pod = _rcs_pod_mesh()
    for index, (_, degrees) in enumerate(RCS_POD_STATIONS):
        parts.append(
            ShipPart(
                f"rcs_pod_{index + 1}",
                "mat_hull_dark",
                rcs_pod_origin(index),
                transform(pod, rotation=roll_rotation(math.radians(degrees))),
            )
        )
    lens = _light_mesh()
    for name, origin, axis in LIGHT_FIXTURES:
        parts.append(
            ShipPart(name, f"mat_{name}", origin, transform(lens, rotation=rotation_from_axis(axis)))
        )
    parts.append(ShipPart("cockpit_eye", None, COCKPIT_EYE_ORIGIN, None))
    return tuple(parts)


def triangle_total(parts: Tuple[ShipPart, ...]) -> int:
    """Triangles after fan triangulation, matching what the GLB will contain."""
    return sum(part.mesh.triangles for part in parts if part.mesh is not None)


def measured_length(parts: Tuple[ShipPart, ...]) -> float:
    """Overall ``X`` extent in metres, measured from placed vertices."""
    minimum = math.inf
    maximum = -math.inf
    for part in parts:
        if part.mesh is None:
            continue
        for vertex in part.mesh.vertices:
            x = vertex[0] + part.origin[0]
            minimum = min(minimum, x)
            maximum = max(maximum, x)
    return maximum - minimum
