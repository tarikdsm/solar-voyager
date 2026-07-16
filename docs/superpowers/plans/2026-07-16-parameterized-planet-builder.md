# T0032 parameterized planet builder implementation plan

1. Add failing catalog-generator/schema tests for schema v2 and the required
   visual polar-radius ratio; implement ADR-021 across generator and data.
2. Add pure CLI/config tests for planet selection, rejection of non-planets,
   texture-role discovery, and stable output paths.
3. Implement `build_planet.py` with T0030 helpers, catalogued polar scaling,
   Earth surface/cloud materials, strict export, and extended manifest.
4. Make `build_earth.py` a compatibility entry delegating to the parameterized
   entry, then prove two Blender processes produce identical artifacts.
5. Run real T0035 KTX/Draco ingest twice, compare hash trees, enforce hero and
   critical-path budgets, and visually inspect Earth if the output changes.
6. Update docs/task handoff, run all repository gates, deliver for independent
   review, and integrate only after CI and review are green.
