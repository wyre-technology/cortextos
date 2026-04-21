# Billing-Wholesale Backlog Audit

**Date:** 2026-04-20
**Scope:** Read-only audit of the `billing-wholesale` tag (16 tasks / 80 subtasks) against upstream `feat/billing` and `feat/credit-ledger` branches in `mcp-gateway`.
**Status:** Nothing executed. No merge run. No tasks modified.

---

## 1. Upstream Branch Status

Both branches exist locally and at `origin` in `/Users/asachs/wyre-projects/gateway/mcp-gateway`.

### `feat/billing`

- **Commits ahead of main:** 11 (oldest `b11145b` scaffold → newest `ce5f439` test fixes).
- **Diff size:** 16 files, +678 / -53 (manageable).
- **Notable paths:**
  - `migrations/0001_subscriptions.sql` (103 lines, inline DDL, NOT wired into `OrgService.initTables`)
  - `src/billing/gate.ts` — three-tier (`free`/`pro`/`business`), hardcoded constants
  - `src/billing/plan-gate.ts` — new Fastify preHandler helpers (`makeRequirePlan`, `makeRequireOrgPlan`)
  - `src/billing/stripe-service.ts` — scaffold with `createCustomer`/`createCheckoutSession`/`getSubscription` stubbed as TODOs
  - `src/billing/billing-routes.ts` — `/api/billing/checkout`, `/api/billing/portal`
  - `src/billing/stripe-webhook.ts` — adds `planFromPriceId`, handles `checkout.session.completed`, `subscription.updated`, `subscription.deleted`
  - Touches `src/audit/routes.ts`, `src/log-shipping/routes.ts`, `src/org/routes/credentials.ts`, `src/org/org-service.ts` (to apply gates)
- **Blocking issues visible in the diff:**
  - Upstream has **no `plan-catalog.ts`** — Conduit invented that file. `feat/billing/gate.ts` hardcodes constants (`FREE_CREDITS = 500`, `PRO_CREDITS_PER_SEAT = 2000`, etc.). Conduit's env-driven catalog is architecturally superior and must be preserved.
  - `BillingGate` interface widens (`getUserPlan` now returns `'free' | 'pro' | 'business'`; adds `canUseAdvancedFeatures`, `canUseToolAllowlists`, `getOrgConnectionLimit`, `getCreditAllocation`). Conduit's narrower interface will conflict; all call sites that type-narrow against the union will need review.
  - `stripe-service.ts` is **stubs-only** (TODO comments). Upstream is not "done" — Conduit inherits the stubs.
  - `organizations.plan` column widens from `'free'|'pro'` to include `'business'` (in `org-service.ts`). DB check-constraints and plan-catalog slugs must agree.

### `feat/credit-ledger`

- **Commits ahead of main:** 10 (includes two rebase cleanup commits `bf01f23`, `9be8f85` — signals upstream has already rebased this once and knows duplicate-symbol hazards exist).
- **Diff size:** 9 files, +606 / -16.
- **Notable paths:**
  - `src/billing/credit-service.ts` (202 lines, brand new — `credit_ledger` + `credit_blocks` tables, FIFO `deductFromBlock`, `hasCreditsRemaining`, `getUsageThisMonth`)
  - `src/proxy/unified-router.ts` (+160) and `src/proxy/router.ts` (+38) — credit enforcement on `tools/call`
  - `src/index.ts` (bootstrap wires `CreditService`)
  - `src/org/routes.ts` — `GET /api/orgs/:orgId/credits`
  - `src/web/routes.ts` + `src/web/templates/personal-connections.ts` — credit meter UI
- **Dependency on feat/billing:** YES — this branch touches `src/billing/gate.ts` (adds `getCreditAllocation`). It was rebased onto `feat/billing` (commits `bf01f23`, `9be8f85` remove duplicates created by that rebase). Merging them out of order will re-introduce those duplicates.
- **Blocking issues visible in the diff:** heavy touch to `src/proxy/unified-router.ts` — Conduit's router has diverged in its own right (customer-tenant onboarding). Conflict expected here.

### Merge-order recommendation

Merge `feat/billing` first, resolve, run tests, THEN merge `feat/credit-ledger` on top. Reversing the order will re-surface the duplicate-symbol bugs that upstream already fixed.

---

## 2. Conduit Today

`src/billing/` currently contains:

