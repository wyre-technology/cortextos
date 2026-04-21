# PRD — Platform Operations (Conduit)

**Tag:** `platform-ops`
**Status:** Draft v1
**Author:** Conduit core team
**Date:** 2026-04-18
**Audience:** engineering, SRE, release management
**Parser target:** taskmaster `parse-prd` → backlog for tag `platform-ops`

---

## 1. Purpose

Conduit is a white-label MSP channel / reseller gateway forked from
`wyre-technology/wyre-mcp-gateway-platform` on 2026-04-02. It now lives at
`/Users/asachs/work/wyre/engineering/projects/gateway/conduit` and tracks its
own remote (`git@github.com:wyre-technology/wyre-mcp-gateway-platform.git`,
branch `main`), while the active upstream — Wyre's first-party gateway — lives
at `/Users/asachs/work/wyre/engineering/projects/gateway/mcp-gateway` with
remote `git@github.com:wyre-technology/mcp-gateway.git`.

As of this PRD, mcp-gateway has moved roughly 16 days ahead of Conduit with
significant divergence (billing, credit-ledger, onboarding-ux, a2a-agent-
registry, hash-invitation-tokens, vendor-drift-audit workflow, Azure Managed
Grafana + Rootly alerting, service-client per-vendor allowlists). Conduit has
diverged too, in ways that are intentionally white-label: Lubing USA customer
brand, BrandConfig path-based routing, Microsoft/Azure AD multi-tenant auth
provider plugin, `customer_tenants` table, etc.

We have two problems to solve and one future event to plan for:

1.  **Keep Conduit healthy as a downstream fork.** Merges from upstream must
    happen on a predictable cadence with a clear conflict policy, otherwise
    Conduit will drift so far that re-integration becomes a rewrite.
2.  **Run Conduit as a production service.** Azure footprint, CI/CD,
    monitoring, secrets, incident response, and ops runbooks — all
    distinct from Wyre's own mcp-gateway production estate.
3.  **Leave the door open to merge Conduit back into mcp-gateway** once the
    reseller-tenancy abstraction is proved out, without a painful re-base.

This PRD scopes the platform-ops work to accomplish the above. It is
intentionally process-heavy: the product features belong in other PRDs
(`prd-reseller-tenancy.md`, `prd-white-label.md`, `prd-billing-dunning.md`,
etc.), and this document should not duplicate them.

---

## 2. Goals & Non-Goals

### Goals

- G1. Establish a written, scripted upstream-sync discipline with a weekly
  cadence and a well-defined conflict-arbitration process.
- G2. Separate Conduit's Azure footprint from Wyre mcp-gateway's — different
  resource groups, separate Postgres, separate Key Vaults, cost-attributable
  by tag.
- G3. Ship a dev → staging → prod release pipeline for Conduit images, with
  semantic-release running against the Conduit remote and publishing images
  to a Conduit-namespaced registry path.
- G4. Produce and exercise the ops runbooks needed before we onboard the
  first external reseller (incident response, rollback, dunning, data
  export).
- G5. Meet the security baseline that MSPs will actually audit against
  (secret scanning, dependency scanning, SOC2-light control evidence).
- G6. Keep the reseller-tenancy schema and code changes additive-only
  relative to upstream, so merge-back later is a diff review and not a
  rewrite.

### Non-goals

- Full SOC2 Type II audit execution. In scope: checklist + evidence trails.
  Out of scope (v2): auditor engagement, formal report.
- Multi-region Azure deploy. v1 is single-region (same region as current
  mcp-gateway prod). v2 can add paired-region DR.
- Moving off GitHub Actions. Azure DevOps / self-hosted runners are out of
  scope.
- Replacing Auth0 / Azure AD as the identity plane. That belongs to its own
  PRD.

---

## 3. Current state (investigation notes)

### 3.1 Repos and remotes

- Conduit working tree: `/Users/asachs/work/wyre/engineering/projects/gateway/conduit`
  - Remote: `git@github.com:wyre-technology/wyre-mcp-gateway-platform.git`
  - Branch: `main`
  - Package name: `@wyre-technology/mcp-gateway-platform` (see
    `package.json`).
- Upstream working tree: `/Users/asachs/work/wyre/engineering/projects/gateway/mcp-gateway`
  - Remote: `git@github.com:wyre-technology/mcp-gateway.git`
  - Branch: `main`

