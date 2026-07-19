"""Build Saturn through the catalog-driven ringed-planet authoring path."""

import pathlib
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from build_planet import main  # noqa: E402


if __name__ == "__main__":
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    main(["--id", "saturn", *arguments])
