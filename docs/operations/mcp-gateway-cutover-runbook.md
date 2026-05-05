# mcp-gateway → Conduit cutover runbook

This runbook covers Phases 5–7 of the consolidation
(plans/okay-so-we-need-imperative-pebble.md). Phases 0–4 are code-complete on
`feat/mcp-gateway-consolidation`. Everything below executes against live
infrastructure and should be done in order.

## Prerequisites

- [ ] `feat/mcp-gateway-consolidation` reviewed and ready to merge
- [ ] mcp-gateway production `MASTER_KEY` retrievable from its Key Vault
- [ ] Read-only credentials to mcp-gateway prod Postgres (or a recent restore)
- [ ] Conduit staging environment provisioned (see
  `infrastructure/azure/`) with `staging.conduit.wyre.ai` DNS pointing at it
- [ ] Auth0 staging callback URL allowlisted:
  `https://staging.conduit.wyre.ai/auth/callback`

## Phase 5 — Staging dry run + smoke (~1 day)

### 5.1 Sync MASTER_KEY

Pull from mcp-gateway prod Key Vault and load into Conduit staging Key Vault
under the same secret name. **Never paste into a CI run log or commit.** All
encrypted credential rows in mcp-gateway use a key derived from
`MASTER_KEY ‖ scope` — if Conduit's value differs by even one byte, every
migrated credential becomes unreadable.

### 5.2 Apply migrations

The destination DB must be at migration 017 (this branch). If the staging DB
was provisioned earlier:

```sh
DATABASE_URL=postgres://...staging-db... npm run migrate
```

(The repo applies migrations from `migrations/*.sql` on boot; if you prefer to
apply explicitly, point `psql` at each new file.)

### 5.3 Dry-run the data migration

```sh
DATABASE_URL_SRC=postgres://...mcp-gateway-prod-readonly... \
DATABASE_URL_DST=postgres://...conduit-staging... \
MASTER_KEY=<from mcp-gateway prod Key Vault> \
npm run migrate:from-mcp-gateway -- --dry-run
```

Expected output: per-table `read=` counts followed by an `org_members` FK
spot-check. Inspect that:
- `users.read` and `organizations.read` look reasonable for prod
- the FK spot-check shows all 5 sampled rows resolve to existing orgs/users

If anything fails — stop here and triage. The dry run is read-only on both
sides, so it's safe to re-run.

### 5.4 Live run

Same command without `--dry-run`. Watch the output:

- Per-table `read / inserted / skipped` counts
- A final line: `decrypt canary: N/N orgs OK`

If the canary reports failures, **stop**. The data is in place but credentials
are unreadable — most likely a `MASTER_KEY` mismatch. Re-check the Key Vault
secret, then re-run; the script is idempotent (`ON CONFLICT DO NOTHING`).

### 5.5 Smoke test checklist

Run against `staging.conduit.wyre.ai`:

- [ ] **Auth0 login** for a migrated user — session binds to migrated org;
      dashboard loads
- [ ] **Credential decrypt + proxy**: pick one migrated `org_credentials` row
      from a vendor with a sidecar deployed in staging; call
      `tools/list` against `/v1/<vendor>/mcp` with the user's JWT — must
      return 200 with the vendor's tools
