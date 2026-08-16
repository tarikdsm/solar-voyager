import hashlib
import importlib.util
import io
import json
import pathlib
import struct
import tempfile
import unittest
import urllib.error
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

        attribution = self.fetch.render_sources("moon", (albedo, height))
        self.assertNotIn("image content is otherwise unchanged", attribution)
        self.assertIn("contrast-enhanced", attribution)
        self.assertIn("luminance-normalized and filtered", attribution)

    def test_ringed_giant_recipes_pin_solar_system_scope_sources(self):
        expected = {
            "jupiter-albedo": (
                "jupiter",
                "0bd844bf20822c4e3e80882b077859833c0dac44c7e4e1e0cd63d1b1b6d43085",
                90,
            ),
            "uranus-albedo": (
                "uranus",
                "d15239d46f82d3ea13d2b260b5b29b2a382f42f2916dae0694d0387b1204a09d",
                92,
            ),
            "neptune-albedo": (
                "neptune",
                "cb42ea82709741d28b0af44d8b283cbc6dbd0c521a7f0e1e1e010ade00977df6",
                92,
            ),
        }
        for recipe_id, (body_id, sha256, quality) in expected.items():
            with self.subTest(recipe_id=recipe_id):
                recipe = self.fetch.RECIPES[recipe_id]
                self.assertEqual(recipe.body_id, body_id)
                self.assertEqual((recipe.width, recipe.height), (4096, 2048))
                self.assertEqual((recipe.output_format, recipe.quality), ("jpeg", quality))
                self.assertEqual(recipe.output_name, f"{body_id}_albedo.jpg")
                self.assertEqual(recipe.sha256, sha256)
                self.assertIn("solarsystemscope.com/textures", recipe.source_url)
                self.assertEqual(recipe.license.split(" (")[0], "CC BY 4.0")

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
                self.fetch.execute(
                    (recipe,),
                    root,
                    source_override=source,
                    processor=failing_processor,
                    cache_root=root / "cache",
                )

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
                (first,),
                root / "output",
                first_source,
                copying_processor,
                recipe_catalog=recipes,
                cache_root=root / "cache",
            )
            self.fetch.execute(
                (second,),
                root / "output",
                second_source,
                copying_processor,
                recipe_catalog=recipes,
                cache_root=root / "cache",
            )
            sources = (root / "output" / "moon" / "SOURCES.md").read_text(encoding="utf-8")

        self.assertIn("## first", sources)
        self.assertIn("## second", sources)


