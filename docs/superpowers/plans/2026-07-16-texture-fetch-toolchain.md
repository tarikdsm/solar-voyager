# T0031 texture fetch toolchain implementation plan

## 1. Lock the recipe and pure contracts

- Add failing Python tests for recipe selection, fixed paths, SHA-256 validation,
  bounded streaming, stable attribution, and transaction behavior.
- Implement the Earth albedo recipe and pure helpers in `tools/fetch_textures.py`.

## 2. Add deterministic image processing

- Add failing integration coverage for a small local 2:1 image.
- Implement `tools/textures/processImage.mjs` with Sharp and strict dimensions,
  RGB PNG output, stripped metadata, and atomic publication coordinated by Python.
- Prove two identical runs produce the same hash.

## 3. Exercise the real Earth path

- Fetch the official pinned 8k Earth day map and confirm its checksum.
- Produce the guide-compliant 8192x4096 PNG and generated source attribution.
- Build a temporary complete Earth authoring fixture using the generated albedo.
- Run T0035 with `KTX_BIN=C:\Program Files\KTX-Software\bin\ktx.exe` and confirm
  the runtime asset stays below 20 MiB.

## 4. Document and deliver

- Update the asset-pipeline credit table/license notes and Earth `SOURCES.md`.
- Add CLI commands to `tools/README.md` and package scripts where useful.
- Run Python/TypeScript tests, lint, typecheck, formatting, build, task schema,
  asset budgets, and the real Earth acceptance.
- Move T0031 to REVIEW, rebase, push, open a PR, and request independent review.
