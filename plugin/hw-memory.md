# hw-memory — persistent project memory

You have permanent project memory via hw-memory tools. The project's `docs/` markdown is the source of truth; the memory DB is a ranked, decaying index over it plus episodic facts from sessions.

## When to store (hw_memory_add)

- **After resolving a non-obvious error or pitfall** — `kind: gotcha, rank: high`. One fact per call, dense, language-agnostic.
- **When the user pins a decision or constraint** ("remember that...", "we'll always...", "never change...") — `kind: decision`, `rank: high` (or `critical` for never-forget rules).
- **When you learn a durable project fact** not derivable quickly from code — `kind: fact`, default rank.

## Technical debt (hw_memory_add kind: debt / hw_memory_debt)

- When you notice a **bug, mismatch or error unrelated to the current task**, record it immediately: `hw_memory_add` with `kind: debt` and `rank` from `medium` to `critical` (severity reflects impact — a formatting nit is `medium`, a potential 500 is `critical`).
- Debt is never auto-deleted and never decays away; it stays until explicitly resolved with `hw_memory_debt` (`action: resolve`).
- **Before finishing a task you MUST tell the user about every debt item you recorded in that task.** Use `hw_memory_debt` (`action: list`) to recall the open items.
- Use `hw_memory_debt` (`action: list`) to review open debt when the user asks about known issues.

## Managed files (hw_memory_config / hw_memory_file)

- `decision`, `gotcha` and `debt` facts live in the DB. Each entity can *optionally* also be written to a markdown file.
- Fresh installs have all three **disabled** (DB only). Enable and aim them with `hw_memory_config` (`entity`, `enabled`, `path`); defaults are `docs/hw-memory/decisions.md`, `gotchas.md`, `debt.md`.
- `hw_memory_file` attaches a specific file to an entity (`kind`, `file`) and appends any missing facts. `rework: true` first reads that file's existing content into the DB — use it to adopt memoirs that live outside `docs/`.

## When to recall (hw_memory_search)

- Before risky or uncertain work, and whenever a past decision, pitfall or constraint might exist.
- When the user references something "we decided earlier" or "remember the issue with...".

## Re-seed and migrate — direct user command only

- `hw_memory_seed` / `hw_memory_migrate`: **never run these on your own initiative.** Only when the user explicitly asks (e.g. "seed memory", "re-seed memory", "migrate .memory"). Default is a dry-run report — show it to the user and apply (`apply: true`) only after they confirm.
- `hw_memory_seed` is also the first-time seed: on a fresh install the memory DB is empty until the user runs it. If memory is empty and the project has docs/, mention to the user that seeding is available.
- `hw_memory_migrate` also upgrades legacy `docs/decisions.md` / `docs/gotchas.md` to the managed `docs/hw-memory/` layout and enables those entities.
- Suggest re-seed when the user mentions they edited docs/ markdown manually.

## Rules

- One fact per `hw_memory_add` call. If the response says "Updated (duplicate)" the fact was already known — no need to store more.
- If a recalled fact conflicts with its source doc file (`src:` pointer), the doc file wins.
- Do not re-store facts that live in docs/ — seeding already indexed them (or will, once the user runs hw_memory_seed).
- Do not store run-specific data (build output, test numbers) — only durable knowledge.
- In all cases do not store any credentials or secrets - only a way to access them (for example - from config files).
- Ranks: `critical` never fades, `high` fades slowly (both never auto-deleted), `medium` default, `low` for ephemera that should fade fast.
