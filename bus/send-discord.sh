#!/usr/bin/env bash
# send-discord.sh — post a message to the Discord orchestrator channel.
# Usage:
#   bus/send-discord.sh <channel> "<text>" [--reply-to <message_id>]
# If <channel> is "-" or empty, DISCORD_ORCH_CHANNEL_ID is used (orchestrator
# scope). Mirrors bus/send-slack.sh: delegate to the CLI so normalization +
# payload construction live in one place (TypeScript), not duplicated in bash.
# Requires DISCORD_BOT_TOKEN in env (and DISCORD_ORCH_CHANNEL_ID when channel
# is omitted).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${CTX_FRAMEWORK_ROOT:-${SCRIPT_DIR}/..}/dist/cli.js"

CHANNEL="${1:?usage: send-discord.sh <channel> <text> [--reply-to <id>]}"
TEXT="${2:?usage: send-discord.sh <channel> <text> [--reply-to <id>]}"
shift 2 || true

# Treat "-" as "use the configured orchestrator channel".
if [[ "$CHANNEL" == "-" ]]; then
    exec node "$CLI" discord test-send "$TEXT" "$@"
fi

exec node "$CLI" discord test-send "$CHANNEL" "$TEXT" "$@"
