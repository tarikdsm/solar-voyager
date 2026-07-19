# T0101 public v1 release audit

## Candidate

The implementation audit was run from commit
`8553f9b6345dc6db79e72af4a818d9c401673b24` on 2026-07-19. Later evidence and
task-status commits do not change the runtime. The annotated `v1.0.0` tag remains
intentionally absent until the reviewed branch is merged and the exact `main`
commit passes CI, Pages deployment, and a cache-disabled live audit.

## Static, unit, and tool gates

- ESLint, both TypeScript projects, Prettier, and `git diff --check`: PASS.
- Vitest: 133 files passed, 1 skipped; 821 tests passed, 3 skipped.
- Python tool suite: 60/60 PASS.
- Task schema: 60 canonical YAML files; dashboard equality and release readiness:
  PASS.
- Repository content: 183,861,574 B / 300 MiB; runtime assets: 32,655,463 B /
  150 MiB; critical path: 4,354,239 B / 8 MiB.

## Independent-review corrections

The first exact-head review reported two important release-integrity gaps. The
public build now includes `THIRD_PARTY_LICENSES.txt` with the complete installed
Three.js, Preact, and signals MIT texts plus the Basis Universal and Draco
copyright notices and full Apache License 2.0 terms. A permanent gate compares
those texts to installed dependencies and requires the built copy to be
byte-identical. The production build and built-copy check pass.

A second compliance pass identified the separate Basis Universal NOTICE. Its
complete upstream text, including the 2016–2026 Binomial LLC copyright,
trademark, and redistribution clauses, is now reproduced verbatim modulo line
ending/trailing-space normalization. The gate pins the normalized upstream text
to SHA-256 `77fcc7890e65895eae308767546ad6233aa9599d196affa5f7101c8ff3a655b6`
and rejects a forged fixture even when both local copies agree.

CI now runs branch readiness only for pull requests and final readiness only for
pushes to `main`; the latter rejects any state where T0101 is not `DONE`. Focused
license, workflow, and release-readiness regressions pass 8/8. The post-correction
bundle remains 125,975 B entry gzip and 555,755 B total gzip, unchanged from the
audited candidate.

## Browser and performance gates

Every permanent CI browser gate passed against the production build: positive
and injected-error smoke, main menu, system map, burn log, tutorial, startup,
render depth, starfield, visual tiers, lighting/post, relativistic visuals,
surface detail, procedural Sun, gas giants, camera controls, renderer policy,
telemetry, HUD signals, state vectors, trajectory overlay, performance panel,
adaptive governor, and session settings.

- Production performance fixture: 10 draw calls, 77,071 triangles, and retained
  heap growth of 60,184 B.
- Bundle: 125,975 B entry gzip and 555,755 B total gzip against fixed ceilings of
  285,000 B and 570,000 B.
- Cold startup on SwiftShader: first playable in 1,014.4 ms; 34 programs both at
  ready and after first frame; exactly the four canonical runtime files; no
  success-path console/page errors. Manifest, hero texture, and bootstrap chunk
  failures all reached the accessible recovery path and succeeded on retry.
- Flight benchmark on NVIDIA GeForce RTX 3070 Laptop GPU: 6.1 ms median/p75,
  6.301 ms p99, +104,544 B steady retained heap, no browser errors, and no
  stability finding at the 5% limit.
- Simulation core: 10,000 sampled steps averaged 0.107794 ms, reused exactly two
  snapshot buffers, and retained -225,184 B after forced GC.

## Asset and build reproducibility

- Earth ingest generated 29 byte-identical files on two passes, totaling
  9,923,242 B, with decoded Draco/KTX2 material and texture contracts accepted.
- Blender 5.1.2 generated the Sun and quad-sphere contracts twice with identical
  GLB bytes; runtime Draco ingest passed in the isolated `build/blender-smoke`
  tree.
- Two complete production builds matched SHA-256 for all 159 emitted files.

## Manual playtest

The loaded landing, a new 400 km LEO session, and the system map were inspected
in the in-app browser. Desktop and 360×480 layouts were exercised; the compact
menu measured `top=8`, `right=352`, `bottom=472`, document width 360, and an
internal 1,037/463 px scroll range. Actions and settings remained reachable.
Desktop and compact browser warning/error logs were empty.

Local ignored captures:

- `.playwright-mcp/T0101-landing-desktop.png`
- `.playwright-mcp/T0101-flight-desktop.png`
- `.playwright-mcp/T0101-system-map.png`
- `.playwright-mcp/T0101-landing-compact.png`
- `.playwright-mcp/T0101-landing-compact-actions.png`

The dedicated server was stopped and port 5199 was verified released.

## Independent review and exact-head CI

Independent review approved implementation head `382523ade764547ce37a0dae783e90edb3bb5306`
at C0/I0/M0. GitHub Actions CI run `29704315912` passed on that exact SHA,
including the license/built-copy gate, branch-mode release readiness, performance,
smoke, trajectory, and all browser regressions. The final task-state commit is
validated separately in final mode before merge.

Task-state CI runs `29704741932` and `29705322179` reached the startup fixture's
`cold load` phase and then exhausted the five-minute outer timeout without a
product assertion or internal checkpoint. The fixture had held the intercepted
star-catalog route behind an externally released deferred promise. That protocol
is removed: the route handler now captures the loading state itself, reports any
capture error, and always continues the request in `finally`; the consuming
snapshot wait has an independent 30-second Node deadline. Five cold-load
checkpoints make any remaining stall observable. The five-minute outer limit and
every product/startup assertion remain unchanged. The focused liveness test and
complete startup regression pass locally; exact-head CI is rerun after this
correction.
