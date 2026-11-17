# hw-memory — persistent project memory

You have permanent project memory via hw-memory tools and `/hw-*` commands. The memory DB is a ranked, decaying index plus episodic facts from sessions. Docs remain human-owned; hw-memory never seeds or edits them without an explicit command and approval.

## Commands (direct user invocation only)

- `/hw-seed <path> [--apply] [--changed]`: seed memory from one file (no size cap) or a folder (capped). Dry-run report by default; `--apply` commits. Never seed on your own initiative.
- `/hw-docs [--apply] [--id N]`: review proposed doc updates and seeded-file drift. Writes only after approval. Doc files under `docs/hw-memory/` are plugin-managed; no markers in human docs.
- `/hw-changes [version] [--source git|journal] [--ai] [--export]`: human-readable change list since a git tag or checkpoint. Deterministic by default; `--ai` is opt-in and calls a model.
- `/hw-dashboard [--prune]`: top debts, reminders, prune proposals and pending doc updates. `--prune` approves all proposed medium-rank prunes.
- `/hw-debts`: list open technical debt. `/hw-reminders`: list reminders, plans and open questions.

Use `hw_memory_add` for new facts, `hw_memory_search` to recall them, `hw_memory_stats`/`hw_memory_forget`/`hw_memory_debt`/`hw_memory_config` for maintenance. Tool names keep the `hw_memory_` prefix; commands use `hw-`.

## When to store (hw_memory_add)

- **After resolving a non-obvious error or pitfall** — `kind: gotcha, rank: high`. One fact per call, dense, language-agnostic.
- **When the user pins a decision or constraint** ("remember that...", "we'll always...", "never change...") — `kind: decision`, `rank: high` (or `critical` for never-forget rules).
- **When you learn a durable project fact** not derivable quickly from code — `kind: fact`, default rank.
- **For plans, TODOs and open questions** — `kind: reminder, rank: medium`. Reminders are never pruned.
- **For release notes gathered by `/hw-changes`** — `kind: changelog`. Stored automatically; `docs/hw-memory/changelog.md` is exported on request.

`error` and `dependency` are internal auto-only kinds from tool-output extraction; do not add them manually.

## Technical debt (hw_memory_add kind: debt / hw_memory_debt)

- When you notice a **bug, mismatch or error unrelated to the current task**, record it immediately: `hw_memory_add` with `kind: debt` and `rank` from `medium` to `critical` (severity reflects impact — a formatting nit is `medium`, a potential 500 is `critical`).
- Debt is never auto-deleted and never decays away; it stays until explicitly resolved with `hw_memory_debt` (`action: resolve`).
- **Before finishing a task you MUST tell the user about every debt item you recorded in that task.** Use `hw_memory_debt` (`action: list`) to recall the open items.
- Use `hw_memory_debt` (`action: list`) to review open debt when the user asks about known issues.

## Pruning and obsolescence

- `debt`, `reminder` and `changelog` facts are **never** pruned or capped.
- `critical` facts are never pruned. `high` decisions/gotchas are protected until marked obsolete, then demoted to `low`.
- `medium` decisions/gotchas that decay below weight 0.2 are **proposed**, not deleted. Review with `/hw-dashboard` and approve with `--prune`.
- `low` facts and low-rank non-special facts are pruned silently. All kinds still decay by age and access.
- `cap_rows` keeps at most 500 facts by default; configure with `hw_memory_config` (`cap_rows`, 50..100000).

## Managed docs (hw_memory_config / /hw-docs)

- `decision`, `gotcha`, `debt`, `reminder`, `changelog` facts can be exported into `docs/hw-memory/{decisions,gotchas,debt,reminders,changelog}.md`.
- Adding a managed fact **queues a proposal**; it does not write the file. Review with `/hw-docs`, then write with `/hw-docs --apply`.
- The safe writer only appends bullets and removes exact plugin-written lines for obsolete facts. User prose is never overwritten. No markers are inserted into docs.
- `hw_memory_config` toggles each entity and sets `cap_rows`, `changelog.source` (`auto|git|journal`, default `auto`) and `changelog.summary` (`deterministic|ai`, default `deterministic`).

## When to recall (hw_memory_search)

- Before risky or uncertain work, and whenever a past decision, pitfall or constraint might exist.
- When the user references something "we decided earlier" or "remember the issue with...".

## Rules

- One fact per `hw_memory_add` call. If the response says "Updated (duplicate)" the fact was already known — no need to store more.
- Seeded facts carry a source path (`src:` pointer). If a recalled fact conflicts with its source file, the file wins.
- Do not re-store facts already indexed from a seeded file; re-run `/hw-seed <path> --apply` after the user edits that file.
- Do not store run-specific data (build output, test numbers) — only durable knowledge.
- In all cases do not store any credentials or secrets - only a way to access them (for example - from config files).
- Completion phrases in your prompt ("task finished", "done", "готово") force a drift check on session idle; a throttled idle scan reports changed seeded files.
- Ranks: `critical` never fades, `high` fades slowly, `medium` default, `low` for ephemera that should fade fast.
