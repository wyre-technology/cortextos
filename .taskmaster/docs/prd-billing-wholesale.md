# PRD: Billing — Wholesale / MSP Channel (tag: billing-wholesale)

**Project:** Conduit (white-label MSP channel fork of `mcp-gateway`)
**Tag:** `billing-wholesale`
**Status:** Draft for taskmaster parse
**Owner:** Aaron Sachs
**Last updated:** 2026-04-18

---

## 1. Purpose & Scope

Conduit is a downstream, white-label fork of Wyre's `mcp-gateway`, packaged for Managed Service Provider (MSP) channel resale. MSPs onboard onto Conduit as **reseller orgs**, and each of their end customers is a **customer sub-org** hanging off the MSP. Wyre bills the MSP (a single payer); the MSP separately bills its own customers (out of scope for Conduit's billing engine — MSPs handle that in their own PSA/billing stack).

This PRD covers the **billing engine**: data model, Stripe integration, usage rollup, wholesale discount mechanics, suspension/dunning, tax, and the plumbing that supports — but does not define — the MSP→customer pricing policy (that policy lives in the sibling `pricing-decision` PRD).

### In scope

- Wholesale plan + subscription model for MSP orgs.
- Hierarchical billing subject (MSP reseller org ↔ customer sub-orgs).
- Usage rollup (tool calls, credit consumption, vendor connection counts) from customer sub-orgs up to the MSP invoice.
- Stripe integration: customers, subscriptions, checkout, customer portal, webhooks, invoice PDFs.
- Credit ledger extension for reseller-level pooling and wholesale-priced overage blocks.
- Plan caps enforced at both customer-sub-org and reseller aggregate level.
- Failed payment / dunning / suspension cascade.
- Tax at reseller scope (VAT/GST via Stripe Tax).
- Upstream sync protocol for pulling `feat/billing` and `feat/credit-ledger` branches down into Conduit.

### Out of scope (v1)

- **Direct-to-customer billing** — Conduit never takes money from a customer sub-org in v1. Customer sub-orgs do not hold a payment method.
- **Per-customer Stripe accounts / Stripe Connect onboarding** — MSPs are not Connect accounts. They are a single Stripe Customer under Wyre's platform account.
- **Marketplace payouts** — No revenue share / payout flow from Wyre to MSP.
- **MSP→customer invoicing UI in Conduit** — we expose usage data so the MSP can invoice, but we don't generate customer-facing invoices.
- **Crypto / wire / ACH-only billing** — Stripe card + ACH debit via Stripe only in v1.
- **Multi-currency display per customer** — Reseller plan currency = invoice currency. No per-sub-org currency override.
- **Proration of customer-sub-org seat changes to the MSP mid-period** — we accumulate and settle at period boundary.

---

## 2. Background: What Exists Upstream

Investigating the upstream worktrees shows the following already-in-flight billing work that Conduit inherits rather than rewrites.

### 2.1 `feat/billing` branch (mcp-gateway)

**Files:** `src/billing/` — `gate.ts`, `plan-gate.ts`, `checkout.ts`, `stripe-webhook.ts`, `stripe-service.ts`, `billing-routes.ts`.
**Migration:** `migrations/0001_subscriptions.sql`.

Already implemented:

