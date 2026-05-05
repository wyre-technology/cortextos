# SCIM provisioning — Okta

This guide walks an Okta admin through connecting their tenant to the gateway via SCIM 2.0.

## Prerequisites

- An admin (Owner or Admin) on the gateway organization
- An Okta admin who can add applications and configure provisioning

## 1. Generate a SCIM token in the gateway

1. In the gateway, go to **Settings → Provisioning**
2. Click **Connect IdP**
3. Choose **Okta**
4. Pick the **default role** for newly provisioned users
5. Click **Generate token**
6. Copy the **Tenant URL** and **Secret token** — they will not be shown again

## 2. Create the Okta app

1. Sign in to your Okta admin console
2. **Applications → Browse App Catalog → SCIM 2.0 Test App (OAuth Bearer Token)** (or use the generic "SCIM 2.0 Test App") — click **Add Integration**
3. Name it (e.g. "Wyre Gateway") and click **Done**

## 3. Configure provisioning

1. In the new app, go to the **Provisioning** tab → **Configure API Integration**
2. Check **Enable API integration**
   - **Base URL**: paste the Tenant URL from step 1
   - **API Token**: paste the secret token from step 1
3. Click **Test API Credentials** — should show "the credentials provided were verified successfully"
4. Click **Save**
5. Under **Provisioning → To App**, enable:
   - **Create Users**
   - **Update User Attributes**
   - **Deactivate Users**

## 4. Assign users and groups

1. **Assignments** tab → **Assign → Assign to People** (or **Assign to Groups**)
2. Pick users/groups, optionally edit their attributes, then click **Save and Go Back**

Okta will push the assigned users immediately.

## 5. Push groups (optional)

If you want Okta groups to materialize as gateway teams:

1. **Push Groups** tab → **+ Push Groups → Find groups by name**
2. Pick the group; under **Match Result**, choose **Create Group**
3. Save

The gateway will create an `org_teams` row, and Okta will keep its membership in sync.

## What gets provisioned

| Okta concept | Gateway concept |
|---|---|
| User assignment | `users` row + `org_members` row at the connection's default role |
| Pushed group | `org_teams` row + `org_team_members` for each member |
| User deactivated / unassigned | `org_members` row removed; `users.active = false` |

## Troubleshooting

- **"Test API Credentials" returns 401**: the token from the gateway is wrong or revoked. Generate a fresh one.
- **Provisioning shows "User does not match a single SCIM user"**: Okta dedupes by `userName` (which we map to email). Verify the user's Okta `Username` is the same email used by the gateway.
- **Group push has no members**: only group members who are also **individually assigned** to the application get pushed. Assign the group itself in **Assignments**, not just its members.
- **Updates don't propagate**: Okta only pushes changes for attributes mapped under **Provisioning → To App → Profile Editor**. Add the attributes you want synced.

## Revoking

**Settings → Provisioning → Revoke** in the gateway invalidates the token. Okta will receive 401 on its next sync.
