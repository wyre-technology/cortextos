#!/usr/bin/env bash
# hook-ask-discord.sh - PreToolUse hook for AskUserQuestion (orchestrator-scoped)
# Non-blocking: posts question(s) to the Discord orchestrator channel, exits 0.
# Saves an ask-state.json (same schema as hook-ask-telegram.sh) so the Discord
# interaction handler can navigate multi-question flows.
#
# Discord has no Telegram-style inline-keyboard callbacks routed through the
# daemon yet, so options are rendered as a numbered list and the user replies
# with the option number(s). The interaction handler that turns those replies
# into selections is the deferred inbound-parity piece (mirrors Telegram's
# fast-checker askopt_/asktoggle_ handling).

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
    exit 0
fi

QUESTIONS_JSON=$(echo "$INPUT" | jq -c '.tool_input.questions // []' 2>/dev/null || echo "[]")
QUESTION_COUNT=$(echo "$QUESTIONS_JSON" | jq 'length' 2>/dev/null || echo "0")

if [[ "$QUESTION_COUNT" -eq 0 ]]; then
    exit 0
fi

# Save state file (same schema as the Telegram ask hook) for the interaction
# handler to navigate question structure.
ASK_STATE_DIR="${CTX_ROOT:-${HOME}/.cortextos/default}/state/${AGENT}"
mkdir -p "${ASK_STATE_DIR}"
STATE_FILE="${ASK_STATE_DIR}/ask-state.json"
echo "$QUESTIONS_JSON" | jq -c '{
    questions: [.[] | {
        question: .question,
        header: (.header // ""),
        multiSelect: (.multiSelect // false),
        options: [.options[] | (.label // .)]
    }],
    current_question: 0,
    total_questions: length,
    multi_select_chosen: [],
    channel: "discord"
}' > "$STATE_FILE"

if [[ ! -f "$STATE_FILE" ]]; then
    echo "ERROR: Failed to create ask state file" >&2
    exit 0
fi

# Build the first question message (numbered options as text).
Q_IDX=0
Q_TEXT=$(echo "$QUESTIONS_JSON" | jq -r ".[$Q_IDX].question // \"Question\"" 2>/dev/null)
Q_HEADER=$(echo "$QUESTIONS_JSON" | jq -r ".[$Q_IDX].header // empty" 2>/dev/null || echo "")
Q_MULTI=$(echo "$QUESTIONS_JSON" | jq -r ".[$Q_IDX].multiSelect // false" 2>/dev/null)
Q_OPTIONS=$(echo "$QUESTIONS_JSON" | jq -c ".[$Q_IDX].options // []" 2>/dev/null)
Q_OPT_COUNT=$(echo "$Q_OPTIONS" | jq 'length' 2>/dev/null || echo "0")

if [[ "$QUESTION_COUNT" -gt 1 ]]; then
    MSG="QUESTION (1/${QUESTION_COUNT}) - ${AGENT}:"
else
    MSG="QUESTION - ${AGENT}:"
fi
[[ -n "$Q_HEADER" ]] && MSG+="
${Q_HEADER}"
MSG+="
${Q_TEXT}
"

if [[ "$Q_MULTI" == "true" ]]; then
    MSG+="
(Multi-select: reply with the option numbers, e.g. '1,3')"
else
    MSG+="
(Reply with the option number)"
fi

for i in $(seq 0 $((Q_OPT_COUNT - 1))); do
    LABEL=$(echo "$Q_OPTIONS" | jq -r ".[$i].label // .[$i] // \"Option $((i+1))\"" 2>/dev/null)
    DESC=$(echo "$Q_OPTIONS" | jq -r ".[$i].description // empty" 2>/dev/null || echo "")
    MSG+="
$((i+1)). ${LABEL}"
    [[ -n "$DESC" ]] && MSG+="
   ${DESC}"
done

bash "${TEMPLATE_ROOT}/bus/send-discord.sh" "${DISCORD_ORCH_CHANNEL_ID}" "${MSG}" > /dev/null 2>&1 || true

exit 0
