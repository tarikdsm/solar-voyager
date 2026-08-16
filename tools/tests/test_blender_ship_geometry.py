"""Unit tests for the Blender-free ship primitives (T0121)."""

import math
import pathlib
import sys
import unittest


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "tools" / "blender"))

from ship_geometry import (  # noqa: E402
    ProfilePoint,
    arc_lengths,
    bounds,
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


def face_normal(vertices, face):
    a = vertices[face[0]]
    b = vertices[face[1]]
    c = vertices[face[2]]
    edge1 = tuple(b[axis] - a[axis] for axis in range(3))
    edge2 = tuple(c[axis] - a[axis] for axis in range(3))
    cross = (
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2],
        edge1[0] * edge2[1] - edge1[1] * edge2[0],
    )
    length = math.sqrt(sum(component**2 for component in cross))
    return tuple(component / length for component in cross)


class RingDirectionTest(unittest.TestCase):
    def test_zero_angle_is_dorsal(self):
        self.assertEqual(ring_direction(0.0), (0.0, -0.0, 1.0))

    def test_quarter_turn_reaches_starboard(self):
        direction = ring_direction(math.pi / 2)
        self.assertAlmostEqual(direction[1], -1.0)
        self.assertAlmostEqual(direction[2], 0.0)

    def test_roll_rotation_carries_local_up_onto_the_ring(self):
        for degrees in (0.0, 37.0, 90.0, 214.5, 359.0):
            angle = math.radians(degrees)
            rows = roll_rotation(angle)
            placed = tuple(rows[axis][2] for axis in range(3))
            expected = ring_direction(angle)
            for axis in range(3):
                self.assertAlmostEqual(placed[axis], expected[axis], places=12)


class LatheTest(unittest.TestCase):
    CYLINDER = (ProfilePoint(0.0, 1.0, False), ProfilePoint(2.0, 1.0, False))

    def test_rejects_non_increasing_stations(self):
        with self.assertRaises(ValueError):
            lathe((ProfilePoint(1.0, 1.0), ProfilePoint(0.0, 1.0)), 8)

    def test_rejects_degenerate_inputs(self):
        with self.assertRaises(ValueError):
            lathe((ProfilePoint(0.0, 1.0),), 8)
        with self.assertRaises(ValueError):
            lathe(self.CYLINDER, 2)
        with self.assertRaises(ValueError):
            lathe((ProfilePoint(0.0, -1.0), ProfilePoint(1.0, 1.0)), 8)

    def test_triangle_count_is_two_per_segment_per_band(self):
        mesh = lathe(self.CYLINDER, 24)
        self.assertEqual(len(mesh.faces), 24)
        self.assertEqual(mesh.triangles, 48)

    def test_winding_and_normals_point_outward(self):
        mesh = lathe(self.CYLINDER, 16)
        for face, normals in zip(mesh.faces, mesh.normal_faces):
            geometric = face_normal(mesh.vertices, face)
            centroid = [
                sum(mesh.vertices[index][axis] for index in face) / len(face) for axis in range(3)
            ]
            radial = math.hypot(centroid[1], centroid[2])
            outward = geometric[1] * centroid[1] + geometric[2] * centroid[2]
            self.assertGreater(outward / radial, 0.9)
            for normal in normals:
                self.assertAlmostEqual(math.sqrt(sum(value**2 for value in normal)), 1.0, places=9)
                self.assertGreater(normal[1] * centroid[1] + normal[2] * centroid[2], 0.0)

    def test_flip_reverses_winding_and_normals(self):
        outward = lathe(self.CYLINDER, 12)
        inward = lathe(self.CYLINDER, 12, flip=True)
        self.assertEqual(len(outward.faces), len(inward.faces))
        for face, flipped in zip(outward.faces, inward.faces):
            self.assertEqual(tuple(reversed(face)), flipped)
        for normals, flipped in zip(outward.normal_faces, inward.normal_faces):
            for normal, other in zip(reversed(normals), flipped):
                for axis in range(3):
                    self.assertAlmostEqual(normal[axis], -other[axis], places=12)

    def test_cone_normals_tilt_with_the_profile_slope(self):
        mesh = lathe((ProfilePoint(0.0, 1.0, False), ProfilePoint(1.0, 0.0, False)), 8)
        for normals in mesh.normal_faces:
            for normal in normals:
                self.assertAlmostEqual(normal[0], math.sqrt(0.5), places=9)

    def test_hard_station_keeps_bands_independent(self):
        profile = (
            ProfilePoint(0.0, 1.0, False),
            ProfilePoint(1.0, 1.0, False),
            ProfilePoint(2.0, 0.5, False),
        )
        mesh = lathe(profile, 8)
        first = mesh.normal_faces[0][0]
        second = mesh.normal_faces[8][0]
        self.assertAlmostEqual(first[0], 0.0, places=9)
        # Second band drops 0.5 in radius over 1.0 in x, so its exact axial
        # component is 0.5 / hypot(1, 0.5) with no blending from the first band.
        self.assertAlmostEqual(second[0], 0.5 / math.hypot(1.0, 0.5), places=12)

    def test_smooth_station_blends_the_two_bands(self):
        profile = (
            ProfilePoint(0.0, 1.0, False),
            ProfilePoint(1.0, 1.0, True),
            ProfilePoint(2.0, 0.5, False),
        )
        mesh = lathe(profile, 8)
        # The shared station is the fourth corner of the first band's face.
        shared = mesh.normal_faces[0][3]
        self.assertGreater(shared[0], 0.0)
        self.assertLess(shared[0], math.sqrt(0.5))

    def test_uvs_span_the_requested_window(self):
        mesh = lathe(self.CYLINDER, 8, u_range=(0.25, 0.75), v_range=(0.1, 0.4))
        us = [uv[0] for face in mesh.uv_faces for uv in face]
        vs = [uv[1] for face in mesh.uv_faces for uv in face]
        self.assertAlmostEqual(min(us), 0.25)
        self.assertAlmostEqual(max(us), 0.75)
        self.assertAlmostEqual(min(vs), 0.1)
        self.assertAlmostEqual(max(vs), 0.4)

    def test_without_uvs_leaves_every_face_unmapped(self):
        mesh = lathe(self.CYLINDER, 8, with_uvs=False)
        self.assertTrue(all(uv_face == () for uv_face in mesh.uv_faces))

    def test_arc_lengths_accumulate_the_profile(self):
        arc = arc_lengths(
            (ProfilePoint(0.0, 1.0), ProfilePoint(3.0, 1.0), ProfilePoint(3.0 + 3.0, 1.0 + 4.0))
        )
        self.assertEqual(arc, (0.0, 3.0, 8.0))


