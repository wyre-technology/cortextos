#!/usr/bin/env bash
# hook-planmode-discord.sh - ExitPlanMode PermissionRequest hook (orchestrator-scoped)
# Mirrors bus/hook-planmode-telegram.sh: reads the plan file, posts it to the
# Discord orchestrator channel, and polls for an approve/deny response file.
# Approve = allow (agent executes the plan). Deny = deny.
# Timeout: 1800s (30 min), auto-APPROVES so agents aren't blocked if user is away.
#
# The Discord interaction handler that writes hook-response-<id>.json on a
# button/reply is the deferred inbound-parity piece (mirrors Telegram's
# fast-checker). Until it lands, this hook degrades safely: posts the plan and
# auto-approves on timeout.

set -euo pipefail

INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true
TEMPLATE_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT="${CTX_AGENT_NAME:-$(basename "$(pwd)")}"

ENV_FILE="${CTX_AGENT_DIR:-.}/.env"
{ set +x; } 2>/dev/null
if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
elif [[ -f ".env" ]]; then
    set -a; source ".env"; set +a
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]] || [[ -z "${DISCORD_ORCH_CHANNEL_ID:-}" ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# Find the plan file
PLAN_PATH=$(echo "$INPUT" | jq -r '.tool_input.plan_file // empty' 2>/dev/null)
if [[ -z "$PLAN_PATH" ]]; then
    PLAN_PATH=$(ls -t ~/.claude/plans/*.md 2>/dev/null | head -1)
fi

PLAN_CONTENT=""
if [[ -n "$PLAN_PATH" ]] && [[ -f "$PLAN_PATH" ]]; then
    PLAN_CONTENT=$(head -100 "$PLAN_PATH" 2>/dev/null)
fi
if [[ -z "$PLAN_CONTENT" ]]; then
    PLAN_CONTENT="(Plan file not found or empty)"
fi

UNIQUE_ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
HOOK_STATE_DIR="${CTX_ROOT:-${HOME}/.cortextos/default}/state/${AGENT}"
mkdir -p "${HOOK_STATE_DIR}"
RESPONSE_FILE="${HOOK_STATE_DIR}/hook-response-${UNIQUE_ID}.json"

cleanup() {
    rm -f "$RESPONSE_FILE"
}
trap cleanup EXIT

# Discord's hard message limit is 2000 chars; leave room for the wrapper.
if [[ ${#PLAN_CONTENT} -gt 1700 ]]; then
    PLAN_CONTENT="${PLAN_CONTENT:0:1700}...(truncated)"
fi

MSG_TEXT="PLAN REVIEW - ${AGENT}
ID: ${UNIQUE_ID}

${PLAN_CONTENT}

Reply 'approve ${UNIQUE_ID}' or 'deny ${UNIQUE_ID}'."

bash "${TEMPLATE_ROOT}/bus/send-discord.sh" "${DISCORD_ORCH_CHANNEL_ID}" "${MSG_TEXT}" > /dev/null 2>&1 || {
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
}

# Poll for response
ELAPSED=0
TIMEOUT=1800
POLL_INTERVAL=2

while [[ $ELAPSED -lt $TIMEOUT ]]; do
    if [[ -f "$RESPONSE_FILE" ]]; then
        DECISION=$(jq -r '.decision // "deny"' "$RESPONSE_FILE" 2>/dev/null || echo "deny")
        if [[ "$DECISION" == "allow" ]]; then
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        else
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Plan denied by user via Discord. Ask what they want to change."}}}'
        fi
        exit 0
    fi
    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Timeout - auto-approve so agents aren't blocked
bash "${TEMPLATE_ROOT}/bus/send-discord.sh" "${DISCORD_ORCH_CHANNEL_ID}" "Plan review TIMED OUT (auto-approved): ${AGENT}" > /dev/null 2>&1 || true

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
