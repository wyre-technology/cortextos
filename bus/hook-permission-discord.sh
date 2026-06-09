#!/usr/bin/env bash
# hook-permission-discord.sh - Blocking PermissionRequest hook (orchestrator-scoped)
# Mirrors bus/hook-permission-telegram.sh: forwards permission prompts to the
# Discord orchestrator channel, then polls for a response file written when the
# user approves/denies. Timeout: 1800s (30 min, deny by default).
#
# Response-file mechanism is adapter-agnostic: a Discord interaction handler
# (gateway button/slash response -> hook-response-<id>.json) is the deferred
# inbound-parity piece, mirroring how Telegram's fast-checker writes these
# files on inline-button taps. Until that lands the hook degrades safely:
# posts the request, and on timeout auto-denies (same as Telegram).

set -euo pipefail

# Read stdin FIRST before anything that might consume it
INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true
TEMPLATE_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT="${CTX_AGENT_NAME:-$(basename "$(pwd)")}"

# Source .env for DISCORD_BOT_TOKEN and DISCORD_ORCH_CHANNEL_ID
ENV_FILE="${CTX_AGENT_DIR:-.}/.env"
{ set +x; } 2>/dev/null
if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
elif [[ -f ".env" ]]; then
    set -a; source ".env"; set +a
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]] || [[ -z "${DISCORD_ORCH_CHANNEL_ID:-}" ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"No Discord credentials configured for remote approval"}}}'
    exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

# ExitPlanMode/AskUserQuestion handled by their own hooks - skip here
if [[ "$TOOL_NAME" == "ExitPlanMode" || "$TOOL_NAME" == "AskUserQuestion" ]]; then
    exit 0
fi

# Auto-approve edits to the agent's OWN .claude/ directory (precise path
# containment — NOT substring). Bash is never auto-approved. Mirrors
# hook-permission-telegram.sh.
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
    if [[ -n "$FILE_PATH" && -n "${CTX_AGENT_DIR:-}" ]] && realpath -m / >/dev/null 2>&1; then
        AGENT_DIR="$CTX_AGENT_DIR"
        if [[ ! -L "${AGENT_DIR}/.claude" ]]; then
            CLAUDE_ROOT="$(realpath -m "${AGENT_DIR}/.claude")"
            case "$FILE_PATH" in
                /*) ABS_PATH="$FILE_PATH" ;;
                *)  ABS_PATH="${AGENT_DIR}/${FILE_PATH}" ;;
            esac
            RESOLVED="$(realpath -m "$ABS_PATH")"
            if [[ "$RESOLVED" == "$CLAUDE_ROOT" || "$RESOLVED" == "$CLAUDE_ROOT/"* ]]; then
                echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
                exit 0
            fi
        fi
    fi
fi

# Build a human-readable summary
case "$TOOL_NAME" in
    Edit)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"' 2>/dev/null)
        OLD_STR=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""' 2>/dev/null | head -c 300)
        NEW_STR=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""' 2>/dev/null | head -c 300)
        TOOL_SUMMARY="File: ${FILE_PATH}

- ${OLD_STR}
+ ${NEW_STR}"
        ;;
    Write)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"' 2>/dev/null)
        CONTENT_PREVIEW=$(echo "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null | head -c 300)
        TOOL_SUMMARY="File: ${FILE_PATH}

${CONTENT_PREVIEW}"
        ;;
    Bash)
        CMD_FULL=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
        CMD=$(printf '%s' "$CMD_FULL" | head -c 1500)
        if [[ ${#CMD_FULL} -gt ${#CMD} ]]; then
            TOOL_SUMMARY="Command: ${CMD}
…(preview truncated — the FULL command, not just this preview, runs if you approve)"
        else
            TOOL_SUMMARY="Command: ${CMD}"
        fi
        ;;
    *)
        TOOL_SUMMARY=$(echo "$INPUT" | jq -r '.tool_input // {}' 2>/dev/null | jq -c '.' 2>/dev/null | head -c 200)
        ;;
esac

# Generate unique ID for this request
UNIQUE_ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
HOOK_STATE_DIR="${CTX_ROOT:-${HOME}/.cortextos/default}/state/${AGENT}"
mkdir -p "${HOOK_STATE_DIR}"
RESPONSE_FILE="${HOOK_STATE_DIR}/hook-response-${UNIQUE_ID}.json"

cleanup() {
    rm -f "$RESPONSE_FILE"
}
trap cleanup EXIT

MESSAGE="PERMISSION REQUEST
Agent: ${AGENT}
Tool: ${TOOL_NAME}
ID: ${UNIQUE_ID}

\`\`\`
${TOOL_SUMMARY}
\`\`\`

Reply 'approve ${UNIQUE_ID}' or 'deny ${UNIQUE_ID}'."

# Discord's hard message limit is 2000 chars.
if [[ ${#MESSAGE} -gt 1900 ]]; then
    MESSAGE="${MESSAGE:0:1900}...(truncated)"
fi

bash "${TEMPLATE_ROOT}/bus/send-discord.sh" "${DISCORD_ORCH_CHANNEL_ID}" "${MESSAGE}" > /dev/null 2>&1 || {
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Failed to send permission request to Discord"}}}'
    exit 0
}

# Poll for response file (written by the Discord interaction handler)
ELAPSED=0
TIMEOUT=1800
POLL_INTERVAL=2

while [[ $ELAPSED -lt $TIMEOUT ]]; do
    if [[ -f "$RESPONSE_FILE" ]]; then
        DECISION=$(jq -r '.decision // "deny"' "$RESPONSE_FILE" 2>/dev/null || echo "deny")
        if [[ "$DECISION" == "allow" ]]; then
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        else
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by user via Discord"}}}'
        fi
        exit 0
    fi
    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Timeout - deny and notify
bash "${TEMPLATE_ROOT}/bus/send-discord.sh" "${DISCORD_ORCH_CHANNEL_ID}" "Permission request TIMED OUT (auto-denied): ${TOOL_NAME}" > /dev/null 2>&1 || true

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Timed out waiting for Discord approval (30m)"}}}'