- [ ] **SCIM endpoints**: `GET /scim/v2/t/<orgId>/Users` with a valid bearer
      token returns the SCIM-shaped user list (PR #38 surface)
- [ ] **Reseller hierarchy**: a reseller admin can create a new customer org
      under their reseller and invite a member to it
- [ ] **White-label brand config** loads for at least one migrated org
      (verify the org's settings page shows the right logo/copy)
- [ ] **Stripe customer portal** opens for an org with a migrated
      `stripe_customer_id` (no need to actually mutate the subscription)
- [ ] **Credit metering** wires through: trigger a successful `tools/call`,
      check `SELECT COUNT(*) FROM credit_ledger WHERE org_id = ...` increments
      by 1
- [ ] **Vendor OAuth flow** end-to-end (e.g., Xero): start at
      `/connect/xero`, complete the consent dance, confirm
      `vendor_oauth_flow_states` has exactly zero rows for the user post-callback
      (consume() deletes on read) and `org_credentials` has the new entry

## Phase 6 — Production cutover (~½ day, only after Phase 5 is green)

### 6.1 Maintenance mode on mcp-gateway

Land a deploy on mcp-gateway that returns `503` for `/v1/*` and `/mcp/*` with
a "migration in progress" body. Keep `/health` open so probes don't flap.

Pin the timing — don't do this when active sessions are likely to be in the
middle of a long-running tool call.

### 6.2 Migrate against Conduit prod

```sh
DATABASE_URL_SRC=postgres://...mcp-gateway-prod-readonly... \
DATABASE_URL_DST=postgres://...conduit-prod... \
MASTER_KEY=<from mcp-gateway prod Key Vault> \
npm run migrate:from-mcp-gateway
```

Same script as staging. Idempotent — re-run safely if interrupted. Watch the
canary line at the end.

### 6.3 DNS flip

Point the customer-facing hostname (e.g., `mcp.wyre.ai`) at Conduit
production. Wait 5 minutes for cache propagation; verify with
`dig mcp.wyre.ai` and a `curl -I https://mcp.wyre.ai/health`.

### 6.4 Watch for 24 hours

- Conduit `request_log` should show traffic resuming
- Error rate should stay flat or drop (Conduit's proxy has more thorough error
  handling than mcp-gateway)
- Stripe webhook deliveries shouldn't fail — both endpoints accept the same
  signing secret

If anything goes wrong, mcp-gateway is still in maintenance mode but its data
hasn't been touched (the script is read-only on the source). Roll back by
flipping DNS back; no data loss.

### 6.5 Replace 503 with 301

After 24h of clean operation, swap mcp-gateway's `/v1/*` and `/mcp/*`
responses from `503` to `301` redirects pointing at the corresponding
Conduit paths. This catches stragglers who bookmarked the old hostname.

## Phase 7 — Archive mcp-gateway (~½ day)

- [ ] Update `wyre-technology/mcp-gateway` README: lead with `[ARCHIVED — see Conduit]`,
      link to the new repo
- [ ] Migrate or close all open issues on mcp-gateway. Anything tagged for
      Conduit gets retitled and re-filed there
- [ ] After in-flight PRs are resolved, set the GitHub repo to "archived"
- [ ] Decide on `.github/workflows/upstream-sync-report.yml` in Conduit —
      either delete it or repurpose to alert on unexpected new commits to the
      now-archived upstream
- [ ] Conduit `CHANGELOG.md` will get an auto-generated entry from the
      commit messages on `feat/mcp-gateway-consolidation` once the branch
      merges (semantic-release handles this — don't hand-edit)

## Rollback paths

- **Before DNS flip**: nothing is committed; flip mcp-gateway out of
  maintenance, no further action needed.
- **After DNS flip, before 24h watch passes**: flip DNS back to mcp-gateway,
  put Conduit in maintenance mode, triage. Conduit's DB has the migrated
  data; mcp-gateway's DB is untouched (script never wrote to it).
- **After 24h passes but a problem surfaces later**: this is the hard case.
  By then both gateways have diverged. Triage on a per-issue basis. The
  migration script's idempotence means you can re-run it without duplicating
  data — useful if you need to backfill rows that arrived in mcp-gateway
  during a longer-than-expected maintenance window (don't, but the option is
  there).

## Open follow-ups (not blockers)

- Backport `safe-fetch.ts` / `rejectIfUnsafeBaseUrl` from upstream so the
  ported `validate()` bodies for cipp / kaseya-vsa / unitrends / blackpoint
  regain their SSRF defense.
- `halopsa-official` config compiles but won't proxy real traffic until
  per-tenant `resolveContainerUrl` and bearer-token-cache plumbing land in
  Conduit's `VendorConfig`.
- Wire the new `canUseAuditLogExport` / `canUseSso` / `canUseServiceClients`
  gate methods into call sites once the corresponding upsell flows exist
  (currently the methods are scaffolding — nothing reads them yet).
