# hw-memory

[Русская версия](README.ru.md)

**hw-memory gives your agent a durable memory.** It remembers the decisions, pitfalls, technical debt and open plans your team makes in chat, and brings them back in the next session — right when they matter. No account, no cloud, no changes to your docs unless you approve them.

- **Remembers what matters** — decisions, gotchas, debt, reminders and changelog facts, ranked by importance.
- **Lives with your project** — the database sits next to your code and stays private to each location.
- **Puts docs in your hands** — every doc update is proposed first and written only after your approval.
- **Works on its own** — learns from tool output and conversation without you taking notes.

## Install

Quick install (macOS / Linux) downloads the latest release and verifies its SHA256 checksum.

Into the current project:

```sh
curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/install.sh | bash
```

Globally — one install for all projects, with a separate database for each:

```sh
curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/install.sh | bash -s -- --global
```

Pin a release with `--version vX.Y.Z`. For an independent checksum, set `HWM_SHA256=<hash>`. If a checksum does not match, the install stops without writing anything.

Manual install from a clone:

```sh
git clone https://github.com/hamsterwork/hw-memory.git
./hw-memory/install.sh /path/to/project      # project install
./hw-memory/install.sh --global              # global install
```

The installer places the plugin in `.opencode/plugins/` and adds the usage rules to your project's `AGENTS.md` (or `CLAUDE.md` when that is your active rules file) between clearly marked lines. Re-running updates that block in place. Restart opencode afterwards.

## Update

`update.sh` detects the installed version, compares it with the latest GitHub release and, with your confirmation, installs the verified release while keeping a `.bak` of the previous plugin.

```sh
# project install (run from the project root)
curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/update.sh | bash

# global install
curl -fsSL .../update.sh | bash -s -- --global

# check only — no changes, exit code 1 when an update is available
curl -fsSL .../update.sh | bash -s -- --check
```

From a clone: `./update.sh [target-dir]`, `./update.sh --global` or `npm run update`. Flags: `--version vX.Y.Z`, `--base-url`, `--no-rules`, `--yes` (non-interactive) and `--check`. The rules block is refreshed unless `--no-rules` is given, and the download is verified before anything is written.

## Usage

Seed a file or folder once, then let the agent work normally. It recalls saved facts when needed, stores new ones as it goes, and proposes doc updates for you to review.

### Commands

| Command | Purpose |
|---|---|
| `/hw-seed <path> [--apply] [--changed]` | Seed a file or folder; dry-run first |
| `/hw-docs [--apply] [--id N]` | Review and write proposed doc updates; report drift |
| `/hw-changes [version] [--source git\|journal] [--ai] [--export]` | Change list and changelog export |
| `/hw-dashboard [--prune]` | Debts, reminders, prune proposals, doc updates |
| `/hw-debts` | List open debt and its age |
| `/hw-reminders` | List reminders, plans and open questions |

Reports are deterministic; only `/hw-changes --ai` calls a model.

### Tools

`hw_memory_add`, `hw_memory_search`, `hw_memory_stats`, `hw_memory_forget`, `hw_memory_debt` (list/verify/resolve debt), `hw_memory_reminder` (list/verify/resolve reminders) and `hw_memory_config` (settings). Just ask your agent to remember, recall or configure something — it will pick the right tool.

### Settings

Ask your agent to change a setting with `hw_memory_config`, or give it a direct instruction such as "keep at most 1000 memories" or "use git history for the changelog".

| Setting | Values | What it does |
|---|---|---|
| `cap_rows` | 50..100000, default 500 | Maximum facts kept per project; lowering it applies immediately |
| `changelog.source` | `auto`, `git`, `journal` | Where `/hw-changes` reads history from (`auto` uses git when available) |
| `changelog.summary` | `deterministic`, `ai` | Bullet summary style (`ai` calls a model when you run `/hw-changes --ai`) |
| `decision` / `gotcha` / `debt` / `reminder` / `changelog` | `enabled` / `disabled`, default disabled | Whether that kind is exported to `docs/hw-memory/` |

Managed exports are written only when you run `/hw-docs --apply`. To disable one, set its entity to `disabled` with `hw_memory_config`.

### Your data

Each location keeps its own database at `.opencode/hw-memory.db`. The installer adds it (and its companion files) to `.gitignore`. Managed exports, when enabled, live under `docs/hw-memory/`.

## Safety

hw-memory never overwrites your prose in docs, never writes a doc without `/hw-docs --apply`, and never seeds a file without an explicit `/hw-seed <path>`. It keeps important facts by default and only proposes cleanup for borderline ones, which you approve with `/hw-dashboard --prune`.

## Advanced usage

### Scoped seeding

`/hw-seed <path>` reads one file (no size limit) or a folder (200 files / 1 MiB per file / depth 8 by default). It shows a dry-run report first; `--apply` saves the result. Bullets are classified by markers such as `[decision]`, `[gotcha]` and `TODO:` or by keyword heuristics, in English and Russian (`[решение]`, `[долг]`, `вопрос:` and their keyword equivalents). Facts that disappear from a seeded scope are demoted, not silently deleted. After you edit a seeded file, drift is reported at idle, and `/hw-seed <path> --apply` re-syncs that scope.

### Managed docs

For each enabled kind, new facts are queued as proposals. `/hw-docs` shows what would be written or removed; `/hw-docs --apply` writes only plugin-created lines with a safe line-based writer and leaves your own text untouched. Resolving debt or a reminder with `hw_memory_debt` / `hw_memory_reminder` removes it from the open list; its doc line is removed on the next `/hw-docs --apply`.

### Open items: debt and reminders

Debt and reminders never decay away on their own, so they are tracked with a disposition instead of a lifetime. **Debt is a knowingly accepted cost that grows while it stays open** — in code (a workaround, a missing test, an API mismatch), in management (manual reconciliation, one metric defined differently in two reports, a step only one person can run) and in research (a dataset without provenance or version, an unreproducible analysis, a stale source). A reminder is work that only needs doing. If ignoring it gets more expensive, it is debt; if it only needs doing, it is a reminder. Two actions dispose of them:

- `action: verify` records that the item was checked and is still open. Only the check date moves — weight and the decay clock are untouched, so re-verifying cannot keep an item alive forever.
- `action: resolve` marks it done. It leaves every list and its managed-doc line is removed on the next `/hw-docs --apply`.

Lists (`hw_memory_debt`, `hw_memory_reminder`, `/hw-debts`, `/hw-reminders`) show age as `open 41d, checked 18d ago`, and the wake-up context surfaces only the items that resemble the current task. When a task ends with a completion phrase ("done", "готово"), a bounded check names at most five undispositioned ids; a background pass covers items unchecked for a week or more. Each item is repeated at most once a day, and anything checked today is not repeated at all.

### Changelog

`/hw-changes [version]` produces a readable list of changes from git history (`[tag]..HEAD`) or recorded journal events. `--export` writes it to `docs/hw-memory/changelog.md`.

### Retention

Facts lose weight with age and infrequent use, but important ones are kept: nothing `critical` is dropped, `high` items are protected until marked obsolete, and `debt`, `reminder` and `changelog` are never pruned or capped. `medium` decisions and gotchas are only pruned after you approve them; `low` ephemera is cleaned up quietly.

### Development

```sh
npm install
npm test              # node --test, 103 tests
npm run test:install  # installer checks
npm run test:update   # updater checks
npm run build         # rebuild plugin/hw-memory.ts
npm run typecheck
```