Important: these are **two different GitHub repos**, not the same repo with
different branches. That means "upstream sync" is actually a cross-repo
fetch/merge, not an in-repo rebase. We must configure Conduit's git config
with an `upstream` remote pointing at `wyre-technology/mcp-gateway`.

### 3.2 CI/CD inventory

Conduit (`/Users/asachs/work/wyre/engineering/projects/gateway/conduit/.github/workflows/`):

- `ci.yml` — Node 22, `npm ci`, typecheck, lint, test, build. Docker build
  pushes to `ghcr.io/${{ github.repository }}` on push to `main`.
- `claude.yml` — Claude Code bot integration.
- `deploy-azure.yml` — still references Terraform and registry/auth-server
  container app names from an older shape. **Stale — needs rewrite for the
  current Bicep-based setup.**
- `deploy.yml` — legacy.
- `redeploy-on-server-update.yml` — docs rebuild trigger.
- `release.yml` — semantic-release + Discord webhook + second docker build
  on release. No `.releaserc.json` is present in conduit — semantic-release
  is relying on defaults and the job will mis-behave.

Upstream mcp-gateway has additionally: `add-to-project.yml`,
`deploy-legacy.yml`, `deploy-prod.yml`, `deploy-staging.yml`,
`vendor-drift-audit.yml`, plus a `.releaserc.json` at repo root:

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/github", {"successComment": false, "failComment": false}],
    ["@semantic-release/git", {
      "assets": ["CHANGELOG.md", "package.json", "package-lock.json"],
      "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }]
  ]
}
```

Conduit needs its own `.releaserc.json` copy, possibly with a different
release channel.

### 3.3 Infrastructure inventory

Conduit: single `azure/main.bicep` file. Deploys Key Vault, Log Analytics,
Container Apps Environment, Postgres Flexible Server, gateway container
app with public ingress, and N vendor sidecar container apps. Defaults to
`env=prod` with prefix `mcpgw-{env}` — currently **collides by name with
Wyre's own mcp-gateway production resources** unless the operator passes
`namePrefix`. There is no separate staging/dev deployment config checked in.

Upstream adds `azure/grafana-subscription-role.bicep` and presumably a
richer Bicep setup for Grafana / alert rules.

### 3.4 Database & migrations

Conduit `migrations/`:
- `001_customer_tenants.sql` — the Azure AD customer tenants table.

That's it. Schema bootstrapping otherwise happens in-app at startup
(see recent commits: "create users+auth_state tables unconditionally",
"init org + auth tables before credential service"). This is fine for now
but needs to become an actual versioned migration system before we onboard
paying resellers.

### 3.5 Tests

Vitest is configured (`vitest.config.ts`, `"test": "vitest run"`). Found
~20 test files across auth, billing, brand, org, audit, oauth, proxy,
waitlist, monitoring, profile, and config. No e2e / integration harness
hitting a real Postgres. No contract tests against upstream MCP vendors.
No reseller-tenancy-specific test suites yet because reseller-tenancy
hasn't landed.

### 3.6 Security tooling

- No `dependabot.yml` in Conduit.
- No Renovate config in Conduit.
- No secret-scanning workflow checked in.
- No CODEOWNERS (upstream has one).

### 3.7 Changelog

Conduit has a `CHANGELOG.md` already following Keep-a-Changelog format.
The "Unreleased" section is big (Lubing brand, BrandConfig, Azure AD, etc).
**Inherited-from-upstream entries are mixed in with Conduit-specific ones**,
which will make merge-back painful.

---

## 4. Design

### 4.1 Upstream sync discipline

**Branching strategy**

- `main` on Conduit's remote = the shipping branch. Protected. Merge via PR
  only. Requires passing CI.
- `sync/upstream-YYYY-MM-DD` = short-lived branch for each upstream merge.
  Opened by the sync script (below), merged by PR after review.
- `conduit/feature/*` = feature branches for Conduit-only work.
- No long-lived topic branches. The longer a Conduit-only topic lives off
  `main`, the harder the next upstream sync is.

Conduit's git should have two remotes:

```bash
git remote add upstream git@github.com:wyre-technology/mcp-gateway.git
git remote set-url --add --push origin git@github.com:wyre-technology/wyre-mcp-gateway-platform.git
git fetch upstream
```

**Cadence**

- Default: **weekly Monday sync.** A scheduled GitHub Action opens a
  `sync/upstream-YYYY-MM-DD` PR against `main` with the merge commit and a
  conflict report attached.
- On-demand: any engineer can kick a sync off by running
  `scripts/upstream-sync.sh` locally, or by dispatching the workflow with
  `workflow_dispatch`.
- If upstream ships a security fix, the sync is same-day.

**Conflict policy**

Three-tier arbitration:

1.  **Pure upstream file** (no Conduit diff in the last N commits) —
    accept upstream verbatim.
2.  **Pure Conduit file** (no upstream change in the last N commits) —
    keep Conduit.
3.  **Conflict on a shared file** — author of the most recent Conduit
    commit to that file is the arbiter. They either (a) rewrite Conduit's
    diff against the new upstream base, or (b) escalate to the Conduit
    tech lead. In either case a `// CONDUIT-OVERRIDE:` comment is added
    at the top of the divergent block with a brief reason and date.

The sync script auto-labels conflicted files and assigns the PR to
CODEOWNERS, so nobody is surprised.

**Sync tooling — `scripts/upstream-sync.sh`**

```bash
#!/usr/bin/env bash
# scripts/upstream-sync.sh — weekly upstream sync helper.
# Usage: ./scripts/upstream-sync.sh [--dry-run]

set -euo pipefail

BRANCH="sync/upstream-$(date -u +%Y-%m-%d)"
BASE="${BASE:-main}"
UPSTREAM="${UPSTREAM:-upstream/main}"

git fetch origin "$BASE"
git fetch upstream main

# Commits in upstream not in Conduit.
echo "::group::Upstream commits not yet in Conduit"
git log --oneline "origin/${BASE}..${UPSTREAM}"
echo "::endgroup::"

if [[ "${1:-}" == "--dry-run" ]]; then
  exit 0
fi

git checkout -B "$BRANCH" "origin/${BASE}"
if ! git merge --no-ff --log "$UPSTREAM" -m "chore(sync): merge upstream/$UPSTREAM into ${BASE}"; then
  echo "Merge produced conflicts. Listing:"
  git diff --name-only --diff-filter=U | tee .sync-conflicts
  echo "Resolve, then: git commit && git push -u origin $BRANCH"
  exit 2
fi

git push -u origin "$BRANCH"
gh pr create --base "$BASE" --head "$BRANCH" \
  --title "chore(sync): upstream $(date -u +%Y-%m-%d)" \
  --body "$(cat <<EOF
Automated weekly upstream sync.

### Upstream commits merged
\`\`\`
$(git log --oneline origin/${BASE}..${UPSTREAM} | head -50)
\`\`\`

### Conflicts resolved
$( [[ -f .sync-conflicts ]] && cat .sync-conflicts || echo "None." )
EOF
)"
```

**Sync tooling — GitHub Action `upstream-sync.yml`**

```yaml
name: Upstream Sync
on:
  schedule:
    - cron: '0 13 * * 1'   # Mondays 13:00 UTC
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.CONDUIT_SYNC_PAT }}
      - name: Configure upstream
        run: |
          git remote add upstream https://github.com/wyre-technology/mcp-gateway.git
          git fetch upstream main
      - name: Run sync
        env:
          GH_TOKEN: ${{ secrets.CONDUIT_SYNC_PAT }}
        run: ./scripts/upstream-sync.sh
```

**Changelog discipline**

`CHANGELOG.md` gains two sub-sections under each release:

```
## [Unreleased]

### Conduit-specific
- white-label BrandConfig path-based routing (#123)
- Microsoft/Azure AD multi-tenant auth provider (#130)

### Inherited from upstream (mcp-gateway)
- credit-ledger feature (#upstream-456)
- hash-invitation-tokens (#upstream-470)
```

The sync PR template auto-populates the "Inherited from upstream" block
from the `git log` output above.

### 4.2 Release engineering

**Versioning**

Stick with **semver** driven by semantic-release from conventional
commits. Reasons: already tooled, already used upstream, integrates with
the release workflow already in `release.yml`. Calver was considered and
rejected because reseller customers will ask "what changed in
`1.14.0 → 1.15.0`?" and semver answers that more naturally than
`2026.04.0 → 2026.05.0`.

Create `.releaserc.json` in Conduit root, mirroring upstream but with:

- `branches: ["main", {"name": "next", "prerelease": true}]` so we can
  cut `-rc` builds when we want.
- Separate GitHub release namespace (automatic — it uses the repo we're
  in).
- Same git plugin assets.

**Docker tagging**

Images publish to `ghcr.io/wyre-technology/wyre-mcp-gateway-platform`
(already the default from `ci.yml`). Tags:

- `vMAJOR.MINOR.PATCH` — set by semantic-release.
- `vMAJOR`, `vMAJOR.MINOR` — floating.
- `sha-<7>` — every main build, for traceability.
- `latest` — only on a successful release (not on every `main` push).
- `staging` — promoted by a workflow after staging-env smoke tests pass.

We stop publishing `latest` on every `main` push because prod should not
follow `main`; it should follow a versioned tag.

**Environments**

- **dev**: developer laptop via `docker-compose.yml` (already present).
  No Azure footprint.
- **staging**: dedicated Azure RG `conduit-staging-rg`, Bicep deployed
  with `env=staging`, auto-deploys from `main` after successful CI.
  Uses a Burstable Postgres tier (following the mcp-gateway learning:
  pin `max: 5` on postgres-js connection pools at this tier — burstable
  is hard-capped at 50 max connections and doesn't support PgBouncer).
- **prod**: RG `conduit-prod-rg`, Bicep deployed with `env=prod`, deploys
  only on a published release tag + manual approval in GitHub
  Environments. GeneralPurpose Postgres tier (D2ds_v4+).

### 4.3 Infrastructure

**Azure separation**

- Same Azure tenant as Wyre, separate subscription if possible
  (`Conduit-Prod`, `Conduit-NonProd`). If not feasible, at minimum
  separate resource groups with an immutable `product=conduit` tag on
  every resource so cost reports aggregate cleanly.
- Separate Key Vaults per environment. No cross-environment secret reuse.
- Separate Postgres Flexible Server per environment — under no
  circumstances does Conduit share a database with Wyre's mcp-gateway
  prod. This is already the pattern but it needs to be explicit.
- Separate Log Analytics workspace and Application Insights.
- Separate Container Registry path even if we continue to publish to
  `ghcr.io` — don't tag Conduit images with anything that looks like a
  Wyre internal image, since MSP resellers will pull from ghcr and we
  don't want cross-product surprise.

**Bicep changes required**

- Parameterise `env` so staging and prod deploy from the same template.
- Parameterise the Postgres tier (Burstable for staging, GP for prod).
- Parameterise the Container Apps `maxReplicas` (low for staging).
- Add a `tags = { product: 'conduit', env: env }` applied to every
  resource.
- Split the huge `main.bicep` into modules:
  `modules/keyvault.bicep`,
  `modules/postgres.bicep`,
  `modules/gateway-app.bicep`,
  `modules/vendor-app.bicep`,
  `modules/observability.bicep`.
- Parameterise the `vendors[]` default so that Conduit resellers can
  publish their own sidecar catalog without editing the template. (See
  prd-vendor-catalog.md.)

**Secrets**

Bootstrap via `scripts/bootstrap-keyvault.sh` that takes env + subscription
as args and seeds:

- `AUTH0_CLIENT_SECRET` (or `AZURE_AD_CLIENT_SECRET` for the MS path)
- `MASTER_KEY` (64 hex)
- `JWT_SECRET` (64 hex)
- `POSTGRES_ADMIN_PASSWORD`
- `GHCR_READ_TOKEN`
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`

Container Apps reference Key Vault secrets via managed identity
`secretRef` — never as raw env vars in source control.

**Monitoring / alerting**

- Application Insights per env, wired into the Fastify app via a small
  plugin (or OpenTelemetry exporter).
- Dashboards (pin to a workspace per env):
  - Gateway RPS, p50/p95/p99 latency, 4xx/5xx rate.
  - Vendor-container RPS + error rate, per vendor slug.
  - Postgres connection count + query latency (watch `pg_stat_activity`
    given the Burstable 50-connection cap).
  - Auth flows: success vs failure per provider.
  - Per-reseller rollup (RPS, billing-relevant tool-call count) —
    requires the reseller-tenancy work; for now a stub.
- Alerts (Azure Monitor action group → PagerDuty/Rootly, Discord
  webhook):
  - 5xx > 1% over 5 min.
  - Gateway health `/health` 3 consecutive fails.
  - Postgres CPU > 80% for 10 min.
  - Postgres connection count > 80% of cap.
  - ACA revision failed to reach healthy.
  - Container cold-start timeouts on the gateway.

### 4.4 CI/CD

**Pipeline shape**

`ci.yml` already does the right base work (typecheck, lint, test,
build, docker). We'll extend it:

- Matrix Node versions: just 22 for now, but matrix-ready.
- Postgres service container in a dedicated `integration` job so we can
  run migration + repo-level integration tests.
- On PR: build image, run tests. Do not push to ghcr.
- On merge to `main`: run full pipeline, push `sha-<7>` and `main` tags,
  deploy to staging, run smoke tests against staging.
- On release tag: promote the `sha-<7>` image to `vX.Y.Z` and
  `latest`, deploy to prod with manual approval.

**`deploy-staging.yml` sketch**

```yaml
name: Deploy Staging
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-staging
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID_NONPROD }}
      - name: Deploy Bicep
        run: |
          az deployment group create \
            --resource-group conduit-staging-rg \
            --template-file azure/main.bicep \
            --parameters env=staging \
                         gatewayImage=ghcr.io/wyre-technology/wyre-mcp-gateway-platform:sha-${GITHUB_SHA::7} \
                         masterKey=${{ secrets.STAGING_MASTER_KEY }} \
                         jwtSecret=${{ secrets.STAGING_JWT_SECRET }} \
                         pgPassword=${{ secrets.STAGING_PG_PASSWORD }} \
                         ghcrToken=${{ secrets.GHCR_READ_TOKEN }}
      - name: Smoke test
        run: |
          ./scripts/smoke-test.sh https://staging.conduit.example.com
```

**`deploy-prod.yml` sketch**

Same shape, but triggered by `release: published` and gated on
`environment: production` which requires a reviewer.

**Preview environments for PRs**

Not in v1. Each vendor sidecar is a full container app — spinning up N of
those per PR would be expensive. Instead: run `docker-compose.yml`
locally + an ephemeral Postgres for PR-level integration tests.
Revisit if/when reseller onboarding flows need multi-stakeholder review.

### 4.5 Test strategy

**Inventory (current)**

Vitest + ~20 unit/service-level test files across: auth, billing,
brand, org, audit, oauth, proxy, waitlist, monitoring, profile,
config. No Postgres-backed integration harness. No cross-repo
contract tests against the upstream vendor MCP images.

**New tests required for Conduit**

- **Reseller-tenancy RLS tests.** For every table that gains a
  `reseller_id` column, a test that verifies a query scoped to
  reseller A cannot see rows owned by reseller B, even under a
  crafted SQL injection string. Pattern: use `pg_catalog.set_config`
  to simulate request-bound session context and assert SELECT counts.
- **White-label inheritance tests.** Given reseller config
  `{ brandId: "lubing" }`, assert that:
  - `/lubing` landing renders with Lubing fonts/colors,
  - `/connect` default brand is untouched,
  - Customer brands configured under a reseller cannot read other
    resellers' brand config.
- **Upstream-sync contract tests.** For every file Conduit has
  diverged from upstream on, a test that pins the Conduit behaviour.
  These exist to catch "upstream accidentally reverted your
  white-label hook" regressions during weekly syncs.
- **Migration idempotence tests.** Given a fresh Postgres container,
  run all migrations, then re-run — second run must be a no-op.
- **Gateway /health + /ready tests** that assert correct behaviour
  when Postgres is down, when Auth0 is down, when Key Vault is down.

**Test-infra improvements**

- `scripts/test-integration.sh` spins up a Postgres container with
  Testcontainers-for-node, runs migrations, runs the `test:integration`
  vitest tag.
- Add `test:integration` and `test:contract` npm scripts.
- Add a `vendor-drift-audit.yml`-equivalent workflow that pings each
  upstream vendor MCP's `/mcp` initialize handshake nightly and files
  an issue on regressions (upstream already has this — we port it and
  point at our vendor list).

### 4.6 Ops runbooks

Runbooks live under `docs/runbooks/` as markdown. Each runbook has:
symptoms, detection, mitigation, resolution, preventive follow-up.
Runbooks to author:

- `rb-incident-gateway-5xx.md` — gateway returning 5xx in prod.
- `rb-incident-vendor-down.md` — specific vendor sidecar down.
- `rb-incident-postgres-connection-exhaustion.md` — (tied to the
  Burstable 50-conn learning; includes `az postgres flexible-server
  parameter show` checks, `SELECT count(*) FROM pg_stat_activity`,
  and the mitigation ladder: lower pool → lower replicas → upgrade
  tier).
- `rb-rollback.md` — how to roll back a deployed revision
  (`az containerapp revision set-mode single --revision <old>`),
  how to roll back a Bicep deploy, how to roll back a migration.
- `rb-dunning-suspension.md` — customer billing failures: which
  table to flip, which audit event to emit, how to resume on payment.
- `rb-reseller-offboarding-export.md` — reseller churn: export all
  data for a reseller in a documented format, purge after N days.
- `rb-secret-rotation.md` — rotating MASTER_KEY, JWT_SECRET, Auth0
  client secrets, Stripe webhook secret, GHCR PAT.
- `rb-customer-tenant-onboarding.md` — the Azure AD admin-consent
  flow, including how to verify `customer_tenants` row insertion.

Each runbook is exercised at least once before GA. Post-incident, we
amend the relevant runbook (or author a new one) as part of the
incident postmortem.

### 4.7 Merge-back plan

We plan to merge Conduit back into mcp-gateway once:

- **M1.** Reseller-tenancy schema is stable for 60 days with no
  breaking changes.
- **M2.** White-label brand system has been adopted upstream for at
  least one non-default brand (e.g. Wyre's own MSP customers).
- **M3.** No test or runbook regressions between the two repos for
  4 consecutive weekly syncs.
- **M4.** Billing + dunning flows on Conduit have reached feature
  parity with upstream, or upstream has absorbed Conduit's
  extensions.
- **M5.** Conduit has zero schema renames of upstream tables; every
  Conduit change is either a new table, a new column with a default,
  or an additive migration.
- **M6.** Sign-off from upstream tech lead on the divergence diff.

**Prep tasks we can do NOW** to make merge-back cheap:

- Treat the reseller_id column as additive. Never drop, never rename
  an upstream column.
- Keep brand overrides in a dedicated `src/brand/` module — do not
  sprinkle brand-specific `if` branches throughout `src/`.
- Keep customer-tenants logic in its own `src/auth/azure-ad/` subtree.
- Annotate every Conduit-only source line with `// CONDUIT:` so the
  merge-back author can grep.
- Keep `CHANGELOG.md` split between "Conduit-specific" and "Inherited".
- Keep migrations purely additive and timestamped
  (`YYYYMMDDHHMM_description.sql`) so merge-back is a chronological
  fold-in.

### 4.8 Security baseline

**Secret scanning**

- Enable GitHub secret scanning + push protection on the Conduit repo.
- Add `gitleaks` as a PR check:

```yaml
# .github/workflows/secret-scan.yml
name: Secret Scan
on: [pull_request]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}
```

**Dependency scanning**

Enable Dependabot via `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule: { interval: "weekly" }
    open-pull-requests-limit: 10
    labels: ["deps"]
  - package-ecosystem: "docker"
    directory: "/"
    schedule: { interval: "weekly" }
    labels: ["deps", "docker"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly" }
    labels: ["deps", "ci"]
```

We prefer Dependabot over Renovate for the lower config overhead;
Renovate can replace it later if grouping becomes painful.

**SOC2-light control checklist for MSP resellers**

These are the evidence items MSPs will actually ask about. None are a
formal audit; all are tractable in-quarter.

| Control | Evidence |
|---|---|
| Access to prod is MFA-only | Azure AD Conditional Access policy screenshot |
| Least-privilege IAM | List of prod-scoped service principals + roles |
| Secrets never in git | Gitleaks run log, Dependabot alerts clear |
| Data encrypted at rest | Azure Postgres TDE enabled; Key Vault HSM-backed |
| Data encrypted in transit | HTTPS-only ingress + TLS 1.2+ on Postgres |
| Backup + restore tested | Quarterly Postgres PITR drill documented |
| Audit logs retained | `audit_events` table + Log Analytics 90-day retention |
| Incident response plan | Runbooks in `docs/runbooks/` |
| Vulnerability management | Dependabot + gitleaks + quarterly patch window |
| Change management | PRs required to `main`, CODEOWNERS approval |
| Reseller data isolation | RLS tests green in CI |
| Reseller data export on churn | `rb-reseller-offboarding-export.md` |
| Subprocessor list | Published in `docs/subprocessors.md` |
| DPA template | `docs/dpa-template.md` |

---

## 5. Acceptance criteria

A1. `git remote -v` in Conduit shows both `origin` and `upstream`
remotes, with `upstream` pointing at `wyre-technology/mcp-gateway`.

A2. `scripts/upstream-sync.sh --dry-run` prints a human-readable list
of upstream commits not yet in Conduit and exits 0.

A3. `.github/workflows/upstream-sync.yml` runs every Monday 13:00 UTC
and opens a sync PR (or comments "no new upstream commits" if none).

A4. `.releaserc.json` exists in Conduit root and the `release.yml`
workflow produces a semver tag + GitHub release + CHANGELOG entry on
every main push that contains conventional-commit changes.

A5. `CHANGELOG.md` has a "Conduit-specific" vs "Inherited from
upstream" split under `[Unreleased]` and under the most recent
released version.

A6. Docker images publish with `sha-<7>`, `vX.Y.Z`, and (on release)
`latest` tags to `ghcr.io/wyre-technology/wyre-mcp-gateway-platform`.

A7. `azure/main.bicep` is modularised into at least 4 files under
`azure/modules/`, parameterised by `env`, and tagged
`product=conduit, env=<env>` on every resource.

A8. A staging environment is reachable at a staging domain, deployed
by `deploy-staging.yml` on every merge to `main`, and passing smoke
tests.

A9. A prod environment exists in its own RG and subscription (or, at
minimum, its own RG with a `product=conduit` tag), deployed only by
`deploy-prod.yml` gated on a GitHub Environment approver.

A10. Separate Key Vault per environment. No cross-env secret reuse
(verified by inspection).

A11. Separate Postgres Flexible Server per environment. Prod is
GeneralPurpose tier or higher.

A12. Application Insights dashboard exists for staging and prod,
including the metrics in §4.3.

A13. Alert rules fire to a test action group on simulated conditions
(5xx spike, health fail, PG CPU, PG connections, revision unhealthy).

A14. Integration test harness runs against a Postgres container in
CI, and reseller-tenancy RLS tests are part of the CI gate.

A15. Runbooks in `docs/runbooks/` exist for all items in §4.6, and
each has been dry-run at least once by an on-call engineer.

A16. `dependabot.yml`, `gitleaks` action, and GitHub secret scanning
are all enabled on the Conduit repo. Baseline state: zero unresolved
alerts.

A17. SOC2-light control checklist has an evidence artefact checked in
for each row (even if the artefact is a screenshot or a markdown
attestation).

A18. A merge-back readiness report (`docs/merge-back-status.md`) is
generated weekly and tracks M1–M6.

---

## 6. Out of scope (v1)

- SOC2 Type II audit execution with an external auditor.
- Multi-region Azure deployment and paired-region DR.
- Self-hosted GitHub runners.
- Moving off ghcr.io to a private ACR as the source of truth (we can
  mirror to ACR but ghcr remains the publish target in v1).
- Full reseller-tenancy feature work — that's `prd-reseller-tenancy.md`.
- Cost-chargeback automation per reseller — v2.

---

## 7. Open questions

- **OQ1.** Do we keep publishing to `ghcr.io/wyre-technology/...` or
  move to a Conduit-owned GitHub org (e.g. `conduit-platform`)? This
  affects MSP-reseller image-pull credentials.
- **OQ2.** Is "Conduit" a separate Azure subscription or a separate RG
  in the existing Wyre subscription? Finance wants a clean invoice
  line; engineering wants the lowest-friction option.
- **OQ3.** What's the staging domain? `staging.conduit.wyre.technology`
  or a Conduit-owned domain (once we register one)?
- **OQ4.** Do we mirror upstream's `vendor-drift-audit` workflow, or
  wait for reseller-tenancy so we can scope the audit per reseller?
- **OQ5.** Do we carry over upstream's Azure Managed Grafana + Rootly
  alerting, or stay with Application Insights + PagerDuty for v1?
  (Upstream is clearly moving toward Grafana.)
- **OQ6.** Should the "sync PR" workflow require a human reviewer, or
  auto-merge if there are no conflicts and CI is green? (Probably
  require a human for v1.)
- **OQ7.** What's our merge-back target date? Pencil in Q4 2026 so we
  can plan against it, but confirm with product.
- **OQ8.** Do we formalise a "Conduit-specific" commit-message prefix
  (`feat(conduit): ...`) to make merge-back grep-able? Or rely on the
  CODEOWNERS-scoped paths?
- **OQ9.** How do we want to handle the `.releaserc.json` drift —
  semantic-release `extends` so Conduit inherits from upstream, or
  copy-paste and accept the drift?

---

## 8. Dependencies on other PRDs

- `prd-reseller-tenancy.md` — owns the schema that RLS tests assert on.
- `prd-white-label.md` — owns the brand system that white-label
  inheritance tests exercise.
- `prd-billing-dunning.md` — owns the dunning-runbook reality.
- `prd-vendor-catalog.md` — owns the vendor list that Bicep
  parameterises.

This PRD does not block those; they'll deliver their pieces, and this
PRD will absorb their schema/API surface into the test harness and the
runbooks.

---

## 9. Proposed task list

These map 1:1 to taskmaster tasks under the `platform-ops` tag. Keep
them in this order; earlier tasks unblock later ones.

1.  **Configure upstream remote + sync tooling.** Add `upstream` remote
    to Conduit repo, write `scripts/upstream-sync.sh`, document in
    `docs/ops/upstream-sync.md`. Acceptance: A1, A2.
2.  **Weekly upstream-sync GitHub Action.** Author
    `.github/workflows/upstream-sync.yml`, wire `CONDUIT_SYNC_PAT`
    secret, confirm first scheduled run opens a PR. Acceptance: A3.
3.  **Split CHANGELOG into Conduit vs inherited.** Reorganise existing
    `CHANGELOG.md`, document the convention in `CONTRIBUTING.md`.
    Acceptance: A5.
4.  **Add `.releaserc.json` and fix release workflow.** Port upstream's
    config, verify a conventional-commit push to main cuts a semver
    tag. Acceptance: A4.
5.  **Docker-tag hygiene.** Update `ci.yml` and `release.yml` so
    `latest` only moves on release, plus add `sha-<7>` and `vX.Y.Z`
    tags. Acceptance: A6.
6.  **Modularise `azure/main.bicep`.** Split into
    `modules/{keyvault,postgres,gateway-app,vendor-app,observability}.bicep`,
    parameterise `env`, add `product=conduit` tags. Acceptance: A7.
7.  **Stand up Conduit staging env.** Deploy to
    `conduit-staging-rg`, create `deploy-staging.yml`, run smoke test.
    Acceptance: A8.
8.  **Stand up Conduit prod env.** Deploy to `conduit-prod-rg`,
    create `deploy-prod.yml` with GitHub Environments approval,
    ensure separate Key Vault + Postgres. Acceptance: A9, A10, A11.
9.  **Application Insights + dashboards.** Wire AI into the Fastify
    app, build staging + prod dashboards for the §4.3 metrics.
    Acceptance: A12.
10. **Alert rules + action group.** Implement the alerts in §4.3,
    wire to Discord webhook (and PagerDuty/Rootly once OQ5 is
    resolved), drill-test each one. Acceptance: A13.
11. **Integration test harness + RLS tests.** Add
    `scripts/test-integration.sh`, Testcontainers Postgres, and the
    reseller-tenancy RLS test suite (coordinate with
    `prd-reseller-tenancy.md`). Acceptance: A14.
12. **Runbook set.** Author all `docs/runbooks/rb-*.md` in §4.6,
    dry-run each, link from on-call doc. Acceptance: A15.
13. **Security baseline.** Enable Dependabot, gitleaks workflow,
    GitHub secret scanning + push protection. Resolve baseline
    alerts. Acceptance: A16.
14. **SOC2-light control evidence.** For each row in §4.8 table,
    check in an artefact under `docs/security/`. Acceptance: A17.
15. **Merge-back readiness report.** Author
    `docs/merge-back-status.md`, schedule weekly update via a
    lightweight GitHub Action that appends `git log origin/main
    ^upstream/main` diff summary and M1–M6 status. Acceptance: A18.
16. **Vendor drift audit.** Port upstream's `vendor-drift-audit.yml`
    and adapt to Conduit's vendor list (pending OQ4).
17. **Bootstrap scripts.** `scripts/bootstrap-keyvault.sh` and
    `scripts/bootstrap-postgres.sh` for a fresh env setup, documented
    under `docs/ops/`.
18. **CODEOWNERS + branch protection.** Add `.github/CODEOWNERS`
    mirroring upstream's shape but mapping to Conduit maintainers.
    Protect `main` with required reviews, required status checks,
    and linear history.

---

*End of PRD.*
