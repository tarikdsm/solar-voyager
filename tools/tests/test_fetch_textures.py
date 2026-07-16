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


if __name__ == "__main__":
    unittest.main()
