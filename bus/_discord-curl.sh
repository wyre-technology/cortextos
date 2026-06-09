#!/usr/bin/env bash
# _discord-curl.sh - Shared helper for Discord REST API calls.
# Keeps DISCORD_BOT_TOKEN out of shell traces (set +x) while preserving stderr.
# Source this file, then call the functions. Requires DISCORD_BOT_TOKEN in env.
#
# Discord uses the "Bot <token>" authorization scheme (NOT Bearer).
#
# Usage:
#   source "$(dirname "$0")/_discord-curl.sh"
#   RESPONSE=$(discord_create_message "$CHANNEL_ID" "hello")
#   RESPONSE=$(discord_create_message "$CHANNEL_ID" "re: ..." "$REPLY_MESSAGE_ID")

DISCORD_API_BASE="${DISCORD_API_BASE:-https://discord.com/api/v10}"

# POST a message to a Discord channel.
# Usage: discord_create_message <channel_id> <text> [reply_to_message_id]
discord_create_message() {
    local channel_id="$1"
    local text="$2"
    local reply_to="${3:-}"
    local payload
    if [[ -n "$reply_to" ]]; then
        payload=$(jq -n -c \
            --arg content "$text" \
            --arg ref "$reply_to" \
            '{content: $content, message_reference: {message_id: $ref, fail_if_not_exists: false}}')
    else
        payload=$(jq -n -c --arg content "$text" '{content: $content}')
    fi
    (
        set +x  # prevent trace from leaking token
        curl -s -X POST "${DISCORD_API_BASE}/channels/${channel_id}/messages" \
            -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$payload"
    )
}

# GET the current bot user (token check). Usage: discord_get_me
discord_get_me() {
    (
        set +x
        curl -s "${DISCORD_API_BASE}/users/@me" \
            -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
    )
}
