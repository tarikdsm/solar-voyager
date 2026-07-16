# T0033 Sun and Moon assets implementation plan

## 1. Lock source and budget contracts

- Record the measured texture experiments and accepted 4k/2k Moon startup tier
  in ADR-022 and the modeling/pipeline specifications.
- Add failing tests for the pinned NASA SVS recipes, output processing options,
  Moon-specific texture dimensions, and the named major-Moon triangle budget.

## 2. Prepare deterministic lunar textures

- Extend the existing texture processor without changing Earth recipe output.
- Add the Moon recipes and source attribution.
- Build a tested Moon-map preparer for macro normals and periodic isotropic
  regolith/microcrater detail maps.
- Run both recipes and preparation twice from clean output roots and compare
  hashes.

## 3. Build the normalized Moon

- Add tested catalog-driven Moon configuration and relief mapping helpers.
- Implement `build_moon.py` with fixed 128x64 tessellation, inward displacement,
  maximum normalized radius 1.0, deterministic radial normals, stable material
  names, and copied authored textures/attribution.
- Make the existing Sun builder clean-output-root reproducible.
- Build both bodies twice and compare complete output trees.

## 4. Preview and ingest

- Render the Moon through Blender in a controlled headless preview and inspect
  silhouette, albedo, relief, seams, poles, and material response.
- Run focused Sun/Moon ingest twice with the installed KTX executable and compare
  all runtime bytes.
- Validate manifests, texture roles/dimensions, budgets, and runtime loading.
- Measure the exact code+Sun+Earth+Moon+stars critical path and require less than
  8 MiB.

## 5. Verify and deliver

- Run all Python, JavaScript, and TypeScript tests plus lint, format, typecheck,
  production build, task validation, asset validation, and budget gates.
- Move T0033 to REVIEW, rebase, push, open the PR, and request review from a
  different agent.
- Address verified findings, obtain green CI and approval, then merge with the
  task marked DONE in the merge commit.
