"""Contract tests for the ship part table (T0121).

These run without Blender, so the node-name API, the ADR-025 axis, the metre
scale and the triangle band are all gated by `npm run test:tools` in CI even
though `npm run test:blender` needs a local Blender install.
"""

import math
import pathlib
import sys
import unittest


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "tools" / "blender"))

import ship_config  # noqa: E402
from ship_config import (  # noqa: E402
    LIGHT_FIXTURES,
    MATERIALS,
    NOSE_TIP_X,
    NOZZLE_ORIGIN_X,
    RCS_POD_STATIONS,
    REQUIRED_NODE_NAMES,
    SHIP_LENGTH_METERS,
    TIP_ORIGIN_X,
    hull_radius_at,
    hull_v_at,
    measured_length,
    project_hull_uvs,
    project_radial_uvs,
    ship_parts,
    triangle_total,
)
from ship_geometry import disc, lathe, ProfilePoint  # noqa: E402


#: Acceptance band from tasks/T0121-ship-remodel.yaml, against a 30,000 budget.
TRIANGLE_MINIMUM = 18_000
TRIANGLE_MAXIMUM = 28_000

PARTS = ship_parts()
BY_NAME = {part.name: part for part in PARTS}


class NodeContractTest(unittest.TestCase):
    """Node names are API: T0122 and T0124 resolve them by string."""

    def test_every_required_node_is_present(self):
        for name in REQUIRED_NODE_NAMES:
            self.assertIn(name, BY_NAME, f"missing contract node {name}")

    def test_legacy_node_names_survive_the_remodel(self):
        for name in ("hull_tip", "engine_nozzle", "engine_glow_disc", "radiator_P", "radiator_S"):
            self.assertIn(name, BY_NAME)

    def test_names_are_unique(self):
        names = [part.name for part in PARTS]
        self.assertEqual(len(names), len(set(names)))

    def test_cockpit_eye_is_a_meshless_marker_inside_the_canopy(self):
        eye = BY_NAME["cockpit_eye"]
        self.assertIsNone(eye.mesh)
        self.assertIsNone(eye.material)
        canopy = BY_NAME["canopy"]
        xs = [vertex[0] for vertex in canopy.mesh.vertices]
        zs = [vertex[2] for vertex in canopy.mesh.vertices]
        self.assertGreater(eye.origin[0], min(xs))
        self.assertLess(eye.origin[0], max(xs))
        self.assertGreater(eye.origin[2], min(zs))
        self.assertLess(eye.origin[2], max(zs))

    def test_only_the_marker_lacks_geometry(self):
        for part in PARTS:
            if part.name == "cockpit_eye":
                continue
            self.assertIsNotNone(part.mesh, part.name)
            self.assertIsNotNone(part.material, part.name)


class AxisContractTest(unittest.TestCase):
    """ADR-025: local +X is both the nose and the thrust axis."""

    def test_hull_tip_sits_on_the_positive_x_axis(self):
        origin = BY_NAME["hull_tip"].origin
        self.assertGreater(origin[0], 0.0)
        self.assertEqual((origin[1], origin[2]), (0.0, 0.0))

    def test_nozzle_sits_on_the_axis_behind_the_tip(self):
        origin = BY_NAME["engine_nozzle"].origin
        self.assertEqual((origin[1], origin[2]), (0.0, 0.0))
        self.assertLess(origin[0], BY_NAME["hull_tip"].origin[0])
        self.assertEqual(origin[0], NOZZLE_ORIGIN_X)

    def test_tip_to_nozzle_delta_is_pure_positive_x(self):
        tip = BY_NAME["hull_tip"].origin
        nozzle = BY_NAME["engine_nozzle"].origin
        delta = tuple(tip[axis] - nozzle[axis] for axis in range(3))
        length = math.sqrt(sum(value**2 for value in delta))
        self.assertGreater(delta[0] / length, 0.999999)

    def test_the_nose_extreme_belongs_to_the_tip_node(self):
        tip = BY_NAME["hull_tip"]
        forward = max(vertex[0] for vertex in tip.mesh.vertices) + tip.origin[0]
        self.assertAlmostEqual(forward, NOSE_TIP_X, places=9)
        for part in PARTS:
            if part.mesh is None:
                continue
            extreme = max(vertex[0] for vertex in part.mesh.vertices) + part.origin[0]
            self.assertLessEqual(extreme, NOSE_TIP_X + 1e-9)

    def test_the_tail_extreme_belongs_to_the_nozzle_node(self):
        nozzle = BY_NAME["engine_nozzle"]
        aft = min(vertex[0] for vertex in nozzle.mesh.vertices) + nozzle.origin[0]
        for part in PARTS:
            if part.mesh is None:
                continue
            extreme = min(vertex[0] for vertex in part.mesh.vertices) + part.origin[0]
            self.assertGreaterEqual(extreme, aft - 1e-9)