- Three-tier plan model (`free` / `pro` / `business`) on the **organizations** row (inline columns: `plan`, `stripe_customer_id`, `stripe_subscription_id`).
- `DefaultBillingGate` — feature + limit gates: `canUseTeamFeatures`, `canUseAdvancedFeatures` (Business-only), `canUseToolAllowlists`, `getConnectionLimit`, `getOrgConnectionLimit`, `getRateLimit`, `getCreditAllocation`.
- `subscriptions` migration (unapplied — inline-DDL style, not wired into `OrgService.initTables()` yet).
- Stripe webhook handler covering `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
- `planFromPriceId()` mapping price IDs to plan slugs.
- `POST /api/billing/checkout` and `POST /api/billing/portal` routes.
- `makeRequirePlan(minPlan)` + `makeRequireOrgPlan(minPlan, getOrgId)` Fastify preHandlers for feature gating.
- `StripeService` scaffold (stubbed — `createCustomer`, `createCheckoutSession`, `getSubscription` are TODOs).
- Plan catalog stub (`PLAN_CATALOG` array) — upstream's catalog is hardcoded; **Conduit's is env-driven** (`PLAN_CATALOG` JSON env var in `src/billing/plan-catalog.ts`).

Known upstream TODOs (per code comments) — Conduit should **inherit and resolve**:

1. Decide source of truth — `subscriptions` table vs `organizations.plan` column. Recommended: subscriptions authoritative, org.plan is denormalized cache updated in the same transaction by the webhook.
2. Wire `0001_subscriptions.sql` into `OrgService.initTables()` using the `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` inline pattern, **or** adopt a migration runner.
3. Trial period? (code comment says "14-day free trial on first checkout" is a candidate).
4. Annual billing discount tier?
5. Currency handling — USD-only for now per scaffold.

### 2.2 `feat/credit-ledger` branch (mcp-gateway)

**Files:** `src/billing/credit-service.ts` + gateway tools + credit meter UI.
**Schema (created inline in `CreditService.initTables()`):**

```
credit_ledger (id, org_id, user_id, vendor_slug, credits_used, recorded_at)
credit_blocks (id, org_id, credits, remaining, purchased_at, stripe_payment_intent_id)
```

Already implemented:

- One ledger row per successful vendor `tools/call` (NOT on `tools/list`, NOT on failures, NOT on gateway-internal calls).
- Monthly allocation via `BillingGate.getCreditAllocation(orgId)`:
  - Free: 500 flat.
  - Pro: 2000/seat (member count).
  - Business: 4000/seat pooled.
- Overage-block purchase flow (FIFO depletion via `deductFromBlock`, `FOR UPDATE SKIP LOCKED`).
- `getUsageThisMonth`, `getTotalAvailable`, `hasCreditsRemaining`.
- Gateway tools exposed to agents: `gateway__get_credit_balance`, `gateway__get_usage_summary`, `gateway__list_connections`.
- `GET /api/orgs/:orgId/credits` REST endpoint.
- Settings page credit meter component.
- Credit enforcement on `tools/call` in the unified router (rejects with MCP error when `hasCreditsRemaining === false`).

### 2.3 What Conduit has today (this fork)

- `src/billing/plan-catalog.ts` — **env-driven** plan catalog (JSON from `PLAN_CATALOG` env var, default is `free` + `pro`). This is the right shape for wholesale because it lets us ship a `reseller` plan tier as config, not code.
- `src/billing/gate.ts` — two-plan `DefaultBillingGate` (subset of upstream's three-tier).
- `src/billing/checkout.ts`, `stripe-webhook.ts` — mirrors upstream.
- `migrations/001_customer_tenants.sql` — Azure AD tenant onboarding; NOT related to billing but signals that Conduit already needs a multi-tenant identity surface.
- **No hierarchical org model yet** (no `parent_org_id`, no reseller concept in `organizations`).
- **No credit ledger** yet (not pulled from `feat/credit-ledger`).
- Config already reads `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`.

### 2.4 Upstream sync strategy

Conduit must **adopt**, not duplicate, upstream billing work. The plan:

1. One-time merge of `feat/billing` + `feat/credit-ledger` into Conduit `main` (on a `chore/upstream-sync-billing` branch). Resolve conflicts on `plan-catalog.ts` (keep Conduit's env-driven shape, port upstream's `business` tier defaults and gate methods into the env schema).
2. Add Conduit-specific additions on top (hierarchy, wholesale discount, rollup, suspension cascade — see §4+).
3. Going forward, rebase `chore/upstream-sync-billing` against upstream monthly; Conduit's additions sit in clearly namespaced files (`src/billing/reseller-*.ts`) so they survive rebase cleanly.

---

## 3. Key Decisions & Recommendations

### 3.1 Billing subject hierarchy

> **Decision:** Wyre invoices the MSP reseller org only. Customer sub-orgs have `parent_org_id → reseller_org_id` but **no Stripe customer, no payment method, no subscription** of their own. Customer sub-orgs carry a **`plan` column** (for quota enforcement) and optionally a **`seat_count`** (for usage rollup), but the *subscription row in Stripe* lives at the reseller.

Why: keeps Wyre's AR simple (one Stripe customer per MSP), keeps the MSP in full commercial control of their customers, avoids Stripe Connect complexity.

### 3.2 Wholesale discount mechanism

> **Recommendation:** A **reseller plan tier** that grants a percentage discount on all billable line items rolled up from that MSP's customer sub-orgs, implemented as:
> - A `reseller_plan` on the parent org (distinct from customer plans) — e.g. `reseller_starter`, `reseller_growth`, `reseller_scale`, `reseller_enterprise`.
> - Each reseller plan carries `reseller_discount_pct` (float, 0-1) that is applied to line items on invoice generation.
> - Optional `reseller_min_commit` (monthly minimum dollar commit); if rolled-up usage is below this, the MSP is still billed the commit.
> - Optional `reseller_discount_pct_override` stored directly on the reseller org row for negotiated deals outside the catalog.

This is **preferred over** a flat `reseller_discount_pct` on each subscription, because:

- Tiering encourages MSPs to grow (higher tier → deeper discount → scale flywheel).
- Negotiated one-off discounts are a side-table / override column, not a fork of the catalog.
- Keeps discount logic in one place (line-item transform during invoice assembly).

**Rejected:** per-customer-count tiered discount applied automatically. It conflates volume with discount without a commit, and makes revenue forecasting harder.

### 3.3 Payment method

One payment method, at reseller org only. Customer sub-orgs have no Stripe customer record. The MSP's single Stripe Customer ID lives on the reseller org row.

Supported v1: Stripe Card, Stripe ACH Debit, Stripe Link.
Out of scope v1: wire, check, crypto, Bitcoin-Lightning.

### 3.4 Usage rollup model

> **Decision:** Usage is recorded at the **customer sub-org scope** (existing `credit_ledger.org_id` points at the sub-org). Invoice rollup aggregates by `parent_org_id` at invoice generation time via a SQL join to the `organizations` tree.
>
> Both scopes are queryable:
> - Customer sub-org scope: MSP admin UI + gateway tools show per-customer usage so MSPs can back-compute their own customer invoicing.
> - Reseller scope: Wyre's invoice line items are the sum (with wholesale discount) across all sub-orgs for the period.

### 3.5 Credit model under wholesale

> **Decision:** Credits are **allocated per-customer-sub-org** based on that sub-org's plan, but the **allocation cost** is reflected on the MSP's invoice. Overage blocks are purchasable at **wholesale price** by the MSP and are drawn at either reseller scope (pooled) or customer scope (assigned). Default: pooled at reseller scope, FIFO.
>
> MSP admin UI exposes optional "customer cap" — MSP can throttle a runaway customer sub-org to protect the shared pool.

### 3.6 Dunning cascade

> **Decision:** On Stripe `invoice.payment_failed` for the reseller:
> 1. Mark reseller subscription `past_due`.
> 2. Start a **warning window** (default 7 days, configurable `RESELLER_DUNNING_WARNING_DAYS`).
> 3. All customer sub-orgs see a banner: "Your MSP's billing is past due — service will pause in N days."
> 4. After warning window, if still unpaid, mark reseller `suspended` and **pause all customer sub-org tool calls** (read-only allowed). Gateway tools and vendor `tools/call` return a structured MCP error with an operator-actionable hint.
> 5. On `invoice.paid`: immediate restoration, audit-log event.

---

## 4. Data Model

Builds on the upstream `subscriptions` migration plus Conduit-specific additions.

### 4.1 `organizations` — additions

```sql
-- Conduit adds hierarchy + reseller flags to the existing organizations table.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS parent_org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS org_kind TEXT NOT NULL DEFAULT 'standalone'
    CHECK (org_kind IN ('standalone', 'reseller', 'customer'));
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reseller_plan TEXT;              -- slug into plan catalog, only for org_kind='reseller'
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reseller_discount_pct_override NUMERIC(5,4); -- 0.0000–1.0000; NULL = use plan's default
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reseller_min_commit_cents BIGINT;  -- NULL = no commit
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;         -- non-null → suspended
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orgs_parent ON organizations(parent_org_id)
  WHERE parent_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orgs_reseller ON organizations(org_kind)
  WHERE org_kind = 'reseller';