class DiscTest(unittest.TestCase):
    def test_forward_disc_faces_positive_x(self):
        mesh = disc(1.0, 2.0, 12, facing=1.0)
        self.assertEqual(mesh.triangles, 12)
        for face, normals in zip(mesh.faces, mesh.normal_faces):
            self.assertGreater(face_normal(mesh.vertices, face)[0], 0.9)
            self.assertEqual(normals[0], (1.0, 0.0, 0.0))

    def test_aft_disc_faces_negative_x(self):
        mesh = disc(-1.0, 2.0, 12, facing=-1.0)
        for face, normals in zip(mesh.faces, mesh.normal_faces):
            self.assertLess(face_normal(mesh.vertices, face)[0], -0.9)
            self.assertEqual(normals[0], (-1.0, 0.0, 0.0))

    def test_annulus_is_quads_with_consistent_winding(self):
        mesh = disc(0.0, 2.0, 10, facing=1.0, inner_radius=1.0)
        self.assertEqual(len(mesh.faces), 10)
        self.assertEqual(mesh.triangles, 20)
        for face in mesh.faces:
            self.assertEqual(len(face), 4)
            self.assertGreater(face_normal(mesh.vertices, face)[0], 0.9)

    def test_annulus_rejects_bad_radii(self):
        with self.assertRaises(ValueError):
            disc(0.0, 1.0, 8, inner_radius=1.0)


class ChamferedBoxTest(unittest.TestCase):
    def test_topology_is_six_faces_twelve_edges_eight_corners(self):
        mesh = chamfered_box((1.0, 0.5, 0.25), 0.05)
        self.assertEqual(len(mesh.vertices), 24)
        self.assertEqual(len(mesh.faces), 26)
        self.assertEqual(mesh.triangles, 44)

    def test_every_face_is_wound_outward(self):
        mesh = chamfered_box((1.0, 0.6, 0.4), 0.08)
        for face, normals in zip(mesh.faces, mesh.normal_faces):
            geometric = face_normal(mesh.vertices, face)
            declared = normals[0]
            dot = sum(geometric[axis] * declared[axis] for axis in range(3))
            self.assertGreater(dot, 0.999)

    def test_chamfer_must_fit(self):
        with self.assertRaises(ValueError):
            chamfered_box((1.0, 1.0, 0.1), 0.1)
        with self.assertRaises(ValueError):
            chamfered_box((1.0, 1.0, 1.0), 0.0)

    def test_bounds_match_the_half_extents(self):
        minimum, maximum = bounds(chamfered_box((1.0, 0.5, 0.25), 0.05))
        self.assertEqual(maximum, (1.0, 0.5, 0.25))
        self.assertEqual(minimum, (-1.0, -0.5, -0.25))


