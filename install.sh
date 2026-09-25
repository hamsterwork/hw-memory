#!/usr/bin/env bash
# hw-memory installer.
#
# Local clone:
#   ./install.sh [target-dir]          install into a project
#   ./install.sh --global              install once for all projects
#
# Remote (downloads a release, verifies SHA256 against SHA256SUMS):
#   curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --global
#   curl -fsSL .../install.sh | bash -s -- --version v0.1.0
set -euo pipefail

REPO="hamsterwork/hw-memory"
RELEASES="https://github.com/${REPO}/releases"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"

MARKER_START='<!-- hw-memory:start -->'
MARKER_END='<!-- hw-memory:end -->'

PLUGIN_ASSET="hw-memory.ts"
RULES_ASSET="hw-memory.md"
SUMS_ASSET="SHA256SUMS"

log() { printf '%s\n' "$*"; }
die() {
  printf 'hw-memory: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
hw-memory installer

Usage:
  ./install.sh [target-dir] [options]        install the plugin into a project
  ./install.sh --global [options]            install once for all projects
  curl -fsSL ${RAW_BASE}/install.sh | bash  download and verify the latest release

Options:
  -g, --global            Install into ~/.config/opencode (all projects).
      --version <vX.Y.Z>  Install a pinned release (remote mode only).
      --base-url <url>    Fetch release assets from a custom base (remote mode).
      --no-rules          Install the plugin only, skip the usage rules in AGENTS.md.
  -h, --help              Show this help.

Environment:
  HWM_VERSION   Same as --version.
  HWM_BASE_URL  Same as --base-url.
  HWM_SHA256    If set, additionally require ${PLUGIN_ASSET} to match this SHA256.
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
GLOBAL=0
WRITE_RULES=1
TARGET=""
VERSION="${HWM_VERSION:-}"
BASE_URL_OVERRIDE="${HWM_BASE_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    -g | --global) GLOBAL=1 ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION="$2"
      shift
      ;;
    --version=*) VERSION="${1#*=}" ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url needs a value"
      BASE_URL_OVERRIDE="$2"
      shift
      ;;
    --base-url=*) BASE_URL_OVERRIDE="${1#*=}" ;;
    --no-rules) WRITE_RULES=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$TARGET" ] || die "unexpected extra argument: $1"
      TARGET="$1"
      ;;
  esac
  shift
done

[ "$GLOBAL" = 1 ] && [ -n "$TARGET" ] && die "cannot combine --global with a target directory"

# ---------------------------------------------------------------------------
# Source mode: local clone (files next to this script) or remote (release)
# ---------------------------------------------------------------------------
script_path=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

TMPDIR_HWM=""
cleanup() {
  if [ -n "$TMPDIR_HWM" ]; then rm -rf "$TMPDIR_HWM"; fi
}
trap cleanup EXIT

PLUGIN_SRC=""
RULES_SRC=""

if [ -n "$script_path" ] && [ -f "$script_path/plugin/$PLUGIN_ASSET" ]; then
  PLUGIN_SRC="$script_path/plugin/$PLUGIN_ASSET"
  [ -f "$script_path/plugin/$RULES_ASSET" ] && RULES_SRC="$script_path/plugin/$RULES_ASSET"
  log "Source: local clone ($script_path)"
else
  [ -n "$BASE_URL_OVERRIDE" ] || command -v curl >/dev/null 2>&1 || die "curl is required for remote install"

  if [ -n "$BASE_URL_OVERRIDE" ]; then
    BASE="${BASE_URL_OVERRIDE%/}"
  elif [ -n "$VERSION" ]; then
    BASE="$RELEASES/download/$VERSION"
  else
    BASE="$RELEASES/latest/download"
  fi
  log "Source: remote ($BASE)"

  TMPDIR_HWM="$(mktemp -d)"
  fetch() { # url dest
    case "$1" in
      file://*) cp "${1#file://}" "$2" || die "cannot copy $1" ;;
      /*) cp "$1" "$2" || die "cannot copy $1" ;;
      *) curl -fsSL "$1" -o "$2" || die "download failed: $1" ;;
    esac
  }
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$1" | awk '{print $1}'
    else
      die "neither sha256sum nor shasum is available"
    fi
  }
  verify_asset() { # name file sumsfile
    expected="$(awk -v f="$1" '{n=$2; sub(/^\*/, "", n); if (n==f) {print $1; exit}}' "$3")"
    [ -n "$expected" ] || die "no checksum for $1 in $SUMS_ASSET"
    actual="$(sha256_of "$2")"
    [ "$actual" = "$expected" ] || die "checksum mismatch for $1 (expected $expected, got $actual)"
    log "  verified $1 ($actual)"
  }

  PLUGIN_SRC="$TMPDIR_HWM/$PLUGIN_ASSET"
  fetch "$BASE/$PLUGIN_ASSET" "$PLUGIN_SRC"
  if [ "$WRITE_RULES" = 1 ]; then
    RULES_SRC="$TMPDIR_HWM/$RULES_ASSET"
    fetch "$BASE/$RULES_ASSET" "$RULES_SRC"
  fi

  SUMS="$TMPDIR_HWM/$SUMS_ASSET"
  fetch "$BASE/$SUMS_ASSET" "$SUMS"
  verify_asset "$PLUGIN_ASSET" "$PLUGIN_SRC" "$SUMS"
  [ -n "$RULES_SRC" ] && verify_asset "$RULES_ASSET" "$RULES_SRC" "$SUMS"

  if [ -n "${HWM_SHA256:-}" ]; then
    actual="$(sha256_of "$PLUGIN_SRC")"
    [ "$actual" = "$HWM_SHA256" ] || die "HWM_SHA256 mismatch (expected $HWM_SHA256, got $actual)"
    log "  verified HWM_SHA256 pin"
  fi
