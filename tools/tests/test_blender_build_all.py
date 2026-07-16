import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "blender" / "build_all.py"


def load_module():
    spec = importlib.util.spec_from_file_location("build_all", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BlenderBuildAllTests(unittest.TestCase):
    def setUp(self):
        self.build_all = load_module()

    def test_discovers_catalog_builders_in_stable_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for name in (
                "build_saturn.py",
                "build_all.py",
                "build_planet.py",
                "build_test_sphere.py",
                "build_earth.py",
                "notes.txt",
            ):
                (root / name).write_text("", encoding="utf-8")

            builders = self.build_all.discover_builders(root, {"earth", "saturn"})

            self.assertEqual(list(builders), ["earth", "saturn"])
            self.assertEqual(builders["earth"].name, "build_earth.py")

    def test_rejects_builder_without_catalog_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "build_unknown.py").write_text("", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unknown.*data/bodies.json"):
                self.build_all.discover_builders(root, {"earth"})

    def test_parses_all_and_repeated_only_in_stable_order(self):
        supported = {"sun": pathlib.Path("sun.py"), "earth": pathlib.Path("earth.py")}

        self.assertEqual(self.build_all.parse_build_request(["--all"], supported), ("earth", "sun"))
        self.assertEqual(
            self.build_all.parse_build_request(["--only", "sun", "--only", "earth"], supported),
            ("earth", "sun"),
        )

    def test_rejects_ambiguous_duplicate_and_unknown_requests(self):
        supported = {"earth": pathlib.Path("earth.py")}
        cases = (
            (["--all", "--only", "earth"], "exactly one"),
            (["--only", "earth", "--only", "earth"], "duplicate"),
            (["--only", "mars"], "unsupported.*earth"),
            ([], "exactly one"),
        )
        for arguments, pattern in cases:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(ValueError, pattern):
                    self.build_all.parse_build_request(arguments, supported)

    def test_runs_requested_builders_in_order(self):
        calls = []
        builders = {"earth": pathlib.Path("earth.py"), "sun": pathlib.Path("sun.py")}

        self.build_all.run_builders(("earth", "sun"), builders, lambda path: calls.append(path.name))

        self.assertEqual(calls, ["earth.py", "sun.py"])


if __name__ == "__main__":
    unittest.main()
