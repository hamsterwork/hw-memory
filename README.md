# hw-memory

Permanent memory for opencode agents. Single-file bundle with no runtime dependencies (zod is inlined), per-project SQLite database.

`docs/` markdown is the source of truth (human-first). hw-memory seeds a ranked, decaying index from it on first run, optionally writes managed facts back into it (per-entity, off by default), and collects episodic facts from sessions.

## Install

Quick install (macOS / Linux) — downloads the latest release and verifies its
SHA256 against the release `SHA256SUMS`:

Into the current project:

```sh
curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/install.sh | bash
```

Or globally (one install covers all projects — the DB is still per-project):

```sh
curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/install.sh | bash -s -- --global
```

Pin a release with `--version vX.Y.Z`. The installer fails closed if a checksum
does not match. Note: trust is rooted in HTTPS/GitHub; the checksum detects a
corrupted or tampered asset, not a compromised release. To pin independently,
set `HWM_SHA256=<hash>`.

Manual install (from a clone):

```sh
git clone https://github.com/hamsterwork/hw-memory.git
./hw-memory/install.sh /path/to/project      # project install
./hw-memory/install.sh --global              # global install
```

Either mode installs the single-file plugin into `.opencode/plugins/` and writes
the usage rules into the project's `AGENTS.md` — or its `CLAUDE.md` when that is
the active rules file — between `<!-- hw-memory:start -->` and
`<!-- hw-memory:end -->` markers. Re-running replaces that block in place and
never duplicates it. Then restart opencode. The DB is created at
`.opencode/hw-memory.db` and is gitignored automatically by `install.sh`.

## Database files

On first tool use the plugin creates three files in `<project>/.opencode/` — even
for a global install, because the DB is always per-project:

| File | What it is |
|---|---|
| `hw-memory.db` | the SQLite database itself |
| `hw-memory.db-wal` | write-ahead log — recent writes not yet merged into the main DB |
| `hw-memory.db-shm` | shared-memory index letting concurrent processes coordinate WAL readers/writers |

The two sidecars exist because the DB runs in WAL mode (`PRAGMA journal_mode = WAL`).
All three are gitignored by `install.sh`. They are safe to delete when no opencode
session holds the DB (both regenerate on next open), but deleting `hw-memory.db-wal`
while the DB is open loses the writes it still holds.

## What it does

- **Seed (by command)**: `hw_memory_seed` indexes `AGENTS.md`, `README.md`, `docs/**/*.md` into the DB — dry-run report first, `apply: true` to execute. Required once after install; re-run after manual doc edits. Per-file rank mapping: `docs/rules/` and decisions → critical, gotchas → high, architecture/context → high, changelog → low.
- **Wake-up**: injects top-ranked facts into the system prompt every session, with pointers to authoritative docs and an open technical-debt count.
- **Self-adding**: rule-based extraction from bash tool output (errors, dependencies) and assistant text (decisions). Repeated failures followed by success are promoted to gotchas.
- **Technical debt (`kind: debt`)**: bugs, mismatches and errors noticed while working on an unrelated task. Ranked `medium`…`critical`, never pruned until explicitly resolved (`hw_memory_debt`). The agent is instructed to report new debt before finishing a task.
- **Managed files (optional)**: `decision`, `gotcha` and `debt` live in the DB. Each entity can separately write back to markdown — `docs/hw-memory/decisions.md`, `gotchas.md`, `debt.md` by default. Fresh installs are DB-only (all disabled); enable per entity with `hw_memory_config`, or attach/import an existing file with `hw_memory_file` (`rework: true` ingests the file's current content).
- **Ranks and decay**: critical (never fades), high (slow, never pruned), medium (default), low (fast, pruned below weight 0.2). Debt is exempt from pruning/capping. Access-aware: frequently recalled facts decay slower.
- **Compaction-safe**: facts are re-injected as compaction context so nothing is lost at context boundaries.

## Tools

`hw_memory_add`, `hw_memory_search`, `hw_memory_stats`, `hw_memory_forget`, `hw_memory_debt` (list/resolve technical debt), `hw_memory_config` (per-entity managed-file enable/path), `hw_memory_file` (attach/sync/rework a markdown file for an entity), `hw_memory_seed` (re-sync from docs, dry-run default, explicit user command only), `hw_memory_migrate` (convert legacy `.memory/` and upgrade legacy `docs/decisions.md`/`docs/gotchas.md` into `docs/hw-memory/`, never deletes anything).

## Development

```sh
npm install
npm test              # node --test, 63 tests
npm run test:install  # installer tests: project/global, AGENTS.md/CLAUDE.md, SHA256
npm run build         # bundles src/hw-memory.ts -> plugin/hw-memory.ts (single file, zod inlined)
npm run typecheck
```

Runtime: the plugin runs inside opencode's Bun (`bun:sqlite`); tests run on Node 26+ (`node:sqlite`) via a small runtime adapter. FTS5 keyword search only; schema leaves room for future embeddings.

## Safety

The tool never deletes memories of rank critical/high, never deletes files, and never runs `hw_memory_seed`/`hw_memory_migrate` without an explicit user command. Manual edits to docs are not tracked; run `hw_memory_seed` to compare and re-sync.
