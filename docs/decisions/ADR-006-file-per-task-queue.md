# ADR-006: File-per-task YAML queue in the repo

**Status:** accepted (2026-07-15)

## Decision

The multi-agent work queue is one YAML file per task under `tasks/`, with claims performed as single status-flip commits to `main` (full rules in `docs/task-protocol.md`).

## Why

- Two agents claiming *different* tasks never touch the same file — claims are conflict-free by construction; a rejected push IS the lock signal.
- Plain files in git = every agent (Claude Code, ChatGPT, Grok, humans) can read/write them with no external service, no API keys, full history/auditability.
- YAML schema is CI-checkable (duplicate ids, invalid states, broken `depends_on`).

## Alternatives

GitHub Issues/Projects (needs API access from every agent, weaker offline story, not diff-reviewable), single backlog.md (merge-conflict magnet — rejected), external trackers (dependency we don't want).
