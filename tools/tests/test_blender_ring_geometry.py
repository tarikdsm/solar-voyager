import unittest


from tools.blender.ring_geometry import annulus_mesh_data


class RingGeometryTests(unittest.TestCase):
    def test_builds_closed_annulus_with_radial_u_and_angular_v(self):
        mesh = annulus_mesh_data(1.1, 2.3, angular_segments=8, radial_segments=2)
        self.assertEqual(len(mesh.vertices), 24)
        self.assertEqual(len(mesh.faces), 16)
        self.assertEqual(len(mesh.uv_faces), 16)
        self.assertEqual(mesh.faces[0], (0, 1, 9, 8))
        self.assertEqual(mesh.faces[7], (7, 0, 8, 15))
        self.assertEqual(mesh.uv_faces[0], ((0.0, 0.0), (0.0, 0.125), (0.5, 0.125), (0.5, 0.0)))
        self.assertEqual(mesh.uv_faces[7][1][1], 1.0)

    def test_rejects_invalid_radii_and_segment_counts(self):
        with self.assertRaisesRegex(ValueError, "increasing"):
            annulus_mesh_data(2, 1, 8, 2)
        with self.assertRaisesRegex(ValueError, "angular_segments"):
            annulus_mesh_data(1, 2, 2, 2)
        with self.assertRaisesRegex(ValueError, "radial_segments"):
            annulus_mesh_data(1, 2, 8, 0)


if __name__ == "__main__":
    unittest.main()
