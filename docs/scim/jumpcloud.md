# SCIM provisioning — JumpCloud

> **MIGRATED — this file is no longer the source of truth.**
> The four legacy `docs/scim/*.md` guides were consolidated into one Starlight page at [`docs/src/content/docs/guides/scim.mdx`](../src/content/docs/guides/scim.mdx), published at `https://conduit.wyre.ai/docs/guides/scim`. Do not extend this file — edit the Starlight version.

This guide walks a JumpCloud admin through connecting their directory to the gateway via SCIM 2.0.

## Prerequisites

- An admin (Owner or Admin) on the gateway organization
- A JumpCloud admin who can manage SSO Applications

## 1. Generate a SCIM token in the gateway

1. In the gateway, go to **Settings → Provisioning**
2. Click **Connect IdP**
3. Choose **JumpCloud**
4. Pick the **default role** new users will receive
5. Click **Generate token**
6. Copy the **Tenant URL** and **Secret token** — they will not be shown again

## 2. Create the JumpCloud SSO Application

1. JumpCloud admin console → **User Authentication → SSO Applications → + Add New Application**
2. Search for **Custom SAML App** *(JumpCloud's SCIM provisioning lives under any SAML/SSO app — pick Custom SAML App if you don't already have one for the gateway)*
3. Fill in basic Display Name (e.g. "Wyre Gateway") and click **Save Application**
4. Open the new application → **Identity Management** tab

## 3. Configure SCIM 2.0

1. On the **Identity Management** tab, switch the **Configuration Type** to **SCIM 2.0**
2. **Base URL**: paste the Tenant URL from step 1
3. **Token Key**: paste the secret token from step 1
4. **Test Connection** — should show success
5. Set **Group Management** to **On** if you want JumpCloud groups synced as gateway teams
6. Click **Activate**

## 4. Assign users and groups

1. Open the application → **User Groups** tab → tick the groups whose members you want provisioned, then **Save**
2. Optionally, on the **Users** tab, assign individual users

JumpCloud syncs every ~5 minutes by default.

## What gets provisioned

| JumpCloud concept | Gateway concept |
|---|---|
| User assignment (direct or via group) | `users` row + `org_members` row at the connection's default role |
| Group with **Group Management** on | `org_teams` row + `org_team_members` |
| User suspended / unassigned | `org_members` row removed; `users.active = false` |

## Troubleshooting

- **Test Connection fails**: re-paste the token. Some JumpCloud admins accidentally include trailing whitespace.
- **Users provisioned but no group membership**: Group Management was off when the app was activated. Toggle it on, then re-save the app — JumpCloud will replay group memberships on the next sync.
- **Sync seems stuck**: JumpCloud's sync interval is 5 min for users, longer for group changes. Force a sync by toggling the app's **Identity Management → Activate** off and on.

## Revoking

**Settings → Provisioning → Revoke** in the gateway invalidates the token. JumpCloud will see 401 on its next sync.
