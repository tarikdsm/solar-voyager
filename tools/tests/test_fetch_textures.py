import hashlib
import importlib.util
import io
import pathlib
import struct
import tempfile
import unittest
import zlib


MODULE_PATH = pathlib.Path(__file__).parents[1] / "fetch_textures.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fetch_textures", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class TextureFetchTests(unittest.TestCase):
    def setUp(self):
        self.fetch = load_module()

    def test_selects_recipes_in_stable_order_and_rejects_unknown_ids(self):
        recipes = {
            "zeta": self.fetch.TextureRecipe.test("zeta"),
            "alpha": self.fetch.TextureRecipe.test("alpha"),
        }
        self.assertEqual([item.id for item in self.fetch.select_recipes([], recipes)], ["alpha", "zeta"])
        with self.assertRaisesRegex(ValueError, "unknown recipe.*alpha, zeta"):
            self.fetch.select_recipes(["missing"], recipes)

    def test_streams_with_checksum_and_size_guards(self):
        payload = b"pinned texture bytes"
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            destination = pathlib.Path(temporary) / "download.bin"
            result = self.fetch.download_verified(
                "https://example.test/texture",
                destination,
                expected,
                max_bytes=len(payload),
                opener=lambda *_args, **_kwargs: Response(payload),
            )
            self.assertEqual(result, destination)
            self.assertEqual(destination.read_bytes(), payload)

            with self.assertRaisesRegex(ValueError, "exceeds"):
                self.fetch.download_verified(
                    "https://example.test/texture",
                    destination,
                    expected,
                    max_bytes=len(payload) - 1,
                    opener=lambda *_args, **_kwargs: Response(payload),
                )
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                self.fetch.download_verified(
                    "https://example.test/texture",
                    destination,
                    "0" * 64,
                    opener=lambda *_args, **_kwargs: Response(payload),
                )

    def test_rejects_non_https_recipe_and_output_escape(self):
        insecure = self.fetch.TextureRecipe.test("bad", source_url="http://example.test/a.png")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            insecure.validate()
        escaping = self.fetch.TextureRecipe.test("bad", output_name="../escape.png")
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.fetch.output_path(pathlib.Path(temporary), escaping)

    def test_renders_complete_stable_attribution(self):
        recipe = self.fetch.TextureRecipe.test("earth-albedo")
        first = self.fetch.render_sources("earth", [recipe])
        second = self.fetch.render_sources("earth", [recipe])
        self.assertEqual(first, second)
        for expected in (recipe.product_url, recipe.source_url, recipe.sha256, recipe.license, recipe.credit):
            self.assertIn(expected, first)
        self.assertIn("8192×4096", first)

    def test_sharp_processing_is_deterministic_for_a_small_equirectangular_png(self):
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

        pixels = b"\0" + bytes((255, 0, 0, 0, 0, 255))
        source_bytes = b"\x89PNG\r\n\x1a\n" + chunk(
            b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0)
        ) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
        recipe = self.fetch.TextureRecipe.test("small")
        recipe.width = 4
        recipe.height = 2
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "source.png"
            first = root / "first.png"
            second = root / "second.png"
            source.write_bytes(source_bytes)
            self.fetch.process_image(source, first, recipe)
            self.fetch.process_image(source, second, recipe)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertTrue(first.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))

    def test_moon_recipes_pin_nasa_sources_and_processing_contracts(self):
        albedo = self.fetch.RECIPES["moon-albedo"]
        height = self.fetch.RECIPES["moon-height"]

        self.assertEqual((albedo.body_id, albedo.role), ("moon", "albedo"))
        self.assertEqual((albedo.width, albedo.height), (4096, 2048))
        self.assertEqual((albedo.output_format, albedo.quality), ("jpeg", 88))
        self.assertAlmostEqual(albedo.contrast, 1.08)
        self.assertEqual(albedo.sha256, "4af8b0cd4d50c30851359d98e7e72040240dd8d03256b58b345b5b76e9edb4ef")
        self.assertEqual((height.body_id, height.role), ("moon", "height"))
        self.assertEqual((height.width, height.height), (2048, 1024))
        self.assertEqual(height.output_format, "png")
        self.assertEqual(height.sha256, "45a2b32d56e81ed30db07fead8abc842b249b6511219d9ca2c53f81bc2dc5d62")
        for recipe in (albedo, height):
            self.assertEqual(recipe.product_url, "https://svs.gsfc.nasa.gov/4720")
            self.assertIn("NASA", recipe.credit)

    def test_process_image_forwards_recipe_owned_output_options(self):
        recipe = self.fetch.TextureRecipe.test("options", output_name="texture.jpg")
        recipe.width = 4
        recipe.height = 2
        recipe.output_format = "jpeg"
        recipe.quality = 88
        recipe.contrast = 1.08
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            pathlib.Path(command[command.index("--output") + 1]).write_bytes(b"processed")

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "source.png"
            source.write_bytes(b"source")
            destination = root / "output.jpg"
            self.fetch.process_image(source, destination, recipe, node_executable="node", runner=runner)

        command = calls[0][0]
        self.assertEqual(command[command.index("--format") + 1], "jpeg")
        self.assertEqual(command[command.index("--quality") + 1], "88")
        self.assertEqual(command[command.index("--contrast") + 1], "1.08")

    def test_processing_failure_preserves_previous_body_directory(self):
        source_bytes = b"pinned local source"
        recipe = self.fetch.TextureRecipe.test("earth-albedo", output_name="earth_albedo.png")
        recipe.sha256 = hashlib.sha256(source_bytes).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            body = root / "earth"
            body.mkdir()
            (body / "earth_albedo.png").write_bytes(b"previous texture")
            (body / "SOURCES.md").write_text("previous attribution", encoding="utf-8")
            source = root / "source.bin"
            source.write_bytes(source_bytes)

            def failing_processor(_source, destination, _recipe):
                destination.write_bytes(b"partial new texture")
                raise RuntimeError("processor failed")

            with self.assertRaisesRegex(RuntimeError, "processor failed"):
                self.fetch.execute((recipe,), root, source_override=source, processor=failing_processor)

            self.assertEqual((body / "earth_albedo.png").read_bytes(), b"previous texture")
            self.assertEqual((body / "SOURCES.md").read_text(encoding="utf-8"), "previous attribution")
            self.assertFalse((root / ".earth.texture-stage").exists())
            self.assertFalse((root / ".earth.texture-backup").exists())

    def test_sequential_body_recipes_preserve_complete_attribution(self):
        first_bytes = b"first source"
        second_bytes = b"second source"
        first = self.fetch.TextureRecipe.test("first", output_name="first.png")
        second = self.fetch.TextureRecipe.test("second", output_name="second.png")
        first.body_id = second.body_id = "moon"
        first.sha256 = hashlib.sha256(first_bytes).hexdigest()
        second.sha256 = hashlib.sha256(second_bytes).hexdigest()

        def copying_processor(source, destination, _recipe):
            destination.write_bytes(source.read_bytes())

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            first_source = root / "first-source"
            second_source = root / "second-source"
            first_source.write_bytes(first_bytes)
            second_source.write_bytes(second_bytes)
            recipes = {"first": first, "second": second}
            self.fetch.execute(
                (first,), root / "output", first_source, copying_processor, recipe_catalog=recipes
            )
            self.fetch.execute(
                (second,), root / "output", second_source, copying_processor, recipe_catalog=recipes
            )
            sources = (root / "output" / "moon" / "SOURCES.md").read_text(encoding="utf-8")

        self.assertIn("## first", sources)
        self.assertIn("## second", sources)


if __name__ == "__main__":
    unittest.main()
