# WYRE cortextOS — SP2c-4: Dashboard admin password bootstrap

- **Status:** Draft for review
- **Date:** 2026-05-29
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — SP2c follow-up

## Context

SP2c-2 brought the central host live behind Cloudflare Tunnel + Entra Access at
`https://wyre-agents.wyre.ai`. Browser-testing the first end-to-end sign-in
surfaced a real gap: once Cloudflare Access + Entra SSO pass, the user lands on
the **cortextOS dashboard's own login form** (NextAuth credentials provider,
SQLite-backed). That form requires an `admin` user whose password is seeded
from the `ADMIN_PASSWORD` env var on first sign-in attempt. **The cloud-init
bootstrap (SP2b) never sets `ADMIN_PASSWORD`**, so a fresh deploy has no usable
dashboard credentials — and the seed function's "user already exists" guard
makes after-the-fact fixes require a fiddly `SYNC_ADMIN_PASSWORD=true` dance
(observed and worked around manually on 2026-05-29).

`dashboard/src/lib/auth.ts:seedAdminUser` is the relevant code path:
- Reads `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (required).
- Refuses to seed if `ADMIN_PASSWORD` is unset OR is a known default.
- Skips re-seeding when a user exists unless `SYNC_ADMIN_PASSWORD=true`.

The clean fix is to provision an admin password during cloud-init, persist it
to Key Vault so an operator can recover/rotate it without re-running cloud-init,
and document the rotation procedure.

## Goal

After SP2c-4, **a freshly provisioned VM presents a working dashboard login**
on the first browser visit. No manual `dashboard/.env.local` editing. Password
recovery is one `az keyvault secret show` away. Rotation is a documented one-
command flow that survives reboots.

## Decisions

1. **Random password at first boot, stored in Key Vault.** Cloud-init generates
   a 32-character `secrets.token_urlsafe`-style password if a sentinel
   (`/var/lib/cortextos/.admin-password-provisioned`) is absent, writes
   `ADMIN_USERNAME` + `ADMIN_PASSWORD` to `dashboard/.env.local`, **and** stores
   the password in Key Vault as `dashboard-admin-password`. Sentinel makes the
   step idempotent across reboots and bootstrap re-runs.

2. **Key Vault is the source of truth for operator recovery.** Operators do
   not read the password from the VM filesystem (the file is `chmod 600`
   `cortextos:cortextos`, only that user can read it). Recovery is always
   `az keyvault secret show --name dashboard-admin-password --vault-name <vault>`.

3. **The VM's managed identity needs Set permission on Key Vault.** SP2a only
   granted `Get, List` to the VM identity (correct for read-only secrets like
   the cloudflared token). SP2c-4 adds `Set` so cloud-init can write the
   admin password on first boot. Set is scoped to the VM identity; the
   operator's access policy is unchanged.

4. **Rotation is a documented runbook flow, not automated.** The runbook
   describes two paths: (a) regenerate via the dashboard UI's password-change
   form (preferred), (b) hard-rotate via cloud-init by deleting the sentinel
   and the `dashboard-admin-password` KV secret, then re-running the bootstrap
   service. Automating rotation on a schedule is out of scope.

5. **No spec-time SSO substitution.** The dashboard's NextAuth Credentials
   provider stays in place. A future project might replace it with NextAuth's
   Azure AD provider so Entra SSO carries all the way through to the dashboard
   identity. SP2c-4 explicitly does **not** do that — the goal here is to make
   the existing model work, not redesign it.

## What ships

> Scope expanded 2026-05-30 after first browser sign-in surfaced two more gaps
> in addition to the missing `ADMIN_PASSWORD`: **`AUTH_SECRET` was unset**
> (NextAuth refused to issue sessions, 500ing every `/api/auth/*` route) and
> **`ecosystem.config.js` shipped `next dev`** instead of `next start`
> (30-second cold compiles per route on first hit). Both fold cleanly into the
> same "dashboard first-boot env" workstream.

1. **`infra/terraform/cloud-init.yaml.tftpl`** — new bootstrap step
   (`provision_dashboard_env.sh` helper) that:
   - Skips if `/var/lib/cortextos/.dashboard-env-provisioned` exists (sentinel).
   - Otherwise generates:
     - `ADMIN_PASSWORD` — 32-char `secrets.token_urlsafe`-style random string.
     - `AUTH_SECRET` — 48-char `secrets.token_urlsafe` random string (NextAuth
       v5 requires it; without it the dashboard 500s every `/api/auth/*` call).
   - Writes `dashboard/.env.local` with: `ADMIN_USERNAME=admin`,
     `ADMIN_PASSWORD=<generated>`, `AUTH_SECRET=<generated>`,
     `AUTH_TRUST_HOST=true`, `NEXTAUTH_URL=<dashboard_url>`,
     `AUTH_URL=<dashboard_url>`. File is `chmod 600`, `chown cortextos:cortextos`.
   - Stores both `ADMIN_PASSWORD` and `AUTH_SECRET` in Key Vault as
     `dashboard-admin-password` and `dashboard-auth-secret`. Operator-recoverable.
   - Writes the sentinel, logs success.

2. **`src/cli/ecosystem.ts`** — already fixed (commit `bf95efb`): use
   `next start` when `NODE_ENV=production`, `next dev` otherwise. Included in
   the spec so the change history is one place to look.

3. **`infra/terraform/keyvault.tf`** — add `Set` to the VM identity's
   `secret_permissions` list (currently `Get, List` only — set was never
   needed before SP2c-4). Operator policy unchanged.

4. **`infra/systemd/cortextos-bootstrap.service`** — no change needed; the
   provision step runs inside the existing bootstrap script.

5. **`docs/runbook/sp2-host.md`** — add a "Dashboard credentials" section:
   - Where each value lives (Key Vault), how to retrieve.
   - Rotation via the dashboard UI (preferred for `ADMIN_PASSWORD`).
   - Hard-rotation via cloud-init (delete sentinel + KV secrets, restart
     `cortextos-bootstrap.service`).
   - `AUTH_SECRET` rotation — separate concern: rotating it invalidates all
     active sessions (signs everyone out). Documented as expected behavior.
   - Note: the operator IP must be on the Key Vault network ACL
     (`operator_ip_cidrs` variable) to read the secrets from a laptop.

6. **CHANGELOG entry** under `[Unreleased]`.

## Definition of done

- A `terraform destroy` + `terraform apply` cycle (on a feature branch with
  `cortextos_branch` pointed at this work) brings up a VM where:
  - Both `dashboard-admin-password` and `dashboard-auth-secret` exist in Key
    Vault and have non-empty values.
  - `/opt/cortextos/dashboard/.env.local` exists, owned `cortextos:cortextos`,
    mode 600, containing `ADMIN_USERNAME=admin`, `ADMIN_PASSWORD=<same as KV>`,
    `AUTH_SECRET=<same as KV>`, `AUTH_TRUST_HOST=true`, `NEXTAUTH_URL`, `AUTH_URL`.
  - `cortextos.service` is up, dashboard runs `next start` (NODE_ENV=production
    → `npm run start`), `/api/auth/session` returns 200 (not 500), first page
    load is sub-second.
  - Browser sign-in at `https://wyre-agents.wyre.ai` with the KV-stored
    password succeeds end-to-end. **No** `SYNC_ADMIN_PASSWORD` dance, **no**
    `MissingSecret` errors in the logs, **no** Turbopack/`next dev` messages.
- A reboot does not change the values (sentinel skips the step).
- The hard-rotation runbook procedure has been exercised once and produces a
  new working credential set.

## Risks & open questions

- **KV write at boot fails if KV firewall isn't ready.** SP2a's KV has
  `network_acls.virtual_network_subnet_ids = [vm subnet]`, so the VM can
  always reach KV from inside. This should be reliable. Bootstrap fails loudly
  if the `az keyvault secret set` call returns non-zero, so the operator sees
  the failure rather than getting a silent half-provisioned state.
- **First-boot ordering.** The admin-password step must run *after* the repo
  clone (so `dashboard/` exists) and *before* `cortextos.service` starts (so
  the dashboard reads the env on its first launch). The bootstrap script
  already has the right order — admin-password slots between `npm run build
  dashboard` and `cortextos install`.
- **Password not changed automatically over time.** A long-running install
  keeps the same password until an operator rotates. That matches every other
  secret in this stack (CF token, Entra app secret). Documented; not solved.

## Non-goals

- **Replacing dashboard auth with Entra SSO** — separate future project.
- **Multi-user dashboard accounts** — the dashboard's user model already
  supports it; SP2c-4 only seeds the single admin account.
- **Automated rotation** — runbook-driven, not scheduled.
