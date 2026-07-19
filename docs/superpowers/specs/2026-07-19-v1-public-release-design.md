# T0101 public v1 release — design

## Goal and release boundary

Ship Solar Voyager as a polished, playable public v1 at the canonical GitHub
Pages URL. Every repository contract and every eligible task must be complete;
only the explicitly deferred M4 launch chain T0060–T0062 may remain BLOCKED.
The release is not complete until the exact green `main` commit is deployed,
audited live, and identified by an annotated `v1.0.0` tag.

The v1 remains the documented orbital-exploration sandbox: one spacecraft in a
real-scale solar system, starting in 400 km low Earth orbit. Atmospheric launch,
2D-to-3D launch handoff, landing, docking, missions and multiplayer are outside
this release. The release must not imply that those systems exist.

## Public landing and first playable

The existing Preact main menu becomes the public landing. It is already mounted
only after the reviewed startup pipeline has loaded eager assets, compiled eager
shaders and selected initial quality. Reusing it avoids a second navigation and
WebGL lifecycle, keeps New Game/Continue semantics intact, and adds no runtime
dependency or image payload.

The menu presents a concise title, mission description and three truthful facts:
float64 n-body orbital simulation, relativistic visual effects, and the 400 km
LEO starting point. A compact controls preview explains how to begin. New Game
or Continue stays the first actionable control, settings remain available, and
the existing accessible status/error region remains authoritative.

Desktop uses a balanced two-column card; narrow and short viewports collapse to
one scrollable column with full-width actions. Semantic headings, native buttons,
visible focus, sufficient contrast and reduced-motion behavior are mandatory.
Keyboard-only users must be able to launch a session without traversing
decorative content.

## Player, contributor and policy documentation

`README.md` becomes the public entry point and links the live game, quick start,
controls, save compatibility, hardware guidance, contribution workflow, credits,
privacy, accessibility, license, release notes and known limitations. Dedicated
documents hold details so the landing remains concise.

The controls document is derived from the shipped default bindings and clearly
labels rebindable inputs. Save documentation identifies the v2 save/settings
envelopes, legacy settings migration, browser-local storage keys, and JSON
export/import. Hardware guidance requires WebGL2 and explains the conservative
software-renderer fallback without promising hardware acceleration.

Privacy text states that the application has no accounts, analytics or server
save and distinguishes application behavior from GitHub Pages infrastructure
logs. Accessibility text records supported keyboard, focus, status, contrast and
reduced-motion behavior plus honest remaining canvas limitations. Credits name
the software and data/asset sources already recorded in the repository. The MIT
license is materialized as `LICENSE`, and package metadata is set to `1.0.0`.

## Canonical task dashboard and release contracts

The YAML files under `tasks/` remain the only task-state authority. A deterministic
generator reads every canonical task and replaces a marked JSON payload in
`docs/check_plan.html`; a check mode rejects drift. The dashboard footer is
computed from that payload instead of maintaining parallel hard-coded overrides.

A release-readiness checker verifies version, required public documents, local
README links, dashboard equality, and the allowed task-state set. Before final
delivery, all tasks except T0101 and T0060–T0062 must be DONE; the release branch
may carry T0101 through IN_PROGRESS and REVIEW, while only its merged completion
may satisfy the final state. Both checks run in CI and remain as permanent
anti-regression contracts.

## Performance, data and failure behavior

The landing uses text and CSS only. It creates no frame-loop work, geometry,
material, texture or shader and raises no budget. Simulation, save schemas,
commands, physics formulas, startup diagnostics and runtime data flow are
unchanged, so no ADR or physics-spec change is required.

Documentation and dashboard tools fail closed with actionable errors for malformed
YAML, missing files, unresolved local links, duplicate task IDs or unexpected
states. They perform no network requests and write only the dashboard target in
explicit generation mode.

## Verification and publication sequence

Unit and browser regressions first prove landing content, compact layout,
keyboard launch and absence of console/page errors. The final audit then runs
format, lint, typecheck, all Vitest and Python suites, production build, asset and
budget checks, render/performance gates, deterministic builds and a real-browser
desktop/compact production playtest.

Delivery order is strict:

1. transition T0101 to REVIEW and obtain independent C/I/M approval;
2. require exact-head CI, transition T0101 to DONE and merge to `main`;
3. require green CI and successful Pages deployment for the resulting `main`;
4. audit that exact live deployment for launch, assets, HTTP and console errors;
5. create and push annotated tag `v1.0.0` on that exact commit;
6. verify the remote tag object is annotated and peels to the deployed commit.

The branch and worktree are retained. No GitHub release object, budget increase,
force push or history rewrite is required.
