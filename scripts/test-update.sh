#!/usr/bin/env bash
# Tests for update.sh: version detection, no-op when current, --check exit code,
# verified update with backup, and checksum mismatch failing closed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
updater="$repo_root/update.sh"
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

plugin_version() { grep -m1 -oE 'hw-memory v[0-9]+\.[0-9]+\.[0-9]+' "$1" | sed 's/^hw-memory v//'; }

# --- fixtures ---------------------------------------------------------------
current_ver="$(plugin_version "$plugin")"
[ -n "$current_ver" ] || {
  printf 'FATAL: %s has no version banner — run npm run build\n' "$plugin" >&2
  exit 1
}

release="$work/release"
mkdir -p "$release"
cp "$plugin" "$release/hw-memory.ts"
cp "$rules" "$release/hw-memory.md"
(
  cd "$release"
  printf '%s  hw-memory.ts\n%s  hw-memory.md\n' "$(sha256_of hw-memory.ts)" "$(sha256_of hw-memory.md)" >SHA256SUMS
)

old_plugin() { # dir
  local dir="$1"
  mkdir -p "$dir/.opencode/plugins"
  {
    printf '// hw-memory v0.1.0\n'
    printf 'export default function () {}\n'
  } >"$dir/.opencode/plugins/hw-memory.ts"
}

tag="v$current_ver"

# --- 1. update an old project install --------------------------------------
proj="$work/proj"
mkdir -p "$proj"
old_plugin "$proj"
printf '# Project\n\n- keep me\n' >"$proj/AGENTS.md"
if bash "$updater" "$proj" --version "$tag" --base-url "$release" --yes >/dev/null 2>&1; then
  ok "update: verified install succeeded"
else
  no "update: verified install succeeded"
fi
check "update: plugin replaced" test "$(plugin_version "$proj/.opencode/plugins/hw-memory.ts")" = "$current_ver"
check "update: backup kept old version" test "$(plugin_version "$proj/.opencode/plugins/hw-memory.ts.bak")" = "0.1.0"
check "update: existing content preserved" grep -qF 'keep me' "$proj/AGENTS.md"
check "update: rules block present" test "$(marker_count "$proj/AGENTS.md")" = 1
check "update: rules content present" grep -qF 'hw_memory_seed' "$proj/AGENTS.md"

# --- 2. no-op when already current -----------------------------------------
out="$(bash "$updater" "$proj" --version "$tag" --base-url "$release" --yes 2>&1)"
check "current: reports up to date" grep -qi 'already up to date' <<<"$out"
check "current: no second backup" test ! -f "$proj/.opencode/plugins/hw-memory.ts.bak.1"

# --- 3. --check exit codes --------------------------------------------------
if bash "$updater" "$proj" --version "$tag" --base-url "$release" --check >/dev/null 2>&1; then
  ok "check: current exits 0"
else
  no "check: current exits 0"
fi
old_plugin "$proj"
if bash "$updater" "$proj" --version "$tag" --base-url "$release" --check >/dev/null 2>&1; then
  no "check: outdated exits non-zero"
else
  ok "check: outdated exits non-zero"
fi

# --- 4. global install ------------------------------------------------------
HOME_FAKE="$work/home"
mkdir -p "$HOME_FAKE/.config/opencode/plugins"
old_plugin "$HOME_FAKE/.config/opencode" 2>/dev/null || true
{
  printf '// hw-memory v0.1.0\n'
  printf 'export default function () {}\n'
} >"$HOME_FAKE/.config/opencode/plugins/hw-memory.ts"
if HOME="$HOME_FAKE" bash "$updater" --global --version "$tag" --base-url "$release" --yes >/dev/null 2>&1; then
  ok "global: update succeeded"
else
  no "global: update succeeded"
fi
check "global: plugin replaced" test "$(plugin_version "$HOME_FAKE/.config/opencode/plugins/hw-memory.ts")" = "$current_ver"
check "global: rules written" test -f "$HOME_FAKE/.config/opencode/AGENTS.md"

# --- 5. checksum mismatch fails closed --------------------------------------
bad="$work/bad"
mkdir -p "$bad"
cp "$plugin" "$bad/hw-memory.ts"
cp "$rules" "$bad/hw-memory.md"
printf '0000000000000000000000000000000000000000000000000000000000000000  hw-memory.ts\n%s  hw-memory.md\n' \
  "$(sha256_of "$bad/hw-memory.md")" >"$bad/SHA256SUMS"
bad_proj="$work/bad-proj"
old_plugin "$bad_proj"
if bash "$updater" "$bad_proj" --version "$tag" --base-url "$bad" --yes >/dev/null 2>&1; then
  no "checksum: mismatch aborts"
else
  ok "checksum: mismatch aborts"
fi
check "checksum: plugin left unchanged" test "$(plugin_version "$bad_proj/.opencode/plugins/hw-memory.ts")" = "0.1.0"

# --- 6. --base-url without --version is rejected ----------------------------
if bash "$updater" "$proj" --base-url "$release" --yes >/dev/null 2>&1; then
  no "base-url: requires --version"
else
  ok "base-url: requires --version"
fi

# --- 7. missing install is rejected -----------------------------------------
empty="$work/empty"
mkdir -p "$empty"
if bash "$updater" "$empty" --version "$tag" --base-url "$release" --yes >/dev/null 2>&1; then
  no "missing: no plugin aborts"
else
  ok "missing: no plugin aborts"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
