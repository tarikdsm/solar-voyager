# Skill: Add a Celestial Body

Checklist for adding a body to the catalog. Specs: `docs/physics-spec.md` §2, `docs/asset-pipeline.md`, `docs/rendering-spec.md` §3.

## Steps

1. **Catalog entry** in `data/bodies.json`: id (lowercase canonical name), name, GM (km³/s², from JPL), radius km, parent body id, osculating elements at J2026 epoch `{a, e, i, Ω, ω, M₀}` (parent-relative for moons), rotation period, axial tilt, geometric albedo, SOI radius (compute `a·(m/M)^(2/5)`), `surface` descriptor stub, visual tier params (albedo color for the point sprite), asset ref + procedural seed if applicable.
2. **Ephemerides check vectors:** run `tools/bake_ephemerides.py --only <id>` to (re)generate the body's elements AND its entries in `data/ephemerides-check.json` (state vectors at epoch, +30 d, +365 d). Never hand-type elements.
3. **Regression test:** add the body to the rails-accuracy test (`tests/sim/rails.test.ts`); bounds per physics-spec §2 table.
4. **Asset:** 
   - Planet/major moon: params into the relevant `tools/blender/build_*.py`, source texture per the asset-pipeline credit table, run headless build, check the printed manifest against budgets.
   - Asteroid/comet: seed + shape params in bodies.json; `build_asteroid.py`/`build_comet.py` generates it (or decimate a published shape model to ≤5k tris).
5. **Visual ladder:** confirm tier thresholds work (sprite magnitude uses radius/albedo from the catalog automatically); add ring/coma config if applicable.
6. **Verify:** `npm test` (rails bounds), `npm run check:budgets`, load the dev build and fly to the body (both far sprite and close model).

## Gotchas

- Moons' elements are PARENT-relative; heliocentric elements for a moon are a bug the rails test will catch.
- Hyperbolic/near-parabolic comets: make sure e > 1 uses the hyperbolic Kepler branch.
- Keep `bodies.json` ordered: Sun, planets in order, then moons grouped by parent, then dwarfs, asteroids, comets.
