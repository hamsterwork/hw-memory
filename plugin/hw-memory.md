# hw-memory — persistent project memory

You have permanent project memory via hw-memory tools and `/hw-*` commands. The memory DB is a ranked, decaying index plus episodic facts from sessions. Docs remain human-owned; hw-memory never seeds or edits them without an explicit command and approval.

## Commands (direct user invocation only)

- `/hw-seed <path> [--apply] [--changed]`: seed memory from one file (no size cap) or a folder (capped). Dry-run report by default; `--apply` commits. Markers and keyword heuristics are recognised in English and Russian (`[decision]`/`[решение]`, `[debt]`/`[долг]`, `TODO:`/`вопрос:`). Never seed on your own initiative.
- `/hw-docs [--apply] [--id N]`: review proposed doc updates and seeded-file drift. Writes only after approval. Doc files under `docs/hw-memory/` are plugin-managed; no markers in human docs.
- `/hw-changes [version] [--source git|journal] [--ai] [--export]`: human-readable change list since a git tag or checkpoint. Deterministic by default; `--ai` is opt-in and calls a model.
- `/hw-dashboard [--prune]`: top debts, reminders, prune proposals and pending doc updates. `--prune` approves all proposed medium-rank prunes.
- `/hw-debts`: list open debt (code, process, data, research). `/hw-reminders`: list reminders, plans and open questions.

Use `hw_memory_add` for new facts, `hw_memory_search` to recall them, `hw_memory_stats`/`hw_memory_forget`/`hw_memory_debt`/`hw_memory_reminder`/`hw_memory_config` for maintenance. Tool names keep the `hw_memory_` prefix; commands use `hw-`.

## When to store (hw_memory_add)

- **After resolving a non-obvious error or pitfall** — `kind: gotcha, rank: high`. One fact per call, dense, language-agnostic.
- **When the user pins a decision or constraint** ("remember that...", "we'll always...", "never change...") — `kind: decision`, `rank: high` (or `critical` for never-forget rules).
- **When you learn a durable project fact** not derivable quickly from code — `kind: fact`, default rank.
- **For plans, TODOs and open questions** — `kind: reminder, rank: medium`. Reminders are never pruned.
- **For release notes gathered by `/hw-changes`** — `kind: changelog`. Stored automatically; `docs/hw-memory/changelog.md` is exported on request.

`error` and `dependency` are internal auto-only kinds from tool-output extraction; do not add them manually.

## Open items: debt and reminders (hw_memory_debt / hw_memory_reminder)

- **Debt is a knowingly accepted cost that grows while it stays open** — not only code. Record it immediately with `kind: debt` and `rank` from `medium` to `critical`; severity is the cost of delay (a formatting nit is `medium`, a silently wrong report or a potential 500 is `critical`):
  - code: workaround, missing test, duplicated logic, API mismatch;
  - management: manual reconciliation, two reports defining one metric differently, undocumented decision, a step only one person can run;
  - research: dataset without provenance or version, unreproducible analysis, unvalidated assumption, stale source.
- If ignoring it gets more expensive, it is debt; if it only needs doing, it is a `reminder`.
- Record plans, open questions and follow-ups with `kind: reminder`.
- Both kinds stay until they are explicitly disposed of, and every list shows age (`open 41d, checked 18d ago`):
  - `action: verify` — you checked it and it is still open. This records the check date only; weight and the decay clock are untouched, so re-verifying an item cannot keep it alive forever.
  - `action: resolve` — it is done or no longer relevant. It leaves the lists; its managed-doc line, if any, is removed on the next `/hw-docs --apply`.
- Use `hw_memory_debt` / `hw_memory_reminder` (`action: list`, the default) to review open items when the user asks about known issues.

## Finishing a task

- **Before finishing a task, dispose of every open debt/reminder the task touched** — resolve it, verify it, or leave it open with an explicit reason. New debt and reminders are reported to the user in the same turn they are recorded.
- Completion phrases ("done", "готово") trigger a finish check on session idle; a background pass covers items unchecked for a week or more. When a check lists ids, tell the user and verify or resolve each one. An item checked today is not repeated that day.
- Completion phrases also force a drift check of seeded files; otherwise a throttled idle scan reports changed seeded files.

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
- Ranks: `critical` never fades, `high` fades slowly, `medium` default, `low` for ephemera that should fade fast.