class TorusTest(unittest.TestCase):
    def test_topology_and_normals(self):
        mesh = torus(2.0, 0.25, 12, 6)
        self.assertEqual(len(mesh.faces), 72)
        self.assertEqual(mesh.triangles, 144)
        for face, normals in zip(mesh.faces, mesh.normal_faces):
            geometric = face_normal(mesh.vertices, face)
            # A coarse torus quad is far from planar, so compare the face normal
            # with the mean of its four exact corner normals rather than with
            # any single corner.
            mean = [sum(normal[axis] for normal in normals) / len(normals) for axis in range(3)]
            length = math.sqrt(sum(value**2 for value in mean))
            dot = sum(geometric[axis] * mean[axis] / length for axis in range(3))
            self.assertGreater(dot, 0.99)

    def test_rejects_inverted_radii(self):
        with self.assertRaises(ValueError):
            torus(1.0, 1.0, 8, 8)


class TransformTest(unittest.TestCase):
    def test_translation_moves_vertices_only(self):
        mesh = chamfered_box((1.0, 1.0, 1.0), 0.1)
        moved = transform(mesh, translation=(1.0, 2.0, 3.0))
        for original, placed in zip(mesh.vertices, moved.vertices):
            self.assertAlmostEqual(placed[0] - original[0], 1.0)
            self.assertAlmostEqual(placed[1] - original[1], 2.0)
            self.assertAlmostEqual(placed[2] - original[2], 3.0)
        self.assertEqual(mesh.normal_faces, moved.normal_faces)

    def test_non_uniform_scale_uses_the_inverse_transpose(self):
        mesh = lathe((ProfilePoint(0.0, 1.0, False), ProfilePoint(1.0, 1.0, False)), 4)
        flattened = transform(mesh, scale=(1.0, 1.0, 0.5))
        for normals in flattened.normal_faces:
            for normal in normals:
                self.assertAlmostEqual(math.sqrt(sum(value**2 for value in normal)), 1.0, places=9)
        # A ring vertex on +Z keeps its +Z normal; one on -Y tilts toward +Z-free.
        self.assertGreater(max(abs(normal[2]) for face in flattened.normal_faces for normal in face), 0.9)

    def test_zero_scale_is_rejected(self):
        with self.assertRaises(ValueError):
            transform(chamfered_box((1.0, 1.0, 1.0), 0.1), scale=(1.0, 0.0, 1.0))

    def test_rotation_from_axis_is_orthonormal(self):
        for axis in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.3, -0.5, 0.8)):
            rows = rotation_from_axis(axis)
            columns = [tuple(rows[row][column] for row in range(3)) for column in range(3)]
            for column in columns:
                self.assertAlmostEqual(math.sqrt(sum(value**2 for value in column)), 1.0, places=12)
            for first in range(3):
                for second in range(first + 1, 3):
                    dot = sum(columns[first][index] * columns[second][index] for index in range(3))
                    self.assertAlmostEqual(dot, 0.0, places=12)

    def test_rotation_from_axis_carries_local_x_onto_the_axis(self):
        axis = (0.0, 1.0, 0.0)
        rows = rotation_from_axis(axis)
        placed = tuple(rows[index][0] for index in range(3))
        for index in range(3):
            self.assertAlmostEqual(placed[index], axis[index], places=12)


class MergeTest(unittest.TestCase):
    def test_indices_are_rebased_in_argument_order(self):
        first = disc(0.0, 1.0, 4, facing=1.0)
        second = disc(1.0, 1.0, 4, facing=1.0)
        combined = merge((first, second))
        self.assertEqual(len(combined.vertices), len(first.vertices) + len(second.vertices))
        self.assertEqual(combined.triangles, first.triangles + second.triangles)
        offset = len(first.vertices)
        for face, rebased in zip(second.faces, combined.faces[len(first.faces) :]):
            self.assertEqual(tuple(index + offset for index in face), rebased)


if __name__ == "__main__":
    unittest.main()