class SourceCacheTests(unittest.TestCase):
    """ADR-039: sources are fetched, verified and cached instead of committed."""

    PAYLOAD = b"pinned 8k source imagery"

    def setUp(self):
        self.fetch = load_module()
        self.digest = hashlib.sha256(self.PAYLOAD).hexdigest()

    def recipe(self, **overrides):
        recipe = self.fetch.TextureRecipe.test("mercury-albedo", output_name="mercury_albedo.jpg")
        recipe.body_id = "mercury"
        recipe.output_format = "jpeg"
        recipe.sha256 = self.digest
        recipe.source_url = "https://example.test/mercury/8k_mercury.jpg"
        for name, value in overrides.items():
            setattr(recipe, name, value)
        return recipe

    def opener_for(self, payload, calls=None):
        def opener(request, **_kwargs):
            if calls is not None:
                calls.append(request)
            return Response(payload)

        return opener

    @staticmethod
    def forbidden_opener(*_args, **_kwargs):
        raise AssertionError("a cache hit must not open the network")

    # --- manifest ---------------------------------------------------------

    def test_every_catalogued_source_exposes_the_four_policy_fields(self):
        for recipe_id, recipe in sorted(self.fetch.RECIPES.items()):
            with self.subTest(recipe_id=recipe_id):
                entry = self.fetch.manifest_entry(recipe)
                for field in ("url", "sha256", "license", "dest"):
                    self.assertIn(field, entry)
                    self.assertTrue(entry[field], f"{recipe_id}.{field} must be populated")
                self.assertTrue(entry["url"].startswith("https://"))
                self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
                self.assertEqual(
                    entry["dest"], f"assets/textures-src/{recipe.body_id}/{recipe.output_name}"
                )

    def test_manifest_renders_stable_sorted_json(self):
        first = self.fetch.render_manifest(self.fetch.RECIPES.values())
        second = self.fetch.render_manifest(self.fetch.RECIPES.values())
        self.assertEqual(first, second)
        ids = [entry["id"] for entry in json.loads(first)["sources"]]
        self.assertEqual(ids, sorted(ids))

    # --- checksum mismatch fails loudly -----------------------------------

    def test_checksum_mismatch_fails_loudly_and_caches_nothing(self):
        recipe = self.recipe()
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            with self.assertRaises(self.fetch.ChecksumMismatchError) as raised:
                self.fetch.ensure_cached(
                    recipe, cache_root, opener=self.opener_for(b"substituted bytes")
                )
            message = str(raised.exception)
            self.assertIn(recipe.id, message)
            self.assertIn(recipe.sha256, message)
            self.assertIn(hashlib.sha256(b"substituted bytes").hexdigest(), message)
            self.assertIn(recipe.source_url, message)
            self.assertEqual(
                sorted(path.name for path in cache_root.rglob("*") if path.is_file()), []
            )

    def test_checksum_mismatch_is_a_value_error_so_the_cli_still_traps_it(self):
        self.assertTrue(issubclass(self.fetch.ChecksumMismatchError, ValueError))

    # --- cache hit skips the download -------------------------------------

    def test_cache_hit_skips_the_download(self):
        recipe = self.recipe()
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            cached = self.fetch.cache_path(cache_root, recipe.sha256)
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(self.PAYLOAD)

            path, status = self.fetch.ensure_cached(
                recipe, cache_root, opener=self.forbidden_opener
            )

            self.assertEqual(status, self.fetch.CACHE_HIT)
            self.assertEqual(path, cached)
            self.assertEqual(path.read_bytes(), self.PAYLOAD)

    def test_second_fetch_is_a_cache_hit_and_downloads_once(self):
        recipe = self.recipe()
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            opener = self.opener_for(self.PAYLOAD, calls)
            first_path, first_status = self.fetch.ensure_cached(recipe, cache_root, opener=opener)
            second_path, second_status = self.fetch.ensure_cached(
                recipe, cache_root, opener=self.forbidden_opener
            )

            self.assertEqual(first_status, self.fetch.DOWNLOADED)
            self.assertEqual(second_status, self.fetch.CACHE_HIT)
            self.assertEqual(first_path, second_path)
            self.assertEqual(len(calls), 1)

    def test_a_corrupt_cache_entry_is_replaced_rather_than_trusted(self):
        recipe = self.recipe()
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            cached = self.fetch.cache_path(cache_root, recipe.sha256)
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(b"bit rot")

            path, status = self.fetch.ensure_cached(
                recipe, cache_root, opener=self.opener_for(self.PAYLOAD, calls)
            )

            self.assertEqual(status, self.fetch.DOWNLOADED)
            self.assertEqual(path.read_bytes(), self.PAYLOAD)
            self.assertEqual(len(calls), 1)

    # --- offline-friendly error copy --------------------------------------

    def test_offline_error_names_the_file_its_destination_and_its_url(self):
        recipe = self.recipe()
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            with self.assertRaises(self.fetch.SourceUnavailableError) as raised:
                self.fetch.ensure_cached(
                    recipe, cache_root, opener=self.forbidden_opener, offline=True
                )
            message = str(raised.exception)

        self.assertIn(recipe.id, message)
        self.assertIn(recipe.output_name, message)
        self.assertIn(recipe.dest, message)
        self.assertIn(recipe.source_url, message)
        self.assertIn(recipe.sha256, message)
        self.assertIn(str(self.fetch.cache_path(cache_root, recipe.sha256)), message)
        self.assertIn("--source", message)

    def test_a_network_failure_becomes_the_same_offline_error(self):
        recipe = self.recipe()

        def failing_opener(*_args, **_kwargs):
            raise urllib.error.URLError("getaddrinfo failed")

        with tempfile.TemporaryDirectory() as temporary:
            cache_root = pathlib.Path(temporary) / "cache"
            with self.assertRaises(self.fetch.SourceUnavailableError) as raised:
                self.fetch.ensure_cached(recipe, cache_root, opener=failing_opener)

        message = str(raised.exception)
        self.assertIn(recipe.source_url, message)
        self.assertIn("getaddrinfo failed", message)

    # --- manual placement -------------------------------------------------

    def test_source_override_installs_verified_bytes_into_the_cache(self):
        recipe = self.recipe()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            handed = root / "downloaded-elsewhere.jpg"
            handed.write_bytes(self.PAYLOAD)
            cache_root = root / "cache"

            installed = self.fetch.install_source(handed, recipe, cache_root)
            self.assertEqual(installed, self.fetch.cache_path(cache_root, recipe.sha256))
            self.assertEqual(installed.read_bytes(), self.PAYLOAD)

            path, status = self.fetch.ensure_cached(
                recipe, cache_root, opener=self.forbidden_opener, offline=True
            )
            self.assertEqual((path, status), (installed, self.fetch.CACHE_HIT))

    def test_source_override_with_the_wrong_bytes_fails_loudly(self):
        recipe = self.recipe()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            handed = root / "wrong.jpg"
            handed.write_bytes(b"a different file entirely")
            with self.assertRaises(self.fetch.ChecksumMismatchError) as raised:
                self.fetch.install_source(handed, recipe, root / "cache")
        self.assertIn(recipe.sha256, str(raised.exception))

    # --- cache root resolution --------------------------------------------

    def test_cache_root_prefers_explicit_then_environment_then_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            explicit = pathlib.Path(temporary) / "explicit"
            environment = {self.fetch.CACHE_ENVIRONMENT_VARIABLE: str(explicit.parent / "env")}
            self.assertEqual(
                self.fetch.resolve_cache_root(explicit, environment), explicit.resolve()
            )
            self.assertEqual(
                self.fetch.resolve_cache_root(None, environment),
                (explicit.parent / "env").resolve(),
            )
            self.assertEqual(
                self.fetch.resolve_cache_root(None, {}), self.fetch.DEFAULT_CACHE_ROOT
            )

    def test_cache_path_rejects_a_digest_that_is_not_pinned_hex(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.fetch.cache_path(pathlib.Path("cache"), "not-a-digest")

    # --- publication reuses the cache -------------------------------------

    def test_execute_publishes_from_the_cache_and_keeps_it(self):
        recipe = self.recipe(output_name="mercury_albedo.png", output_format="png")
        calls = []

        def copying_processor(source, destination, _recipe):
            destination.write_bytes(source.read_bytes())

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            cache_root = root / "cache"
            output_root = root / "textures-src"
            for _ in range(2):
                self.fetch.execute(
                    (recipe,),
                    output_root,
                    processor=copying_processor,
                    recipe_catalog={recipe.id: recipe},
                    cache_root=cache_root,
                    opener=self.opener_for(self.PAYLOAD, calls),
                )
            published = output_root / "mercury" / "mercury_albedo.png"
            self.assertEqual(published.read_bytes(), self.PAYLOAD)
            self.assertEqual(len(calls), 1, "the second run must be served from the cache")
            self.assertTrue(self.fetch.cache_path(cache_root, recipe.sha256).is_file())

    def test_a_verified_file_source_is_copied_without_the_image_processor(self):
        recipe = self.recipe(kind="file", output_name="bennu_shape.tab", output_format="png")

        def refusing_processor(*_args, **_kwargs):
            raise AssertionError("a file-kind source must not reach Sharp")

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.fetch.execute(
                (recipe,),
                root / "textures-src",
                processor=refusing_processor,
                recipe_catalog={recipe.id: recipe},
                cache_root=root / "cache",
                opener=self.opener_for(self.PAYLOAD),
            )
            published = root / "textures-src" / "mercury" / "bennu_shape.tab"
            self.assertEqual(published.read_bytes(), self.PAYLOAD)

    def test_file_kind_validation_skips_the_image_contract(self):
        recipe = self.recipe(kind="file", output_name="shape.tab", width=0, height=0)
        self.assertIs(recipe.validate(), recipe)


if __name__ == "__main__":
    unittest.main()
