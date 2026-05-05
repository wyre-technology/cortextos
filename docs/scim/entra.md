# SCIM provisioning — Microsoft Entra ID

This guide walks an Entra ID admin through connecting their tenant to the gateway via SCIM 2.0. Provisioning runs every ~40 minutes by default; you can also click **Provision on demand**.

## Prerequisites

- An admin (Owner or Admin role) on the gateway organization
- An Entra ID admin who can create Enterprise applications and assign users

## 1. Generate a SCIM token in the gateway

1. In the gateway, go to **Settings → Provisioning**
2. Click **Connect IdP**
3. Choose **Microsoft Entra ID**
4. Pick the **default role** new SCIM-provisioned users will receive (`member` is the safe default)
5. Click **Generate token**
6. Copy the **Tenant URL** and **Secret token** — they will not be shown again

Keep this tab open; you will paste those values into Entra in step 3.

## 2. Create the Enterprise application in Entra

1. Sign in to the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID** → **Enterprise applications** → **+ New application**
2. Click **Create your own application** at the top
3. Name it (e.g. "Wyre Gateway SCIM")
4. Choose **Integrate any other application you don't find in the gallery (Non-gallery)**
5. Click **Create**

## 3. Configure provisioning

1. From the app's **Overview**, choose **Provisioning** in the left nav
2. Click **Get started**, then set **Provisioning Mode** to **Automatic**
3. Under **Admin Credentials**:
   - **Tenant URL**: paste the URL from step 1
   - **Secret Token**: paste the token from step 1
4. Click **Test Connection** — you should see "The supplied credentials are authorized to enable provisioning"
5. Click **Save**

## 4. Assign users and groups

1. From the app's **Overview**, click **Users and groups** → **+ Add user/group**
2. Pick the users and groups you want provisioned
3. Click **Assign**

## 5. Start provisioning

1. Back in **Provisioning**, set **Provisioning Status** to **On**
2. Click **Save**
3. Click **Provision on demand** to push the first batch immediately

You can verify the result in the gateway's **Settings → Members** and **Settings → Teams** pages.

## What gets provisioned

| Entra concept | Gateway concept |
|---|---|
| User assignment | `users` row + `org_members` row at the connection's default role |
| Group assignment | `org_teams` row + `org_team_members` for each member |
| User disabled / unassigned | `org_members` row removed; `users.active = false` (re-activatable) |

## Troubleshooting

- **"Test Connection" fails with 401**: the token in Entra doesn't match what the gateway issued. Generate a new token and paste it again — Entra encrypts the token at rest and won't show you the original.
- **Users provisioned but cannot log in**: SCIM creates a "shadow" user record keyed by email. The user must still log in via the gateway's existing SSO (Auth0). On first login the shadow record is bound to their identity.
- **Group memberships not syncing**: Entra only sends group memberships for groups that are explicitly assigned to the application. Make sure the group is in **Users and groups**, not just its members.
- **Provisioning paused after errors**: Entra auto-pauses after sustained failures. Check **Provisioning logs** in Entra for the underlying error, fix it, then click **Restart provisioning**.

## Revoking access

In the gateway, **Settings → Provisioning → Revoke** on the connection invalidates the token immediately. Entra will receive 401 on its next sync. The teams and users it created remain in place until manually removed.
