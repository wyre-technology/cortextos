# SP3b — Slack Socket Mode inbound setup

One-time manual step, same app as SP3a (`WYRE Agents`, App ID `A0B8MN37YSC`,
workspace `wyretalk.slack.com` — see `sp3a-slack-app-setup.md`). Do NOT
create a second app.

## Steps

1. **Enable Socket Mode.** App settings → **Socket Mode** → toggle **ON**.
2. **Generate an App-Level Token.** App settings → **Basic Information** →
   **App-Level Tokens** → **Generate Token**. Name it (e.g. `socket-mode`),
   scope: `connections:write`. This produces an `xapp-…` token.
3. **Stash in Key Vault**, matching `slack-bot-token`'s naming convention:

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-app-token --value '<paste-xapp-token>' --output none

4. **Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes) — add:
   - `channels:history` (read public channel messages)
   - `groups:history` (read private channel messages)
   - `im:history` (read DMs to the bot, if DM support is wanted)

   (SP3a's manifest already has `chat:write`, `channels:read`, `groups:read`
   — those stay as-is.)
5. **Event Subscriptions** (Features → Event Subscriptions): toggle
   **Enable Events ON** — no Request URL needed, Socket Mode delivers events
   over the WebSocket instead. Subscribe to bot events:
   - `message.channels`
   - `message.groups`
   - `message.im` (if DMs wanted)
   - `app_mention`
6. **Reinstall the app to the workspace.** Required for new scopes to take
   effect — this **re-issues the bot token** (`xoxb-…`) too, not just the new
   app-level one. Update Key Vault's `slack-bot-token` the same way as SP3a's
   rotation runbook, not just add the new `slack-app-token`.
7. **Verify:**

       az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-app-token --query "[name, length(value)]" -o tsv

   Expected: `slack-app-token` + a length around 60+.
8. **Restart the daemon** so it picks up `SLACK_APP_TOKEN` from the refreshed
   env (same restart step as SP3a's token rotation runbook).

## Per-agent setup (after the app-level steps above)

1. **Invite the bot** to whichever channel(s) the agent should listen on:
   `/invite @WYRE Agents` in that channel.
2. **Get the channel id.** `cortextos slack discover-channels` lists every
   channel the bot is in with its id.
3. **Fail-closed user allowlist.** Add every Slack user id that should be
   able to message this agent to `slack.json`'s `allowed_users`, as
   `"<team_id>:<user_id>"` composite keys (not bare user ids — see
   `identity.ts`'s docblock for why). Get a user's id via their Slack profile
   → "Copy member ID", and the team id from the workspace's own id (visible
   in the workspace URL or `team.info`). **An agent with an empty or missing
   `allowed_users` accepts messages from no one** — this is deliberate
   fail-closed behavior (mirrors Telegram's `ALLOWED_USER`), not a bug.

   ```json
   {
     "display_name": "boss",
     "icon_emoji": ":robot_face:",
     "channels": { "recap": "C01XXXX01" },
     "allowed_channels": ["C01XXXX01"],
     "allowed_users": ["T0ABCDEF:U0123456"]
   }
   ```

   Note: `allowed_users` is a single flat list across ALL of this agent's
   `allowed_channels` — not a per-channel map. Fine for a single-channel
   agent; a future multi-channel agent needing different trust levels per
   channel would need this reworked.

## What SP3b does NOT do (deferred to SP3c)

Interactive hooks (Block Kit Approve/Deny buttons, thread-reply asks,
channel-routed crash alerts) are a separate sub-project per the SP3 design
spec (`docs/superpowers/specs/2026-06-02-wyre-cortextos-sp3-slack-design.md`).
SP3b delivers plain conversational inbound: a message in an allowed channel
from an allowed user gets injected into the agent's PTY session, same shape
as Telegram.

## Design deviation from the original SP3 spec — logged for the record

The original SP3 design spec's ACL model was channel-only ("Bot listens to
channels it's invited to; each agent has an allowlist of channels... messages
from non-allowlisted channels are dropped silently"). SP3b's actual build
adds a second, independent user-level `allowed_users` gate on top of the
channel allowlist — an explicit fail-closed decision made during tonight's
build (boss + warden security review), not a deviation discovered later.
Channel membership alone was judged too weak a security boundary: channels
are N-member and membership can drift after setup. Both gates must pass.

## Rotation

Same procedure as `slack-bot-token` (see `sp3a-slack-app-setup.md`'s
Rotation section) — rotate both `slack-bot-token` and `slack-app-token` if
either is compromised, then restart the daemon.
