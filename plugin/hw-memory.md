# hw-memory — persistent project memory

You have permanent project memory via hw-memory tools. The project's `docs/` markdown is the source of truth; the memory DB is a ranked, decaying index over it plus episodic facts from sessions.

## When to store (hw_memory_add)

- **After resolving a non-obvious error or pitfall** — `kind: gotcha, rank: high`. One fact per call, dense, language-agnostic.
- **When the user pins a decision or constraint** ("remember that...", "we'll always...", "never change...") — `kind: decision`, `rank: high` (or `critical` for never-forget rules).
- **When you learn a durable project fact** not derivable quickly from code — `kind: fact`, default rank.
- Crucial facts (decision/gotcha or rank critical/high) are automatically appended to `docs/decisions.md` / `docs/gotchas.md`. Do not duplicate them into docs manually.

## When to recall (hw_memory_search)

- Before risky or uncertain work, and whenever a past decision, pitfall or constraint might exist.
- When the user references something "we decided earlier" or "remember the issue with...".

## Re-seed and migrate — direct user command only

- `hw_memory_seed` / `hw_memory_migrate`: **never run these on your own initiative.** Only when the user explicitly asks (e.g. "seed memory", "re-seed memory", "migrate .memory"). Default is a dry-run report — show it to the user and apply (`apply: true`) only after they confirm.
- `hw_memory_seed` is also the first-time seed: on a fresh install the memory DB is empty until the user runs it. If memory is empty and the project has docs/, mention to the user that seeding is available.
- Suggest re-seed when the user mentions they edited docs/ markdown manually.

## Rules

- One fact per `hw_memory_add` call. If the response says "Updated (duplicate)" the fact was already known — no need to store more.
- If a recalled fact conflicts with its source doc file (`src:` pointer), the doc file wins.
- Do not re-store facts that live in docs/ — seeding already indexed them (or will, once the user runs hw_memory_seed).
- Do not store run-specific data (build output, test numbers) — only durable knowledge.
- In all cases do not store any credentials or secrets - only a way to access them (for example - from config files).
- Ranks: `critical` never fades, `high` fades slowly (both never auto-deleted), `medium` default, `low` for ephemera that should fade fast.
