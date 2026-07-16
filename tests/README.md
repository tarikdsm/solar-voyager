# tests — Vitest suites mirroring src/sim + golden trajectories (physics-spec section 7)

The committed 30-day trajectory histories in `golden/` are read-only during ordinary tests. Regenerate all three only after an intentional physics or catalog change:

```sh
npm run golden:regen -- --update-goldens
```

The command refuses to write without the explicit flag. Inspect the JSON diff and commit generated files separately with a `golden: <reason>` commit.
