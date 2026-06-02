# SP3a — Slack app one-time setup

This is a one-time manual step. After it's done, the bot token sits in Key
Vault and the cortextOS bootstrap picks it up automatically on every boot.

## Status (live install, 2026-06-02)

- App name: `WYRE Agents`
- App ID: `A0B8MN37YSC` (Slack-side)
- Workspace: WYRE (`wyretalk.slack.com`)
- Bot token stored in Key Vault as `slack-bot-token`

## Prereq

- WYRE Slack workspace admin access (or someone with permission to install
  apps in the workspace).
- Operator IP on `operator_ip_cidrs` (needed for the final `az keyvault
  secret set`).

## Steps (for the next operator who has to re-create this)

1. **Create the app.** Go to https://api.slack.com/apps → **Create New App**
   → **From a manifest** (recommended — sets name + all scopes in one paste).
2. **Pick workspace:** WYRE → Next.
3. **Paste this manifest:**

   ```json
   {
     "display_information": {
       "name": "WYRE Agents",
       "description": "WYRE cortextOS agents posting to Slack (SP3a outbound)",
       "background_color": "#000000"
     },
     "features": {
       "bot_user": {
         "display_name": "WYRE Agents",
         "always_online": true
       }
     },
     "oauth_config": {
       "scopes": {
         "bot": [
           "chat:write",
           "chat:write.customize",
           "files:write",
           "channels:read",
           "groups:read",
           "im:read",
           "mpim:read",
           "users:read"
         ]
       }
     },
     "settings": {
       "org_deploy_enabled": false,
       "socket_mode_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```

4. **Next → Create.**
5. **Install App** (left nav) → **Install to WYRE** → **Allow** at the consent
   screen.
6. **Copy the Bot User OAuth Token** (`xoxb-...`).
7. **Stash in Key Vault** from your laptop:

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-bot-token --value '<paste-xoxb-token>' --output none

8. **Verify:**

       az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-bot-token --query "[name, length(value)]" -o tsv

   Expected: `slack-bot-token` + a length around 75+.

> Socket Mode (the **App-Level Token**) is set up in SP3b, not now. SP3a is
> outbound-only and doesn't need it.

## What you don't have to do yet

- Create the `#agents-*` channels (recap, ops, approvals, experiments). SP3a's
  smoke test posts to any channel you invite the bot into; topical channel
  inventory lands in SP3b.
- Invite the bot to channels. We do that during the SP3a smoke test
  (`/invite @WYRE Agents` in the target channel).

## Rotation

Bot token rotation:
1. https://api.slack.com/apps/A0B8MN37YSC → **OAuth & Permissions** →
   **Rotate Tokens** (or Reinstall to invalidate the old one).
2. Update Key Vault:

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-bot-token --value '<new-xoxb>' --output none

3. SSH the host and restart cortextOS so the daemon picks up the new env:

       ssh wyre-agents-ssh.wyre.ai
       sudo systemctl restart cortextos
