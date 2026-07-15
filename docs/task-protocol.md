# Task Protocol — Multi-Agent Development

Three (or more) agents — Claude Code, ChatGPT, Grok — plus the human maintainer work this repository from a **single shared task queue**. These rules exist so agents never collide. They are not optional.

## The queue

- One YAML file per task in `tasks/`: `T####-short-slug.yaml` (template: `tasks/_template.yaml`).
- File-per-task means claiming different tasks never touches the same file — claims are conflict-free by construction.
- States: `TODO → CLAIMED → IN_PROGRESS → REVIEW → DONE`, plus `BLOCKED` (with reason).

```yaml
id: T0042
title: Trajectory prediction worker
status: TODO            # TODO | CLAIMED | IN_PROGRESS | REVIEW | DONE | BLOCKED
agent: ""               # claude | chatgpt | grok | human — empty while TODO
branch: ""              # task/T0042-trajectory-predictor (set when claimed)
depends_on: [T0018, T0021]
milestone: M5
spec: |
  What to build, referencing docs/ sections. The docs are the spec of record;
  this field points into them and adds task-local detail.
acceptance:
  - Concrete, verifiable criteria (tests to pass, numbers to hit, budgets to respect)
handoff_notes: ""       # fill when pausing, unclaiming, or passing work on
```

## Rules

1. **Claiming.** `git pull` immediately before claiming. Claim = a single commit to `main` that flips `status: TODO → CLAIMED`, sets `agent` and `branch`. Push at once. If the push is rejected, someone else claimed it — pull and pick another task. Never claim a task whose `depends_on` are not all `DONE`.
2. **Branching.** All work happens on `task/<id>-<slug>`. The ONLY commits that go directly to `main` are task-file status flips and new TODO task files. Code reaches `main` exclusively via PR.
3. **Working.** Flip to `IN_PROGRESS` (commit on main) when you start. One task `IN_PROGRESS` per agent at a time. Read the relevant `agents/skills/*.md` before starting a task of that type.
4. **Delivering.** Open a PR titled `[T0042] Trajectory prediction worker`; flip the task to `REVIEW` in the same PR (the task file change rides on the branch). The PR description must state how each acceptance criterion was verified.
5. **Review.** A **different** agent (or the human) reviews. The reviewer checks acceptance criteria, spec compliance (`physics-spec.md` citations), and standards. The merger flips the task to `DONE` (rides in the merge).
6. **Stale claims.** A `CLAIMED`/`IN_PROGRESS` task with no commit on its branch for 48 h may be reset to `TODO` by anyone; explain in `handoff_notes`.
7. **Creating tasks.** Anyone may add `TODO` task files. `id` = max existing + 1, zero-padded to 4 digits. CI rejects duplicate ids. Every task states `milestone` and `depends_on`.
8. **Interface changes.** Any change to `SimSnapshot`, `Commands`, the `bodies.json` schema, or `docs/physics-spec.md` formulas requires an ADR (`docs/decisions/ADR-###-*.md`) in the same PR.
9. **CI is the arbiter.** A PR that fails lint / typecheck / tests / build / budgets / task-schema checks does not merge, no matter which agent wrote it. Do not weaken CI to pass it.
10. **Blocked.** If you discover a dependency mid-task, flip to `BLOCKED` with the blocking task id in `handoff_notes`, and either claim the blocker (if free and you're able) or pick other work.
11. **Communication happens in the repo.** Agents don't share memory. Everything another agent needs must be in: the task file, the PR description, `handoff_notes`, or `docs/`. If you made a decision, write it down where the next agent will look.

## Milestones

See `docs/roadmap.md`. Do not start tasks from milestone N+1 while their milestone-N dependencies are open — the DAG in `depends_on` encodes this.

## Conflict etiquette

- Rebase your branch on `main` before opening a PR.
- If two agents accidentally collide on a file, the one whose task owns that module (per `architecture.md` layering) wins; the other rebases.
- Never rewrite `main` history. Never delete another agent's branch.