```

**Invariants:**

- `org_kind='customer' ↔ parent_org_id IS NOT NULL` (customer must have a parent).
- `org_kind='reseller' ↔ parent_org_id IS NULL` (resellers are root).
- Customer sub-orgs must NOT have `stripe_customer_id` or `stripe_subscription_id` set.
- Only reseller orgs may have `reseller_plan`.

Enforced via `CHECK` constraint + application-layer assertions in `OrgService.createOrg`.

### 4.2 `plans` — new table (promoted from env catalog)

```sql
-- Conduit is promoting the env-driven plan catalog to a DB table so resellers
-- can carry per-reseller plan overrides later. The env var continues to seed
-- this table on boot (idempotent upsert) so dev flow isn't broken.

CREATE TABLE IF NOT EXISTS plans (
  slug                      TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  plan_kind                 TEXT NOT NULL CHECK (plan_kind IN ('customer', 'reseller')),
  vendor_limit              INT NOT NULL,           -- -1 = unlimited
  rate_limit_per_hour       INT NOT NULL,
  credit_allocation         INT NOT NULL,           -- per seat or flat (see credit_alloc_kind)
  credit_alloc_kind         TEXT NOT NULL CHECK (credit_alloc_kind IN ('flat', 'per_seat', 'per_customer_seat')),
  max_members               INT NOT NULL,           -- -1 = unlimited
  team_features             BOOLEAN NOT NULL DEFAULT FALSE,
  log_shipping              BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_capture            BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_price_id           TEXT,                   -- NULL for reseller plans priced at runtime
  monthly_price_cents       BIGINT,                 -- retail price; reseller plans may be NULL
  reseller_discount_pct     NUMERIC(5,4),           -- only set when plan_kind='reseller'
  reseller_min_commit_cents BIGINT,
  is_public                 BOOLEAN NOT NULL DEFAULT TRUE,  -- false = invite-only
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plans_kind ON plans(plan_kind);
```

### 4.3 `subscriptions` — inherited from upstream + reseller extension

```sql
-- Upstream's 0001_subscriptions.sql (unchanged core)
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       TEXT NOT NULL,
  stripe_subscription_id   TEXT NOT NULL UNIQUE,
  plan                     TEXT NOT NULL REFERENCES plans(slug),
  status                   TEXT NOT NULL DEFAULT 'active',
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conduit constraint: only reseller or standalone orgs can own a subscription.
-- Customer sub-orgs must NEVER have a subscriptions row.
ALTER TABLE subscriptions
  ADD CONSTRAINT subs_no_customer_subs
  CHECK (TRUE); -- enforced in application layer; add trigger if needed
```

### 4.4 `invoices` — new table

```sql
-- Shadow of Stripe invoices — one row per Stripe invoice, enriched with
-- reseller rollup metadata + per-customer line-item breakdown for support.

CREATE TABLE IF NOT EXISTS invoices (
  id                      TEXT PRIMARY KEY,               -- our own UUID
  reseller_org_id         TEXT NOT NULL REFERENCES organizations(id),
  stripe_invoice_id       TEXT UNIQUE,
  period_start            TIMESTAMPTZ NOT NULL,
  period_end              TIMESTAMPTZ NOT NULL,
  subtotal_cents          BIGINT NOT NULL,
  discount_cents          BIGINT NOT NULL DEFAULT 0,      -- wholesale discount applied
  tax_cents               BIGINT NOT NULL DEFAULT 0,
  total_cents             BIGINT NOT NULL,
  currency                TEXT NOT NULL DEFAULT 'usd',
  status                  TEXT NOT NULL,                  -- mirror stripe: draft, open, paid, void, uncollectible
  hosted_invoice_url      TEXT,
  invoice_pdf_url         TEXT,
  issued_at               TIMESTAMPTZ,
  paid_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_reseller ON invoices(reseller_org_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id                   BIGSERIAL PRIMARY KEY,
  invoice_id           TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_org_id      TEXT REFERENCES organizations(id), -- NULL = reseller-level line (e.g. min commit topup)
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'plan_fee', 'seat_fee', 'credit_overage',
                         'min_commit_topup', 'one_time', 'adjustment', 'discount'
                       )),
  quantity             NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_price_cents     BIGINT NOT NULL,
  amount_cents         BIGINT NOT NULL,
  description          TEXT,
  meta                 JSONB,  -- e.g. {"vendor_slug":"halo","seat_count":12}
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_line_items_customer ON invoice_line_items(customer_org_id);
```

### 4.5 `usage_records` — new table (billable-event shadow of credit_ledger)

The existing `credit_ledger` (from `feat/credit-ledger`) is optimized for per-call writes. For invoice rollup we want an aggregated view per billing period.

```sql
-- Periodic aggregation of credit_ledger for invoice generation.
-- Populated by a nightly job + finalized at period_end.

CREATE TABLE IF NOT EXISTS usage_records (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             TEXT NOT NULL,               -- customer sub-org or reseller
  parent_org_id      TEXT,                        -- denormalized for rollup (NULL for reseller itself)
  period_start       TIMESTAMPTZ NOT NULL,
  period_end         TIMESTAMPTZ NOT NULL,
  metric             TEXT NOT NULL,               -- 'credits','seats','vendor_connections','tool_calls_successful'
  quantity           BIGINT NOT NULL,
  finalized          BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, period_start, period_end, metric)
);

