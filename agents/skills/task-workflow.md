# Skill: Task Workflow

How to pick up, execute, and deliver a task in this repo. Full rules: `docs/task-protocol.md` (this is the operational checklist).

## Checklist

1. **Sync:** `git checkout main && git pull`.
2. **Pick:** choose a `status: TODO` task in `tasks/` whose `depends_on` are all `DONE`, matching your strengths. Respect milestone order (`docs/roadmap.md`).
3. **Claim:** edit ONLY that task file — `status: CLAIMED`, `agent: <you>`, `branch: task/<id>-<slug>`. Commit to main: `chore(tasks): [T00XX] claim`. Push immediately. **Push rejected → pull, pick another task.**
4. **Branch:** `git checkout -b task/<id>-<slug>`.
5. **Start:** flip to `IN_PROGRESS` (commit on main, then rebase your branch). Read the docs cited in the task's `spec` and any matching skill in `agents/skills/`.
6. **Work:** follow `docs/coding-standards.md`. Physics code cites `physics-spec.md` sections. Tests in the same commits (see write-physics-test.md). Run locally: `npm run lint && npm run typecheck && npm test && npm run build`.
7. **Deliver:** rebase on main; flip task to `REVIEW` in a commit on your branch; open PR titled `[T00XX] <title>`; in the description, address each acceptance criterion with how you verified it.
8. **Review (when you are the reviewer):** you must NOT be the task's author. Verify acceptance criteria, spec citations, standards, CI green. Merge = flip to `DONE`.
9. **Pausing/abandoning:** write `handoff_notes` (state of the work, what's left, gotchas), push the branch, flip status accordingly. The next agent only knows what you wrote down.

## Never

- Code without a claimed task. Push code directly to main. Claim two tasks at once. Weaken CI or tests to pass. Leave decisions undocumented.
