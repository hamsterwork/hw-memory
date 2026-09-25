#!/usr/bin/env bash
# Tests for install.sh: project/global modes, AGENTS.md/CLAUDE.md rules,
# idempotency, and remote SHA256 verification (required + mismatch abort).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo_root/install.sh"
plugin="$repo_root/plugin/hw-memory.ts"
rules="$repo_root/plugin/hw-memory.md"
marker_start='<!-- hw-memory:start -->'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
no() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1" >&2
}
check() { # desc cmd...
  local desc="$1"
  shift
  if "$@"; then
    ok "$desc"
  else
    no "$desc"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

marker_count() { grep -cF "$marker_start" "$1" 2>/dev/null || true; }

# --- 1. project install -----------------------------------------------------
proj="$work/proj"
mkdir -p "$proj" && git -C "$proj" init -q
bash "$installer" "$proj" >/dev/null
check "project: plugin installed" test -f "$proj/.opencode/plugins/hw-memory.ts"
check "project: AGENTS.md created" test -f "$proj/AGENTS.md"
check "project: one marker block" test "$(marker_count "$proj/AGENTS.md")" = 1
check "project: rules content present" grep -qF 'hw_memory_seed' "$proj/AGENTS.md"
check "project: WAL gitignored" grep -qxF '.opencode/hw-memory.db-wal' "$proj/.gitignore"
check "project: SHM gitignored" grep -qxF '.opencode/hw-memory.db-shm' "$proj/.gitignore"

# --- 2. idempotency ---------------------------------------------------------
bash "$installer" "$proj" >/dev/null
check "idempotent: still one marker block" test "$(marker_count "$proj/AGENTS.md")" = 1

# --- 3. CLAUDE.md fallback (no shadowing) -----------------------------------
claude="$work/claude-proj"
mkdir -p "$claude"
printf '# Project\n\n- keep me\n' >"$claude/CLAUDE.md"
bash "$installer" "$claude" >/dev/null
check "claude: no AGENTS.md created" test ! -f "$claude/AGENTS.md"
check "claude: existing content preserved" grep -qF 'keep me' "$claude/CLAUDE.md"
check "claude: rules appended" test "$(marker_count "$claude/CLAUDE.md")" = 1

# --- 4. global install ------------------------------------------------------
HOME_FAKE="$work/home"
mkdir -p "$HOME_FAKE"
HOME="$HOME_FAKE" bash "$installer" --global >/dev/null
check "global: plugin installed" test -f "$HOME_FAKE/.config/opencode/plugins/hw-memory.ts"
check "global: AGENTS.md created" test -f "$HOME_FAKE/.config/opencode/AGENTS.md"

# --- 5. remote install with checksum verification ---------------------------
release="$work/release"
mkdir -p "$release"
cp "$plugin" "$release/hw-memory.ts"
cp "$rules" "$release/hw-memory.md"
(
  cd "$release"
  printf '%s  hw-memory.ts\n%s  hw-memory.md\n' "$(sha256_of hw-memory.ts)" "$(sha256_of hw-memory.md)" >SHA256SUMS
)
standalone="$work/standalone.sh"
cp "$installer" "$standalone"
remote_proj="$work/remote-proj"
mkdir -p "$remote_proj"
if HWM_BASE_URL="$release" bash "$standalone" "$remote_proj" >/dev/null 2>&1; then
  ok "remote: verified install succeeded"
else
  no "remote: verified install succeeded"
fi
check "remote: plugin installed" test -f "$remote_proj/.opencode/plugins/hw-memory.ts"

# --- 6. checksum mismatch must fail closed ----------------------------------
bad="$work/bad-release"
mkdir -p "$bad"
cp "$plugin" "$bad/hw-memory.ts"
cp "$rules" "$bad/hw-memory.md"
printf '0000000000000000000000000000000000000000000000000000000000000000  hw-memory.ts\n%s  hw-memory.md\n' "$(sha256_of "$bad/hw-memory.md")" >"$bad/SHA256SUMS"
bad_proj="$work/bad-proj"
mkdir -p "$bad_proj"
if HWM_BASE_URL="$bad" bash "$standalone" "$bad_proj" >/dev/null 2>&1; then
  no "checksum: mismatch aborts"
else
  ok "checksum: mismatch aborts"
fi
check "checksum: nothing installed on failure" test ! -f "$bad_proj/.opencode/plugins/hw-memory.ts"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