CREATE INDEX IF NOT EXISTS idx_usage_reseller_period
  ON usage_records(parent_org_id, period_end) WHERE parent_org_id IS NOT NULL;
```

### 4.6 `credit_ledger` + `credit_blocks` — inherited, minor additions

The upstream tables stay as-is. Add two columns for reseller pooling:

```sql
ALTER TABLE credit_blocks
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'org'
    CHECK (scope IN ('org', 'reseller_pool'));
ALTER TABLE credit_blocks
  ADD COLUMN IF NOT EXISTS reseller_org_id TEXT REFERENCES organizations(id);

-- When scope='reseller_pool', credit_blocks.org_id = reseller_org_id and any
-- customer sub-org under that reseller may draw from the block.
```

`CreditService.hasCreditsRemaining(customerOrgId)` changes to: check plan allocation → check customer-scoped blocks → check reseller-pool blocks. Deduction order: FIFO across both scopes with a preference for oldest (regardless of scope).

### 4.7 `billing_events` — audit table (new)

```sql
CREATE TABLE IF NOT EXISTS billing_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  event_type  TEXT NOT NULL,   -- 'subscription.created','invoice.paid','dunning.warned','suspension.applied', etc.
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events(org_id, created_at DESC);
```

Every webhook event, dunning tick, suspension, restore is appended here. This is the source of truth for "why is this MSP suspended?" investigations.

---

## 5. Wholesale Discount Engine

### 5.1 Line-item transform

Invoice assembly (monthly cron at period-end + Stripe webhook-driven) runs:

```
for each reseller_org:
  raw_lines = collect_lines(reseller_org, period)
  discount_pct = reseller_org.reseller_discount_pct_override
              ?? plans[reseller_org.reseller_plan].reseller_discount_pct
              ?? 0
  for line in raw_lines:
    if line.kind in (plan_fee, seat_fee, credit_overage):
      discount_amount = round(line.amount_cents * discount_pct)
      append discount line with -discount_amount (kind=discount)
  if sum(raw_lines + discount_lines) < reseller_min_commit_cents:
    append min_commit_topup line = commit - running_total
  push to Stripe as draft invoice with metadata {reseller_org_id, period}
  write invoices row + invoice_line_items rows
