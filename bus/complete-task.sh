#!/usr/bin/env bash
# complete-task.sh — wrapper for Node.js CLI
# Usage: complete-task.sh <id> [result_summary]
#    or: complete-task.sh <id> --result "<text>"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"

if [[ -z "$ID" ]]; then
  echo "Usage: complete-task.sh <id> [result_summary]" >&2
  echo "   or: complete-task.sh <id> --result \"<text>\"" >&2
  exit 1
fi
shift

# Forward everything after the ID as-is (positional result_summary OR
# --result "<text>") — the CLI itself already accepts both forms. This
# script used to only read $2 as a bare positional value, so a caller
# using `--result "<text>"` (the flag form every bootstrap doc teaches)
# got $2="--result" and the real text silently dropped in $3, storing
# the literal string "--result" as the completion result instead.
exec node "$CLI" bus complete-task "$ID" "$@"
