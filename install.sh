#!/bin/sh
set -eu

ENTRY="./plugins/lib/usage-tui.ts"

usage() {
  cat <<EOF
Usage: install.sh [--global | --local]

Install the opencode usage-counter plugins (server tracker + /usage TUI command).

  --global   install to \${XDG_CONFIG_HOME:-\$HOME/.config}/opencode (default)
  --local    install into ./.opencode of the current directory
  -h, --help show this help

Run this script from the repository root (or anywhere inside it).
EOF
}

SCOPE="global"
while [ $# -gt 0 ]; do
  case "$1" in
    --global|-g) SCOPE="global" ;;
    --local|-l) SCOPE="local" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install.sh: unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_PLUGINS="$SCRIPT_DIR/.opencode/plugins"
SRC_TUI="$SCRIPT_DIR/.opencode/tui.json"

if [ ! -f "$SRC_PLUGINS/usage-tracker.ts" ] || [ ! -f "$SRC_TUI" ]; then
  printf 'install.sh: cannot find .opencode/plugins and .opencode/tui.json next to the script.\n' >&2
  printf 'Run this script from the repository checkout.\n' >&2
  exit 1
fi

case "$SCOPE" in
  global) TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ;;
  local)  TARGET="$PWD/.opencode" ;;
esac

printf 'Installing usage-counter plugins (%s)\n' "$SCOPE"
printf '  from: %s\n' "$SCRIPT_DIR/.opencode"
printf '  to:   %s\n' "$TARGET"

mkdir -p "$TARGET/plugins"
cp -R "$SRC_PLUGINS/." "$TARGET/plugins/"

TUI="$TARGET/tui.json"
TMP="$TUI.tmp.$$"
trap 'rm -f "$TMP"' EXIT
trap 'rm -f "$TMP"; exit 1' INT TERM

fail_merge() {
  printf '\nWARNING: could not update %s automatically.\n' "$TUI"
  printf 'Add the TUI plugin declaration manually:\n\n  "plugin": ["%s"]\n\n' "$ENTRY"
  exit 1
}

if [ ! -f "$TUI" ]; then
  cp "$SRC_TUI" "$TUI"
elif grep -q "usage-tui" "$TUI"; then
  printf 'tui.json already declares the TUI plugin.\n'
elif grep -Eq '"plugin"[[:space:]]*:' "$TUI"; then
  sed 's|\("plugin"[[:space:]]*:[[:space:]]*\)\[|\1["'"$ENTRY"'", |' "$TUI" > "$TMP"
  if grep -q "usage-tui" "$TMP"; then
    mv "$TMP" "$TUI"
  else
    fail_merge
  fi
elif head -c 1 "$TUI" | grep -q '{'; then
  awk -v ins="  \"plugin\": [\"$ENTRY\"]," '
    NR == 1 && substr($0, 1, 1) == "{" {
      print "{"
      print ins
      rest = substr($0, 2)
      if (rest != "") print rest
      next
    }
    { print }
  ' "$TUI" > "$TMP"
  if grep -q "usage-tui" "$TMP"; then
    mv "$TMP" "$TUI"
  else
    fail_merge
  fi
else
  fail_merge
fi

printf 'Done. Restart OpenCode; the server plugin backfills history for this folder on first launch.\n'