```

### 5.2 Discount visibility

- The MSP sees the **discount line** on their invoice PDF (transparency).
- Customer sub-orgs never see discount math — they never see this invoice at all.
- Wyre finance can audit discount rationale via `billing_events.payload.discount_source`.

### 5.3 Retail price basis

Discount applies to the **retail (customer) plan price**, so the math is:
MSP pays: `Σ(customer_plan_retail + overage_retail) × (1 − discount_pct)`, or the `reseller_min_commit`, whichever is higher.

---

## 6. Stripe Integration

### 6.1 Customer creation

- Reseller org creation → eagerly create Stripe Customer with `metadata.org_id` and `metadata.org_kind='reseller'`.
- Customer sub-org creation → **no** Stripe Customer (enforced in `OrgService.createOrg`).

### 6.2 Subscription

- Reseller picks a `reseller_plan` during onboarding.
- Checkout creates a **single Stripe subscription** per reseller with `items=[{price: plans[reseller_plan].stripe_price_id, quantity: 1}]`.
- Customer sub-org plan changes do **not** modify the Stripe subscription; they alter the rollup math for the next invoice.

### 6.3 Metered billing vs fixed + usage invoice-items

> **Decision:** Use a **fixed-base subscription + monthly invoice-items** for usage. Specifically:
> - Fixed monthly base fee for the reseller plan (via subscription).
> - Usage (per-customer plan fees, seat fees, credit overage) added via `stripe.invoiceItems.create({customer, subscription, ...})` before the period closes.
>
> This avoids Stripe's metered-billing quantity cap and lets us attach rich metadata per line-item.

### 6.4 Webhooks handled

Extend upstream's webhook handler for these events:

| Event | Action |
|---|---|
| `checkout.session.completed` | Activate reseller subscription; upsert `subscriptions`, `organizations.plan`, write `billing_events`. |
| `customer.subscription.updated` | Sync plan/status; if `past_due` → start dunning warning; if `active` after `past_due` → restore. |
| `customer.subscription.deleted` | Downgrade to free (retention) + write `billing_events`. **Customer sub-orgs NOT deleted.** |
| `invoice.created` / `invoice.finalized` | Mirror to `invoices` + `invoice_line_items`. |
| `invoice.paid` | Mark `invoices.status='paid'`, clear `past_due`, restore if suspended, write `billing_events`. |
| `invoice.payment_failed` | Enter dunning warning window (per §7). |
| `invoice.payment_action_required` | Notify reseller owner via email. |
| `customer.tax_id.created` / `updated` | Store VAT ID on reseller org. |
| `charge.dispute.created` | Alert Wyre ops via Slack/webhook + mark reseller under review. |

### 6.5 Customer portal

- Reseller can self-service: update card, view invoices, download PDFs.
- Customer sub-orgs **cannot** open a portal (no Stripe Customer).

### 6.6 Trial periods

- 14-day trial on the first checkout for new resellers (`subscription_data.trial_period_days=14`).
- Trial requires a card on file (standard Stripe flow).
- During trial, rolled-up usage accrues as normal but is waived in the first invoice (line item `kind='adjustment'` with negative amount covering the trial subtotal).

### 6.7 Proration

- Mid-period **reseller plan** changes: Stripe default proration.
- Mid-period **customer sub-org plan** changes: Conduit computes proration at line-item level during invoice assembly — Stripe sees only the final aggregated invoice-items.

---

## 7. Dunning & Suspension Cascade

### 7.1 States

| Reseller status | Effect on reseller | Effect on customer sub-orgs |
|---|---|---|
| `active` | Normal | Normal |
| `trialing` | Normal | Normal |
| `past_due` (warning window) | Banner in admin UI + email | Banner: "your MSP's billing is past due — service pauses in N days" |
| `suspended` | Read-only access to admin UI + billing portal | Tool calls blocked (read-only allowed: session list, audit log) |
| `canceled` | Portal access only | Tool calls blocked, credentials retained 30 days then deleted |

### 7.2 Warning window

- `RESELLER_DUNNING_WARNING_DAYS` env var, default 7.
- During window: `tool_calls` still succeed, banners and email fire.
- Day N: `organizations.suspended_at = NOW()` set; gateway router rejects `tools/call` with MCP error code including `upgrade_url` → MSP billing portal.

### 7.3 Restoration

- Successful payment (`invoice.paid` for any open invoice) clears `suspended_at` immediately.
- Audit event written; customer sub-orgs resume tool calls within ~5s (router reads the suspension flag on each request, no long cache).

### 7.4 Cancellation vs suspension

- Cancellation is voluntary (MSP cancels in portal) — service continues until `current_period_end`, then moves to `canceled`.
- Suspension is involuntary (payment failure) — immediate once warning window expires.

---

## 8. Plan Caps & Enforcement

### 8.1 Per-customer caps

Enforced inline by `BillingGate` + `CreditService` (already upstream):

- `getConnectionLimit` — per-user vendor connections.
- `getOrgConnectionLimit` — per-org shared connections.
- `getRateLimit` — requests/hour/vendor.
- `getCreditAllocation` — monthly credits.
- `canUseTeamFeatures`, `canUseToolAllowlists`, `canUseAdvancedFeatures` — feature gates.

### 8.2 Per-reseller aggregate cap (Conduit-new)

Add `ResellerGate` layer that computes:

- `reseller_monthly_credit_cap` (optional, set by MSP owner) — if set, pauses tool calls across **all** customer sub-orgs when reached.
- `reseller_monthly_spend_cap` (optional, in cents) — if projected month-to-date spend exceeds cap, same throttle.

Throttle surface: gateway returns MCP error `reseller_cap_exceeded` with hint to contact MSP admin. MSP admin UI shows which cap was hit and lets them lift it.

### 8.3 MSP-imposed per-customer caps

MSP can override any customer sub-org's plan caps downward (never upward) via admin UI — stored as `organizations.plan_cap_overrides JSONB`. Used to throttle a runaway customer.

---

## 9. Usage Visibility

### 9.1 MSP admin UI (Conduit-new)

- **Reseller dashboard:** month-to-date credits, projected invoice total, breakdown by customer sub-org, top 10 vendors, flagged sub-orgs (>= 80% of plan cap).
- **Per-customer drill-in:** credits, tool calls, vendors used, seats, connections, audit log.
- **Invoice viewer:** list of `invoices` rows with PDF download.

### 9.2 Customer sub-org visibility

- Customer admins see their own usage (not reseller-scope).
- Customer admins do NOT see discount, invoice amounts, or other customers.

### 9.3 APIs

- `GET /api/orgs/:orgId/credits` (inherited).
- `GET /api/reseller/:resellerOrgId/rollup?period=YYYY-MM` — reseller-only; returns aggregated usage + per-customer breakdown.
- `GET /api/reseller/:resellerOrgId/invoices` — list of invoices.
- `GET /api/reseller/:resellerOrgId/customers` — list of customer sub-orgs with summary stats.

All authenticated; reseller-scoped endpoints require `role='owner'` on the reseller org.

---

## 10. Tax

### 10.1 Reseller-level tax

- Enable **Stripe Tax** on the platform Stripe account.
- Collect reseller's billing address + VAT ID during onboarding (or in customer portal).
- Stripe computes VAT/GST automatically on the invoice.
- `invoices.tax_cents` mirrored from Stripe.

### 10.2 Customer-level tax

Out of scope. MSP handles downstream tax compliance to their customers. We surface usage data sufficient for their own invoicing (see §9).

---

## 11. Credits — Wholesale Flow

### 11.1 Allocation

- Each customer sub-org gets plan allocation (free 500, pro 2000/seat, business 4000/seat pooled) — as upstream today.
- **Cost** of that allocation is reflected on the MSP's invoice at the customer plan's retail price × (1 − reseller_discount_pct).

### 11.2 Overage blocks

- MSP buys blocks at **wholesale price** from `/api/reseller/:resellerOrgId/credits/blocks` — Stripe PaymentIntent.
- Block created with `scope='reseller_pool'` and `reseller_org_id=<reseller>`.
- Any customer sub-org under that reseller can draw from the pool (FIFO with org-scoped blocks if present).

### 11.3 Free-to-customer credits

MSP can gift credits to a specific customer sub-org via admin UI — creates a block with `scope='org'` and `org_id=<customer>`, no Stripe payment (free), logged in `billing_events`.

---

## 12. Security & Audit

- All billing endpoints must be authenticated (per project rule).
- Reseller endpoints require `role='owner'` on the reseller org — explicit membership check.
- A user who is a member of a customer sub-org MUST NOT see reseller rollup data. This is enforced via `OrgService.assertNotCrossReseller` on every reseller-scoped query.
- Stripe webhook signature verification is mandatory (already upstream).
- Every webhook + billing action writes to `billing_events` + `audit_log` (Conduit has audit already).
- Wholesale discount override (`reseller_discount_pct_override`) is changeable only by a Wyre super-admin role, not by the reseller themselves.

---

## 13. Configuration

New env vars:

| Env var | Purpose | Default |
|---|---|---|
| `RESELLER_DUNNING_WARNING_DAYS` | Days between `past_due` and `suspended` | `7` |
| `RESELLER_MIN_COMMIT_FALLBACK_CENTS` | Cents used if commit misconfigured | `0` |
| `STRIPE_RESELLER_STARTER_PRICE_ID` | Stripe price for starter reseller plan | — |
| `STRIPE_RESELLER_GROWTH_PRICE_ID` | Stripe price for growth reseller plan | — |
| `STRIPE_RESELLER_SCALE_PRICE_ID` | Stripe price for scale reseller plan | — |
| `STRIPE_TAX_ENABLED` | Enable Stripe Tax on invoices | `true` |
| `WHOLESALE_DEFAULT_CURRENCY` | Default currency for new resellers | `usd` |
| `BILLING_ROLLUP_CRON` | Cron for nightly usage rollup | `15 3 * * *` |

Plan catalog: seeded into the `plans` table on boot from the existing `PLAN_CATALOG` env var (env still wins on conflict during dev; locked after first prod deploy via a flag).

---

## 14. Migration Path

1. Create `chore/upstream-sync-billing` branch; merge upstream `feat/billing` + `feat/credit-ledger` into it.
2. Apply conflicts on `plan-catalog.ts` (keep env-driven shape; port `business` tier fields).
3. Add `parent_org_id` + hierarchy migration; backfill all existing orgs to `org_kind='standalone'`.
4. Add `plans` table; seed from existing env catalog.
5. Add `invoices` + `invoice_line_items` + `usage_records` + `billing_events` tables.
6. Add reseller columns on `organizations`.
7. Add rollup cron; run in shadow mode for first full billing period (log invoices to `billing_events` but do NOT push to Stripe).
8. Cut over: enable Stripe invoice-item pushes; first production invoice cycle.

---

## 15. Acceptance Criteria

1. A new reseller org can sign up via checkout, pick a `reseller_plan`, and complete Stripe Checkout with a test card; the resulting subscription and invoice are visible in the `subscriptions` and `invoices` tables.
2. A reseller admin can create a customer sub-org with `org_kind='customer'` and `parent_org_id` set to the reseller. Attempting to set `stripe_customer_id` on a customer sub-org raises an error.
3. A customer sub-org user making a vendor `tools/call` writes exactly one `credit_ledger` row with `org_id` = customer sub-org id.
4. Monthly rollup cron aggregates `credit_ledger` into `usage_records` by `org_id` and `parent_org_id` and finalizes rows at period-end.
5. Invoice assembly produces a Stripe invoice for the reseller with line items per customer sub-org and a single `discount` line reflecting `reseller_discount_pct`. Total equals retail − discount + tax, and ≥ `reseller_min_commit_cents` if set.
6. `invoice.payment_failed` webhook moves the reseller to `past_due`, writes a `billing_events` row, and emails the reseller owner.
7. After `RESELLER_DUNNING_WARNING_DAYS`, `organizations.suspended_at` is set and all customer sub-orgs under that reseller get MCP error `reseller_suspended` on `tools/call`. `tools/list` still succeeds.
8. `invoice.paid` restores the reseller within 5s of webhook processing; customer sub-orgs immediately resume tool calls.
9. A reseller-pool `credit_blocks` row with `scope='reseller_pool'` is drawn down FIFO when any customer sub-org under that reseller exhausts plan allocation.
10. `GET /api/reseller/:resellerOrgId/rollup?period=YYYY-MM` returns accurate aggregation matching the invoice line items; returns 403 for a non-owner; returns 403 for a user who is only a member of a customer sub-org.
11. `GET /billing/plans` exposes plans with `plan_kind='customer'` to all; `plan_kind='reseller'` plans are only returned to authenticated reseller-org owners.
12. Stripe Tax adds VAT on the invoice for an EU-billing-address reseller; `invoices.tax_cents` matches.
13. A Wyre super-admin can set `reseller_discount_pct_override` via an internal admin endpoint; this overrides the catalog discount on the next invoice. A normal reseller user cannot change this field (403).
14. Webhook signature verification rejects an unsigned or mis-signed payload (400); valid payloads create a `billing_events` row.
15. A customer sub-org user attempting `POST /api/billing/checkout` for their sub-org receives 403 with message "billing managed by your MSP".

---

## 16. Open Questions

1. **Stripe Connect vs. direct charges?** Current plan: direct charges against Wyre's platform account, MSP is a normal Stripe Customer. If in future we want to support MSPs who want Wyre to collect from their customers on their behalf with automatic payout, we'd move to Stripe Connect (Express or Custom). **Decision: direct charges for v1.** Flag open for a future `billing-msp-payouts` tag.
2. **Multi-currency**: reseller plan is USD-only in v1. When do we enable EUR/GBP? Requires `plans.monthly_price_cents_by_currency JSONB`.
3. **Annual billing**: do we offer 10–15% discount for annual prepay of a reseller plan? Probably yes (B2B standard), but needs a `stripe_price_id_annual` column and a checkout toggle.
4. **Customer sub-org seat counting**: does a seat on a customer sub-org always bill back to the MSP, or can the MSP set `seat_billing_model='pooled'` where only distinct active-users-per-month count? Current design: per-seat by default; pooled is future.
5. **Trial**: 14 days default. Does the trial waiver also cover rolled-up customer sub-org usage during the trial, or only the base reseller plan fee? Leaning: waive everything, capped at a max-dollar-value (e.g. $500 max trial waiver to prevent abuse).
6. **Chargebacks / disputes**: when a dispute hits, does Conduit auto-suspend? Current design: flag but don't suspend (manual ops decision). Confirm with Wyre finance.
7. **Negative usage adjustments**: when Wyre comps an MSP for a downtime SRE incident, is that an invoice_line_item `kind='adjustment'` with a Stripe coupon, or a manual invoice credit note? Probably coupon for small, credit-note for large. Needs SOP.
8. **Delete cascade on reseller cancellation**: if MSP cancels, what happens to customer sub-org data? Currently: retained 30 days then deleted. Reseller should be able to export everything before cancellation. Needs `/api/reseller/export` endpoint (scope for a sibling `data-export` tag).
9. **What breaks if a customer sub-org is moved to a different reseller?** (acquisition scenarios). Probably disallow in v1; enterprise ops manual.
10. **White-label invoice PDFs**: do MSPs want invoices branded with MSP-style language, not "Wyre"? Out of scope v1 — Wyre's name is on the invoice. Flag for `branding` PRD.

---

## 17. Non-Goals / Explicit Out-of-Scope Reminder

- No direct billing between Conduit and end customers.
- No Stripe Connect payouts to MSPs.
- No MSP→customer invoicing in Conduit UI (MSP uses their own PSA/billing).
- No real-time seat re-metering mid-period (settle at period boundary).
- No crypto / wire / check payments v1.
- Upstream's two- then three-tier free/pro/business model is a **starting point** — wholesale tiers are additive, not a replacement.

---

## 18. Proposed Task List

Targeted at taskmaster parse. Each bullet should become one top-level task; subtasks derived during `expand`.

1. **Upstream sync — merge `feat/billing` and `feat/credit-ledger` into Conduit** on `chore/upstream-sync-billing`; resolve `plan-catalog.ts` conflicts preserving env-driven shape; get CI green.
2. **Promote plan catalog to `plans` table** with `plan_kind` column; seed from existing `PLAN_CATALOG` env var on boot; migrate `DefaultBillingGate` to read from `plans`.
3. **Add hierarchical org model**: `parent_org_id`, `org_kind`, check constraints, `OrgService.createCustomerOrg`, `OrgService.getResellerTree`; assert no Stripe customer on customer sub-orgs.
4. **Add reseller columns to `organizations`**: `reseller_plan`, `reseller_discount_pct_override`, `reseller_min_commit_cents`, `suspended_at`, `suspended_reason`.
5. **Wire `subscriptions` table** into `OrgService.initTables()`; make `subscriptions` authoritative, `organizations.plan` a webhook-synced cache; extend webhook handler to update both atomically.
6. **Implement reseller checkout flow**: new onboarding UI that picks `reseller_plan`; adapt `/api/billing/checkout` to require `org_kind in ('standalone','reseller')`; block customer sub-orgs (403).
7. **Invoice assembly cron** (`BILLING_ROLLUP_CRON`): nightly rollup of `credit_ledger` → `usage_records`; at period-end, produce `invoice_line_items` + wholesale discount line + min-commit topup; push to Stripe as invoice-items.
8. **Invoice + line-item tables + shadowing webhooks** (`invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`): mirror to `invoices` + `billing_events`.
9. **Dunning cascade**: `past_due` → warning emails + banners → suspension after `RESELLER_DUNNING_WARNING_DAYS`; integrate with gateway router to reject `tools/call` on suspended reseller chain.
10. **Reseller credit pool**: add `scope` + `reseller_org_id` to `credit_blocks`; update `CreditService.hasCreditsRemaining` + `deductFromBlock` to draw from pool for any customer sub-org; admin UI for MSP to buy pool blocks at wholesale.
11. **Reseller aggregate caps**: `reseller_monthly_credit_cap` + `reseller_monthly_spend_cap`; router-layer enforcement with MCP error `reseller_cap_exceeded`.
12. **Reseller usage APIs**: `GET /api/reseller/:id/rollup`, `GET /api/reseller/:id/invoices`, `GET /api/reseller/:id/customers`; role-owner gating; cross-reseller isolation tests.
13. **MSP admin dashboard UI**: reseller rollup view, per-customer drill-in, invoice list, pool-balance widget.
14. **Stripe Tax enablement** + VAT ID collection in onboarding + customer portal; mirror `invoices.tax_cents`.
15. **Wyre super-admin override endpoint** for `reseller_discount_pct_override`; internal-only auth gate; audit-logged.
16. **Acceptance test suite** covering §15 criteria end-to-end against a Stripe test-mode account (fixtures: reseller, 3 customers, test cards for success/fail/dispute).
