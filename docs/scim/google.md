# SCIM provisioning — Google Workspace

> **MIGRATED — this file is no longer the source of truth.**
> The four legacy `docs/scim/*.md` guides were consolidated into one Starlight page at [`docs/src/content/docs/guides/scim.mdx`](../src/content/docs/guides/scim.mdx), published at `https://conduit.wyre.ai/docs/guides/scim`. Do not extend this file — edit the Starlight version.

> **Note:** Google Workspace's user-provisioning surface is OAuth-based and tightly coupled to its **Automated User Provisioning** catalog. For non-catalog apps, Google supports **SCIM 2.0** through the **Google Cloud Identity** API, but the experience is materially less polished than Entra/Okta/JumpCloud. We recommend using one of the gallery integrations if you also have those IdPs available, and reaching to Google Workspace as a last resort.

This guide walks a Google Workspace super admin through connecting their tenant to the gateway via SCIM 2.0.

## Prerequisites

- An admin (Owner or Admin) on the gateway organization
- A Google Workspace **super admin** (regular admins lack provisioning rights)
- The org's Workspace plan must include **Cloud Identity Premium** or the equivalent Workspace tier that ships SCIM

## 1. Generate a SCIM token in the gateway

1. In the gateway, go to **Settings → Provisioning**
2. Click **Connect IdP**
3. Choose **Google Workspace**
4. Pick the **default role** for new users
5. Click **Generate token**
6. Copy the **Tenant URL** and **Secret token** — they will not be shown again

## 2. Add the gateway as a Custom SAML / SCIM app

1. Sign in to the [Google Admin console](https://admin.google.com)
2. **Apps → Web and mobile apps → Add app → Add custom SAML app**
3. Name the app (e.g. "Wyre Gateway") and click **Continue**
4. Skip the SAML config step (we only need provisioning, not SSO from Google) by clicking **Continue → Finish**

## 3. Configure auto-provisioning

1. From the app's page, click **Auto-provisioning** (under "User access")
2. **SCIM connector configuration**:
   - **Endpoint URL**: paste the Tenant URL from step 1
   - **Bearer token**: paste the secret token from step 1
3. **Test connection** → expect success
4. **Attribute mapping**: keep the defaults (`primaryEmail` → `userName`, `name.familyName` → `name.familyName`, etc.)
5. **Provisioning scope**: choose which org units / groups to sync
6. **Deprovisioning**: pick **Suspend the user** (mapped to `active=false` on our side)
7. Click **Save**

## 4. Activate

Toggle the **Auto-provisioning** switch on. Google syncs every ~30 minutes; there is no on-demand sync button.

## What gets provisioned

| Google Workspace concept | Gateway concept |
|---|---|
| User in scope | `users` row + `org_members` row at the connection's default role |
| Group in scope | `org_teams` row + `org_team_members` for each member |
| User suspended | `org_members` row removed; `users.active = false` |

## Limitations vs. other IdPs

- **No on-demand sync**: you wait for Google's ~30-minute interval
- **Limited PATCH support**: Google sends fewer attribute updates than Entra/Okta; expect occasional drift in display names
- **Group syncing is more limited**: nested groups are flattened; group rename does not always propagate

## Troubleshooting

- **"This service is not available"** in the SCIM connector page: your Workspace plan doesn't include SCIM. Upgrade to **Cloud Identity Premium** or contact your Google reseller.
- **Bearer token rejected**: Google encodes the token differently than other IdPs. Ensure no quotes or whitespace were added when pasting.
- **Users not appearing**: confirm the user is **inside an org unit or group** that is in the app's provisioning scope. Users outside the scope are silently ignored.

## Revoking

**Settings → Provisioning → Revoke** in the gateway invalidates the token immediately.
