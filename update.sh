#!/usr/bin/env bash
# hw-memory updater.
#
# Reports the installed plugin version and updates it from GitHub on request.
#
# Local clone:
#   ./update.sh [target-dir]          update a project install
#   ./update.sh --global              update the global install
#
# Remote (downloads and verifies the release assets):
#   curl -fsSL https://raw.githubusercontent.com/hamsterwork/hw-memory/main/update.sh | bash
#   curl -fsSL .../update.sh | bash -s -- --global
#   curl -fsSL .../update.sh | bash -s -- --check
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
hw-memory updater

Usage:
  ./update.sh [target-dir] [options]        update a project install
  ./update.sh --global [options]            update the global install
  curl -fsSL ${RAW_BASE}/update.sh | bash  check and update the latest release

Options:
  -g, --global            Update the install in ~/.config/opencode.
  -y, --yes               Apply the update without prompting.
  -c, --check             Only report installed vs latest version; make no changes.
      --version <vX.Y.Z>  Target a specific release (default: latest).
      --base-url <url>    Fetch release assets from a custom base.
      --no-rules          Update the plugin only, skip the usage rules in AGENTS.md.
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
ASSUME_YES=0
CHECK_ONLY=0
WRITE_RULES=1
TARGET=""
VERSION="${HWM_VERSION:-}"
BASE_URL_OVERRIDE="${HWM_BASE_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    -g | --global) GLOBAL=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -c | --check) CHECK_ONLY=1 ;;
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
# Resolve install locations (mirrors install.sh)
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

PLUGIN_DST="$plugin_dir/hw-memory.ts"
[ -f "$PLUGIN_DST" ] || die "no hw-memory plugin at $PLUGIN_DST — run install.sh first"

installed_version() { # file -> X.Y.Z or empty
  grep -m1 -oE 'hw-memory v[0-9]+\.[0-9]+\.[0-9]+[-.+0-9A-Za-z]*' "$1" 2>/dev/null | sed 's/^hw-memory v//' || true
}

CURRENT="$(installed_version "$PLUGIN_DST")"

# ---------------------------------------------------------------------------
# Resolve the target release
# ---------------------------------------------------------------------------
curl_required() { command -v curl >/dev/null 2>&1 || die "curl is required to check for updates"; }

latest_tag() {
  curl_required
  local loc
  loc="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES/latest")" ||
    die "cannot reach $RELEASES/latest"
  case "$loc" in
    */releases/tag/*) printf '%s\n' "${loc##*/releases/tag/}" ;;
    *) die "could not determine the latest release from '$loc'" ;;
  esac
}

if [ -n "$VERSION" ]; then
  TARGET_TAG="$VERSION"
elif [ -n "$BASE_URL_OVERRIDE" ]; then
  die "--base-url needs --version (cannot discover the latest release off GitHub)"
else
  TARGET_TAG="$(latest_tag)"
fi
TARGET_VER="${TARGET_TAG#v}"

log "hw-memory updater — $scope"
if [ -n "$CURRENT" ]; then
  log "  installed: v$CURRENT ($PLUGIN_DST)"
else
  log "  installed: unknown ($PLUGIN_DST — no version marker)"
fi
log "  target:    $TARGET_TAG"

if [ -n "$CURRENT" ] && [ "$CURRENT" = "$TARGET_VER" ]; then
  log ""
  log "Already up to date."
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  log ""
  log "Update available: ${CURRENT:+v$CURRENT -> }$TARGET_TAG"
  exit 1
fi

# ---------------------------------------------------------------------------
# Prompt (reads the terminal, so it still works when piped through bash)
# ---------------------------------------------------------------------------
confirm() { # message
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -r /dev/tty ] || die "cannot prompt (no terminal) — re-run with --yes"
  printf '%s [y/N] ' "$1" >/dev/tty
  local ans=""
  read -r ans </dev/tty || ans=""
  case "$ans" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

if ! confirm "Update hw-memory to $TARGET_TAG?"; then
  log "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Download and verify the release assets
# ---------------------------------------------------------------------------
TMPDIR_HWM="$(mktemp -d)"
cleanup() {
  if [ -n "$TMPDIR_HWM" ]; then rm -rf "$TMPDIR_HWM"; fi
}
trap cleanup EXIT

if [ -n "$BASE_URL_OVERRIDE" ]; then
  BASE="${BASE_URL_OVERRIDE%/}"
else
  BASE="$RELEASES/download/$TARGET_TAG"
fi

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
  local expected actual
  expected="$(awk -v f="$1" '{n=$2; sub(/^\*/, "", n); if (n==f) {print $1; exit}}' "$3")"
  [ -n "$expected" ] || die "no checksum for $1 in $SUMS_ASSET"
  actual="$(sha256_of "$2")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $1 (expected $expected, got $actual)"
  log "  verified $1 ($actual)"
}

PLUGIN_SRC="$TMPDIR_HWM/$PLUGIN_ASSET"
RULES_SRC=""
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

# ---------------------------------------------------------------------------
# Install (back up the current plugin first)
# ---------------------------------------------------------------------------
NEW="$(installed_version "$PLUGIN_SRC")"
[ -n "$NEW" ] || die "downloaded $PLUGIN_ASSET has no version marker — refusing to install"

mkdir -p "$plugin_dir"
cp "$PLUGIN_DST" "$PLUGIN_DST.bak"
cp "$PLUGIN_SRC" "$PLUGIN_DST"

upsert_block() { # file blockfile
  local file="$1" block="$2" base out
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
log "hw-memory updated — $scope"
if [ -n "$CURRENT" ]; then
  log "  version: v$CURRENT -> v$NEW (backup: $PLUGIN_DST.bak)"
else
  log "  version: unknown -> v$NEW (backup: $PLUGIN_DST.bak)"
fi
[ "$rules_written" = 1 ] && log "  rules:   $rules_file"
log ""
log "Restart opencode to activate."
