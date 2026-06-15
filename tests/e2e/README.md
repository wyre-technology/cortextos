# Conduit staging E2E harness

Playwright harness for testing conduit against a **deployed staging**
(not testcontainers — real network, real Auth0, real vendor sidecars).

Filed under [Aaron-directive 2026-06-15](https://linear.app/wyre-ai) for
a launch-critical staging test gate.

## TL;DR — run it locally

```sh
# 1. install Playwright browsers (one-time)
npx playwright install chromium

# 2. set the staging URL (always required)
export CONDUIT_STAGING_URL=https://staging.conduit.wyre.ai

# 3. (optional) wire service-account creds for the bootstrap smoke
export CONDUIT_STAGING_SVC_CLIENT_ID=$(jq -r .client_id ~/.cortextos/default/secrets/conduit-boss-staging-svc.json)
export CONDUIT_STAGING_SVC_CLIENT_SECRET=$(jq -r .client_secret ~/.cortextos/default/secrets/conduit-boss-staging-svc.json)
export CONDUIT_STAGING_SVC_TOKEN_URL=$(jq -r .token_endpoint ~/.cortextos/default/secrets/conduit-boss-staging-svc.json)

# 4. run
npm run test:e2e
```

Without `CONDUIT_STAGING_URL` set, the suite is a clean no-op — CI-safe
by default. Flip it on in the staging pipeline only.

## Env-var contract

| Variable | Required for | Source |
|---|---|---|
| `CONDUIT_STAGING_URL` | every test that hits staging | infra |
| `CONDUIT_STAGING_SVC_CLIENT_ID` | service-account bootstrap (BYOC path b) | `~/.cortextos/default/secrets/conduit-boss-staging-svc.json` `.client_id` |
| `CONDUIT_STAGING_SVC_CLIENT_SECRET` | service-account bootstrap | same JSON `.client_secret` |
| `CONDUIT_STAGING_SVC_TOKEN_URL` | service-account bootstrap | same JSON `.token_endpoint` |
| `STAGING_TEST_EMAIL` | tenant-flow signup (PR-2) | Aaron-pending |
| `STAGING_TEST_PASSWORD` | tenant-flow signup (PR-2) | Aaron-pending |
| `STAGING_OPERATOR_EMAIL` | subtenant/actingAs (PR-3) | Aaron-pending |
| `STAGING_OPERATOR_PASSWORD` | subtenant/actingAs (PR-3) | Aaron-pending |
| `STAGING_ALT_PAYMENTS_CLIENT_ID` | alt-payments connect (PR-2) | Aaron-pending vendor sandbox |
| `STAGING_ALT_PAYMENTS_CLIENT_SECRET` | alt-payments connect (PR-2) | Aaron-pending vendor sandbox |
| `STAGING_DO_PAT` | DigitalOcean connect (PR-2) | Aaron-pending vendor sandbox |
| `STAGING_AUVIK_USERNAME` | auvik connect (PR-2) | Aaron-pending vendor sandbox |
| `STAGING_AUVIK_API_KEY` | auvik connect (PR-2) | Aaron-pending vendor sandbox |

Each test gates on the env-vars it needs and `test.skip`s when they're
missing. Murph's cred-inventory is the source-of-truth for which paths
exist today.

## BYOC duality

Pearl's spec (see Authority below) calls out two cred-entry paths:

- **(a) OAuth/PAT walk** — TRUE E2E. The harness drives the connect-UI
  form using real vendor sandbox creds. Needs Aaron-supplied sandboxes.
- **(b) Service-account direct cred-injection** — admin-scope cred-write
  via the service-account bearer. Bypasses the OAuth walk for vendors-
  without-sandbox. Wired via `fixtures/sa.ts`.

PR-1 ships the (b) bootstrap witness; PR-2 will land (a) once vendor
sandboxes arrive.

## Authoritative substrate

Endpoint paths, step sequences, and verification shapes come from
**pearl's flow specs**, NOT this README:

```
~/cortextos/orgs/wyre/agents/pearl/deliverables/conduit-staging-harness-flow-specs.md
```

Quick map:
- **FLOW 1 TENANT** (10 steps) — `POST /signup` → Auth0 callback → 3
  vendor connects (`POST /api/orgs/:orgId/credentials/:vendorSlug`) →
  validate round-trips → tools list → trivial tool-call
- **FLOW 2 SUBTENANT actingAs** (7 steps) — operator login → list
  customers → `/switch` (3-check LIFECYCLE-BIND from #398) →
  connect-on-behalf with SCOPE-vs-AUTHORIZATION separation → `/exit` →
  stale-session replay drive-fail
- **Cross-cutting verification** — audit-trail completeness counts +
  RLS sanity SQL + outbound network observability + teardown hygiene

If anything in this harness conflicts with pearl's spec, **pearl wins**.

## PR sequence

| PR | Scope | Status |
|---|---|---|
| **PR-1** | scaffold + smoke + flow stubs | ← this PR |
| PR-2 | tenant flow (pearl §1, 10 steps) | follow-up |
| PR-3 | subtenant actingAs flow (pearl §2, 7 steps) | follow-up |
| PR-4 | failure-mode coverage (LIFECYCLE-BIND revocation, SSRF live witness, cred-misconfig surfacing) | follow-up |

## Browsers

Chromium-only for v1 — Aaron-urgency = fastest path to green. Add
`firefox` / `webkit` to `playwright.config.ts` `projects[]` if a real
cross-browser bug surfaces.

## Test data isolation

V1 default: each test creates + cleans up its own org. The exact
fixture shape (whether staging has an ephemeral-org path or full
create+teardown is required) lands with PR-2 once pearl's spec is fully
absorbed.