fi

[ -n "$PLUGIN_SRC" ] || die "plugin asset not found"

# ---------------------------------------------------------------------------
# Resolve install locations
# ---------------------------------------------------------------------------
if [ "$GLOBAL" = 1 ]; then
  config_dir="$HOME/.config/opencode"
  plugin_dir="$config_dir/plugins"
  rules_file="$config_dir/AGENTS.md"
  if [ ! -f "$rules_file" ] && [ -f "$HOME/.claude/CLAUDE.md" ]; then
    rules_file="$HOME/.claude/CLAUDE.md"
  fi
  scope="global ($config_dir)"
else
  target="${TARGET:-.}"
  [ -d "$target" ] || die "target directory does not exist: $target"
  target="$(cd "$target" && pwd)"
  plugin_dir="$target/.opencode/plugins"
  rules_file="$target/AGENTS.md"
  if [ ! -f "$rules_file" ] && [ -f "$target/CLAUDE.md" ]; then
    rules_file="$target/CLAUDE.md"
  fi
  scope="project ($target)"
fi

# ---------------------------------------------------------------------------
# Install plugin
# ---------------------------------------------------------------------------
mkdir -p "$plugin_dir"
cp "$PLUGIN_SRC" "$plugin_dir/hw-memory.ts"

if [ "$GLOBAL" = 0 ] && [ -d "$target/.git" ]; then
  gitignore="$target/.gitignore"
  touch "$gitignore"
  for line in ".opencode/hw-memory.db" ".opencode/hw-memory.db-wal" ".opencode/hw-memory.db-shm"; do
    grep -qxF "$line" "$gitignore" || printf '%s\n' "$line" >>"$gitignore"
  done
fi

# ---------------------------------------------------------------------------
# Install rules into the file opencode actually reads (AGENTS.md / CLAUDE.md)
# ---------------------------------------------------------------------------
upsert_block() { # file blockfile
  file="$1"
  block="$2"
  base="$(mktemp)"
  if [ -f "$file" ]; then
    awk -v s="$MARKER_START" -v e="$MARKER_END" '
      $0==s {skip=1; next}
      $0==e {skip=0; next}
      !skip {print}
    ' "$file" >"$base"
  fi
  out="$(mktemp)"
  awk 'BEGIN{n=0} {a[n++]=$0} END{last=n; while(last>0 && a[last-1]=="") last--; for(i=0;i<last;i++) print a[i]}' "$base" >"$out"
  [ -s "$out" ] && printf '\n' >>"$out"
  cat "$block" >>"$out"
  mv "$out" "$file"
  rm -f "$base"
}

rules_written=0
if [ "$WRITE_RULES" = 1 ] && [ -n "$RULES_SRC" ]; then
  block="$(mktemp)"
  {
    printf '%s\n' "$MARKER_START"
    cat "$RULES_SRC"
    if [ -s "$RULES_SRC" ] && [ -n "$(tail -c 1 "$RULES_SRC")" ]; then printf '\n'; fi
    printf '%s\n' "$MARKER_END"
  } >"$block"
  upsert_block "$rules_file" "$block"
  rm -f "$block"
  rules_written=1
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
log ""
log "hw-memory installed — $scope"
log "  plugin: $plugin_dir/hw-memory.ts"
if [ "$rules_written" = 1 ]; then
  log "  rules:  $rules_file${rules_file##*/}"
fi
if [ "$GLOBAL" = 0 ] && [ -d "$target/.memory" ]; then
  log ""
  log "Legacy .memory/ detected. After restarting opencode, ask the agent:"
  log "  'run hw_memory_migrate' (dry-run first, then apply)"
fi
log ""
log "Restart opencode to activate."