- `plan-catalog.ts` — env-driven catalog, default `free` + `pro` only. **Shape must be preserved during merge.**
- `gate.ts` — two-tier `DefaultBillingGate`. Interface is narrower than upstream (no `getCreditAllocation`, no `getOrgConnectionLimit`, no `canUseAdvancedFeatures`, no `canUseToolAllowlists`).
- `checkout.ts`, `stripe-webhook.ts` — mirrors of upstream's earlier snapshot.
- `*.test.ts` — tests exist for gate, plan-catalog, checkout, stripe-webhook.

No `credit-service.ts`, no `subscriptions` migration wired, no hierarchy, no resellers yet.

---

## 3. Task Classification

Full backlog = 16 tasks (see `.taskmaster/tasks/tasks.json` under the `billing-wholesale` tag). Dependencies per `task-master list`:

| # | Title | Deps | Classification |
|---|---|---|---|
| 1 | Upstream sync — merge feat/billing + feat/credit-ledger | — | **Merge-gate root.** Human-review only. |
| 2 | Promote plan catalog to `plans` table | 1 | Merge-gated (needs upstream's three-tier catalog to seed). |
| 3 | Add hierarchical org model (`parent_org_id`, `org_kind`) | 2 | **Independent-ish** — pure Conduit additions; *could* land ahead of the merge with tolerance, see §4. |
| 4 | Add reseller columns to `organizations` | 3 | **Independent** — pure ALTERs on Conduit-owned rows; zero touch with upstream. |
| 5 | Wire `subscriptions` table into `OrgService.initTables` | 1, 2, 4 | Merge-gated (needs upstream `0001_subscriptions.sql`). |
| 6 | Reseller checkout flow | 5 | Merge-gated. |
| 7 | Invoice assembly cron | 2, 3, 4 | Merge-gated only via #2; the cron body itself is net-new. |
| 8 | Invoice + line-item tables + webhook shadowing | 4, 5, 7 | Merge-gated via #5. |
| 9 | Dunning cascade | 3, 8 | Merge-gated via #8. |
| 10 | Reseller credit pool (add `scope`, `reseller_org_id` to `credit_blocks`) | 1, 3 | **Strongly merge-gated** (table doesn't exist in Conduit yet — it comes from `feat/credit-ledger`). |
| 11 | Reseller aggregate caps | 3, 7, 10 | Merge-gated. |
| 12 | Reseller usage APIs | 3, 7, 8 | Merge-gated via #7/#8 (needs `usage_records` + `invoices`). |
| 13 | MSP admin dashboard UI | 6, 12 | Merge-gated (UI on top of merged surface). |
| 14 | Stripe Tax + VAT collection | 6, 8 | Merge-gated via #6/#8 but the feature itself is low-conflict. |
| 15 | Super-admin discount override endpoint | 4, 8 | Can land early on #4 alone; only the write-through to invoice assembly needs #8. |
| 16 | Acceptance test suite | 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 | Final validation. |

### Tasks that genuinely can land without the merge

- **#4** (reseller columns on `organizations`) — pure `ALTER TABLE ADD COLUMN IF NOT EXISTS` on columns Conduit owns. Zero upstream overlap.
- **#3** (hierarchical org model) — also pure Conduit territory; the risk is the OrgService interface grows and the merge later will need to reconcile. Manageable but not zero.
- A portion of **#2** — the `plans` table DDL + seeding loader can be written ahead of time as a PR against the env-driven catalog; only the `plan_kind='reseller'` discriminator column lights up after merge.
- A portion of **#15** — the super-admin endpoint + audit hook can be scaffolded against #4 only; the discount-apply-on-invoice edge waits for #8.

### Tasks that are genuinely merge-gated

- **#1** (root). **#5**, **#6**, **#7** (needs `credit_ledger` from feat/credit-ledger), **#8**, **#9**, **#10** (needs `credit_blocks`), **#11**, **#12**, **#13**, **#14**, **#16**.

---

## 4. Suggested Execution Order

| Task ID | Dependency Posture | Proposed Owner |
|---|---|---|
| 1 (merge) | root | **human review** — conflict resolution in `gate.ts`, `plan-catalog.ts` (none upstream → keep ours), `stripe-webhook.ts`, `unified-router.ts` |
| 4 (reseller columns) | independent; can run in parallel with #1 pre-merge | subagent (trivial migration + OrgService hook) |
| 3 (hierarchy) | independent pre-merge, but safer post-merge | subagent (post-merge preferred) |
| 2 (plans table) | partial pre-merge, finalize post-merge | subagent |
| 5 (wire subscriptions) | post-merge | subagent (small) |
| 15 (super-admin override) | depends on 4, 8; scaffold early | subagent for scaffold, human review for auth gate |
| 7 (invoice assembly cron) | post-merge, post-2/3/4 | subagent — **human review of money math** (§5 of PRD) |
| 8 (invoices table + shadow webhooks) | post-7 | subagent |
| 10 (reseller credit pool) | post-merge, post-3 | subagent |
| 6 (reseller checkout) | post-5 | subagent |
| 9 (dunning cascade) | post-3, post-8 | subagent — **human review of suspension logic** |
| 11 (aggregate caps) | post-3, 7, 10 | subagent |
| 12 (reseller APIs) | post-3, 7, 8 | subagent |
| 14 (Stripe Tax) | post-6, 8 | subagent |
| 13 (admin UI) | post-6, 12 | subagent |
| 16 (acceptance tests) | last | subagent + human review of financial assertions |

**Parallelism opportunity pre-merge:** #4 can proceed now in a dedicated branch while the human resolves #1. This shaves roughly one task's worth of calendar time without creating merge conflict risk (different files).

---

## 5. Risk Flags

1. **`src/billing/gate.ts` is a three-way conflict hotspot.** Conduit's narrower `BillingGate` interface, upstream's widened three-tier interface, and `feat/credit-ledger`'s `getCreditAllocation` addition all touch the same file. Recommend resolving by re-expressing upstream's hardcoded constants as entries in Conduit's env-driven catalog (the PRD §2.4 strategy) in one focused commit before anything else.
2. **`plan-catalog.ts` does not exist upstream.** The merge will preserve it trivially, but the *seeding values* for `business` tier (`BUSINESS_CREDITS_PER_SEAT = 4000`, pooled allocation semantics) need to be written into `DEFAULT_CATALOG` by hand — they won't arrive via merge.
3. **`src/proxy/unified-router.ts` is the other conflict hotspot.** `feat/credit-ledger` adds +160 lines here for credit enforcement; Conduit has already diverged with customer-tenant onboarding. Expect real conflicts. Human review required.
4. **`stripe-service.ts` is a stub, not a deliverable.** `createCustomer`, `createCheckoutSession`, `getSubscription` are all TODO in upstream. Task #6 (reseller checkout) implicitly requires finishing these before it can complete. Flag this when expanding #6's subtasks.
5. **`0001_subscriptions.sql` is unapplied upstream.** Upstream never wired it into `OrgService.initTables()`. PRD §14 step 1 and Task #5 both assume this. Verify the migration runs cleanly against a fresh Conduit DB before depending on it.
6. **Merge order matters.** `feat/credit-ledger` was rebased onto `feat/billing` (evidenced by commits `bf01f23`/`9be8f85` removing duplicate symbols). Do not merge credit-ledger first; duplicates will reappear.
7. **`organizations.plan` column type.** Upstream widens to `'free'|'pro'|'business'`. Conduit has existing rows with `'free'`/`'pro'` only. Verify no CHECK constraint on the column blocks the widened enum, and confirm no code path narrows the type without handling `'business'`.
8. **Authentication rule (per project policy).** All reseller APIs in tasks #12/#13/#15 must be authenticated. PRD §12 explicitly calls for role-owner gating + cross-reseller isolation. Audit this during #12 code review.
9. **Changelog discipline.** Per global instructions, every merged task should add a CHANGELOG entry. Upstream `feat/billing` already includes an 8-line CHANGELOG diff — preserve and extend it during merge, don't discard.
10. **Customer sub-org Stripe-customer invariant is application-layer only.** The PRD §4.3 notes `subs_no_customer_subs CHECK (TRUE)` is a placeholder; real enforcement is in `OrgService.createOrg`. Task #3's subtasks should include a **trigger or explicit test** covering "attempt to set `stripe_customer_id` on `org_kind='customer'` fails" rather than trusting the app layer alone. Acceptance criterion #2 tests the happy path; add the negative path.

---

## 6. TL;DR for tomorrow

- **Merge size is manageable** (~16 files / +678 lines for billing, ~9 files / +606 lines for credit-ledger) — this is a 2–4 hour human merge, not a multi-day event. The conflict surface is concentrated in two files: `src/billing/gate.ts` and `src/proxy/unified-router.ts`.
- **One task (#4) is fully independent** and can be handed to a subagent today while the human handles the merge.
- **Two tasks (#3, #2 partial, #15 partial) have independent scaffolding work** that can be prepared pre-merge but finalized post-merge.
- **Everything else is genuinely gated on the merge landing first.** Don't try to dodge that gate.