class ScaleAndBudgetTest(unittest.TestCase):
    def test_length_is_the_published_metre_scale(self):
        self.assertAlmostEqual(measured_length(PARTS), SHIP_LENGTH_METERS, places=6)

    def test_length_matches_the_renderer_constant(self):
        # src/render/shipVisual.ts exports SHIP_LENGTH_M with this value and
        # derives the ship's bounding radius from it.
        constant = (REPOSITORY_ROOT / "src" / "render" / "shipVisual.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn(f"export const SHIP_LENGTH_M = {SHIP_LENGTH_METERS};", constant)

    def test_triangle_total_is_inside_the_acceptance_band(self):
        total = triangle_total(PARTS)
        self.assertGreaterEqual(total, TRIANGLE_MINIMUM)
        self.assertLessEqual(total, TRIANGLE_MAXIMUM)

    def test_no_part_is_empty(self):
        for part in PARTS:
            if part.mesh is None:
                continue
            self.assertGreater(part.mesh.triangles, 0, part.name)


class MaterialTest(unittest.TestCase):
    def test_every_referenced_material_is_declared(self):
        declared = {spec.name for spec in MATERIALS}
        used = {part.material for part in PARTS if part.material is not None}
        self.assertEqual(used, declared)

    def test_material_names_are_unique(self):
        names = [spec.name for spec in MATERIALS]
        self.assertEqual(len(names), len(set(names)))

    def test_engine_glow_keeps_the_engine_attachment_name(self):
        # MODELING-GUIDE section 6: `mat_engine_glow` receives the emissive
        # animation, and the ingest binds ship_mat_engine_glow__emissive.png to
        # a material of exactly this name.
        self.assertIn("mat_engine_glow", {spec.name for spec in MATERIALS})
        self.assertEqual(BY_NAME["engine_glow_disc"].material, "mat_engine_glow")

    def test_hull_material_carries_the_authored_maps(self):
        self.assertEqual(BY_NAME["hull"].material, "mat_hull")
        self.assertEqual(BY_NAME["hull_tip"].material, "mat_hull")

    def test_running_lights_have_their_own_emissive_materials(self):
        specs = {spec.name: spec for spec in MATERIALS}
        for name, _, _ in LIGHT_FIXTURES:
            spec = specs[f"mat_{name}"]
            self.assertIsNotNone(spec.emissive_color, name)
            self.assertGreater(spec.emissive_strength, 1.0, name)

    def test_navigation_light_colours_follow_the_port_red_convention(self):
        specs = {spec.name: spec for spec in MATERIALS}
        port = specs["mat_light_nav_l"].emissive_color
        starboard = specs["mat_light_nav_r"].emissive_color
        self.assertGreater(port[0], port[1])
        self.assertGreater(starboard[1], starboard[0])


class PlacementTest(unittest.TestCase):
    def test_rcs_pods_are_numbered_forward_pair_then_aft_pair(self):
        forward = [BY_NAME["rcs_pod_1"].origin[0], BY_NAME["rcs_pod_2"].origin[0]]
        aft = [BY_NAME["rcs_pod_3"].origin[0], BY_NAME["rcs_pod_4"].origin[0]]
        self.assertEqual(len(set(forward)), 1)
        self.assertEqual(len(set(aft)), 1)
        self.assertGreater(forward[0], aft[0])

    def test_odd_pods_are_port_and_even_pods_are_starboard(self):
        # Port is +Y in the authoring frame (-Z in the exported glTF frame).
        self.assertGreater(BY_NAME["rcs_pod_1"].origin[1], 0.0)
        self.assertLess(BY_NAME["rcs_pod_2"].origin[1], 0.0)
        self.assertGreater(BY_NAME["rcs_pod_3"].origin[1], 0.0)
        self.assertLess(BY_NAME["rcs_pod_4"].origin[1], 0.0)

    def test_there_are_exactly_four_pods(self):
        self.assertEqual(len(RCS_POD_STATIONS), 4)
        self.assertEqual(len([part for part in PARTS if part.name.startswith("rcs_pod_")]), 4)

    def test_pods_stand_off_the_hull_skin(self):
        for index in range(4):
            origin = BY_NAME[f"rcs_pod_{index + 1}"].origin
            radial = math.hypot(origin[1], origin[2])
            self.assertGreater(radial, hull_radius_at(origin[0]))

    def test_navigation_lights_are_mirrored_across_the_centreline(self):
        port = BY_NAME["light_nav_l"].origin
        starboard = BY_NAME["light_nav_r"].origin
        self.assertGreater(port[1], 0.0)
        self.assertAlmostEqual(port[1], -starboard[1], places=9)
        self.assertAlmostEqual(port[0], starboard[0], places=9)

    def test_beacon_is_dorsal_and_on_the_centreline(self):
        origin = BY_NAME["light_beacon"].origin
        self.assertEqual(origin[1], 0.0)
        self.assertGreater(origin[2], hull_radius_at(origin[0]))


class HullSurfaceTest(unittest.TestCase):
    def test_radius_is_continuous_and_positive(self):
        previous = hull_radius_at(-20.0)
        for step in range(0, 481):
            x = -12.0 + step * 0.05
            radius = hull_radius_at(x)
            self.assertGreater(radius, 0.0)
            self.assertLess(abs(radius - previous), 0.4, f"radius jump at x={x}")
            previous = radius

    def test_radius_clamps_outside_the_profile(self):
        self.assertEqual(hull_radius_at(-1e6), hull_radius_at(-10.0))
        self.assertEqual(hull_radius_at(1e6), hull_radius_at(NOSE_TIP_X))

    def test_v_runs_from_tail_to_nose_monotonically(self):
        self.assertEqual(hull_v_at(-20.0), 0.0)
        self.assertEqual(hull_v_at(20.0), 1.0)
        previous = -1.0
        for step in range(0, 471):
            value = hull_v_at(-10.0 + step * 0.05)
            self.assertGreaterEqual(value, previous)
            previous = value

    def test_tip_starts_where_the_fuselage_ends(self):
        self.assertLess(hull_v_at(TIP_ORIGIN_X), 1.0)
        self.assertGreater(hull_v_at(TIP_ORIGIN_X), 0.9)


class UvProjectionTest(unittest.TestCase):
    def test_hull_uvs_cover_the_map_without_seam_tears(self):
        mesh = project_hull_uvs(
            lathe(
                (ProfilePoint(-10.0, 2.0, False), ProfilePoint(10.0, 2.0, False)),
                16,
                with_uvs=False,
            )
        )
        for uv_face in mesh.uv_faces:
            us = [uv[0] for uv in uv_face]
            self.assertLess(max(us) - min(us), 0.5)
        self.assertAlmostEqual(max(uv[0] for face in mesh.uv_faces for uv in face), 1.0, places=9)

    def test_hull_v_increases_toward_the_nose(self):
        mesh = project_hull_uvs(
            lathe(
                (ProfilePoint(-9.0, 2.0, False), ProfilePoint(9.0, 2.0, False)),
                8,
                with_uvs=False,
            )
        )
        for face, uv_face in zip(mesh.faces, mesh.uv_faces):
            for index, uv in zip(face, uv_face):
                self.assertAlmostEqual(uv[1], hull_v_at(mesh.vertices[index][0]), places=12)

    def test_every_hull_face_keeps_one_uv_per_corner(self):
        for name in ("hull", "hull_tip", "engine_glow_disc"):
            mesh = BY_NAME[name].mesh
            for face, uv_face in zip(mesh.faces, mesh.uv_faces):
                self.assertEqual(len(face), len(uv_face), name)

    def test_untextured_parts_carry_no_uvs(self):
        for name in ("hull_frame", "engine_nozzle", "canopy", "rcs_pod_1", "light_beacon"):
            mesh = BY_NAME[name].mesh
            self.assertTrue(all(uv_face == () for uv_face in mesh.uv_faces), name)

    def test_radial_uvs_put_the_core_at_u_zero(self):
        mesh = project_radial_uvs(disc(0.0, 1.0, 12, facing=-1.0, with_uvs=False), 1.0)
        us = [uv[0] for face in mesh.uv_faces for uv in face]
        self.assertAlmostEqual(min(us), 0.0, places=9)
        self.assertAlmostEqual(max(us), 1.0, places=9)

    def test_radial_uvs_reject_a_zero_radius(self):
        with self.assertRaises(ValueError):
            project_radial_uvs(disc(0.0, 1.0, 8, with_uvs=False), 0.0)


class NozzleTest(unittest.TestCase):
    def test_bell_is_a_lined_shell_open_at_the_throat(self):
        mesh = BY_NAME["engine_nozzle"].mesh
        counts = {}
        for face in mesh.faces:
            for index in range(len(face)):
                key = tuple(sorted((face[index], face[(index + 1) % len(face)])))
                counts[key] = counts.get(key, 0) + 1
        self.assertGreater(sum(1 for value in counts.values() if value == 1), 0)

    def test_the_liner_sits_inside_the_outer_wall(self):
        radii = [
            math.hypot(vertex[1], vertex[2])
            for vertex in BY_NAME["engine_nozzle"].mesh.vertices
            if vertex[0] < -1.49
        ]
        self.assertAlmostEqual(max(radii) - min(radii), ship_config.NOZZLE_WALL, places=9)

    def test_glow_disc_is_recessed_inside_the_bell(self):
        glow_x = [vertex[0] for vertex in BY_NAME["engine_glow_disc"].mesh.vertices]
        exit_x = NOZZLE_ORIGIN_X + min(
            vertex[0] for vertex in BY_NAME["engine_nozzle"].mesh.vertices
        )
        self.assertGreater(min(glow_x), exit_x)


class DeterminismTest(unittest.TestCase):
    def test_two_evaluations_produce_identical_geometry(self):
        first = ship_parts()
        second = ship_parts()
        self.assertEqual(len(first), len(second))
        for left, right in zip(first, second):
            self.assertEqual(left.name, right.name)
            self.assertEqual(left.origin, right.origin)
            if left.mesh is None:
                self.assertIsNone(right.mesh)
                continue
            self.assertEqual(left.mesh.vertices, right.mesh.vertices)
            self.assertEqual(left.mesh.faces, right.mesh.faces)
            self.assertEqual(left.mesh.uv_faces, right.mesh.uv_faces)
            self.assertEqual(left.mesh.normal_faces, right.mesh.normal_faces)

    def test_every_loop_normal_is_a_unit_vector(self):
        for part in PARTS:
            if part.mesh is None:
                continue
            for normal_face in part.mesh.normal_faces:
                for normal in normal_face:
                    length = math.sqrt(sum(value**2 for value in normal))
                    self.assertAlmostEqual(length, 1.0, places=9, msg=part.name)

    def test_loop_normal_count_matches_the_loop_count(self):
        for part in PARTS:
            if part.mesh is None:
                continue
            self.assertEqual(len(part.mesh.faces), len(part.mesh.normal_faces), part.name)
            for face, normal_face in zip(part.mesh.faces, part.mesh.normal_faces):
                self.assertEqual(len(face), len(normal_face), part.name)

    def test_no_face_indexes_a_missing_vertex(self):
        for part in PARTS:
            if part.mesh is None:
                continue
            count = len(part.mesh.vertices)
            for face in part.mesh.faces:
                self.assertEqual(len(set(face)), len(face), part.name)
                for index in face:
                    self.assertLess(index, count, part.name)


if __name__ == "__main__":
    unittest.main()
