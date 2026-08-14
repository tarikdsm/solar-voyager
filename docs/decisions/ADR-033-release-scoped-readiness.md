# ADR-033: Release-scoped readiness checking

**Status:** accepted (2026-08-14)

## Context

`tools/checks/releaseReadiness.mjs` (`npm run check:release`) gates every PR and
the final push to `main`. Its v1 rule was blunt: every task file other than
`T0060`–`T0062` (deferred) and `T0101` (the release gate itself) had to be
`DONE`. That was correct while v1.0 was the only release in flight, but it
hard-fails the instant a v2 task file exists in any other state — and v2 work
is dozens of tasks landing incrementally as `TODO`/`CLAIMED`/`IN_PROGRESS`
over many PRs (`docs/superpowers/plans/2026-08-14-v2-free-flight.md`). Without
a change, no v2 task file could be committed at all, which blocks the entire
v2 effort at its first task (T0102).

The check cannot simply drop the "must be DONE" rule — that is exactly the
invariant that keeps a half-finished feature from reaching the public
`main` deploy (GitHub Pages, no staging environment). The rule needs to keep
applying to the *shipped* v1.0 scope while not applying to *not-yet-shipped*
work, and that boundary is not a numeric task-id cutoff: ids are assigned
sequentially as tasks are created, not as they ship, so a later v1 patch task
could in principle get an id past the v2 range. The only correct boundary is
an explicit, committed list of "what shipped in this release."

## Decision

1. Add a committed `tools/checks/releaseManifest.json`. Its top-level keys are
   named release scopes (`v1` today); each scope is `{ description, taskIds }`
   with `taskIds` an explicit array of task ids. The `v1` scope is frozen to
   the exact 60 ids that shipped v1.0 GA (enumerated by hand from `tasks/` at
   the time T0101 went `DONE`) and must not be edited retroactively.
2. `verifyReleaseReadiness(root, { final, release })` gains a `release` option
   (default `'v1'`, CLI `--release=<name>`). For any task **not** matched by
   `DEFERRED_TASKS` (`T0060`–`T0062`) or `T0101`: if its id is in the selected
   release scope's `taskIds`, the existing "must be DONE" rule applies
   unchanged; if its id is **not** in that scope, the task is exempt from the
   DONE rule entirely. It remains fully schema-validated by `check:tasks`
   (`tools/checks/taskSchema.mjs`), which is unaffected by this change — only
   release-readiness gating is scoped.
3. The `T0060`–`T0062` deferred-BLOCKED rule and the `T0101` gate-status rule
   are unconditional — they do not depend on `release` or the manifest. They
   are permanent v1 invariants, not release-scoped ones, so relaxing the
   manifest can never weaken them.
4. `--release=v2` is implemented and unit-tested now (a second named scope
   selects a second, independently-enforced task-id set) but the committed
   manifest does not yet define a `v2` scope — requesting it today fails
   closed with a `release manifest: … unknown or invalid release scope "v2"`
   finding. A future task defines `manifest.v2` once the v2 task list
   stabilizes and wires `--release=v2` into the final-release CI step,
   mirroring today's `--final` step. Today's two CI invocations
   (`check:release` on PRs, `check:release -- --final` on `main` pushes) pass
   no `--release` flag and therefore keep exactly today's v1 semantics.
5. An unreadable, malformed, or scope-missing manifest is a finding (not a
   silent pass) — `verifyReleaseReadiness` treats manifest failures the same
   way it treats a broken `package.json` or `tasks/` read: collect one
   descriptive finding and continue checking everything else so CI reports
   all drift at once.

## Consequences

- v2 task files can be committed in `TODO`/`CLAIMED`/`IN_PROGRESS`/`REVIEW`
  status without failing `check:release`, unblocking T0103 onward.
- v1's exact release contract is unchanged: `T0060`–`T0062` BLOCKED, `T0101`
  gate semantics, required docs/version/README-link checks, and dashboard
  equality all behave exactly as before for the default (`v1`) scope —
  proven by the pre-existing test suite passing unmodified plus new
  regression tests for the exemption path.
- The manifest is the single source of truth for "what counts as v1.0";
  editing `v1.taskIds` after the fact should read as a red flag in review,
  not a routine change.
- A future v2 final-release audit reuses the same mechanism (`--release=v2`
  against a `v2` scope covering the full v2 task list) instead of requiring a
  second bespoke checker.

## Alternatives considered

- **Numeric id cutoff** (e.g. "id < T0102 must be DONE"): rejected — task ids
  are assigned at creation time in the shared queue (`docs/task-protocol.md`
  rule 7), not at ship time, so id order does not reliably track release
  membership.
- **A `release:` field on each task file**: rejected for v1 — it would mean
  editing 60 already-`DONE` v1 task files just to backfill a label, for no
  behavior v1 needs today. The manifest gets the same effect with a single
  new file and zero edits to shipped task records.
