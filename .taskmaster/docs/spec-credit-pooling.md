# Spec: Credit Pooling Behavior Under Wholesale

Status: Draft addendum to `billing-wholesale` PRD §4.6 and §11
Date: 2026-04-18
Tag: `pricing-decision`
Task: #7
Hands off to: `billing-wholesale` PRD §4.6, §11, §14 task 10
Resolves: pricing-decision PRD §0.5.4.3 / AC-3

---

## 1. Purpose

The `billing-wholesale` PRD establishes that credit blocks (`credit_blocks`) already exist upstream and that Conduit extends the schema with a `scope` column (see `billing-wholesale` §4.6 lines 346–352). This spec defines the runtime behavior of that scope: when credits are deducted, in what order, with what audit trail, and how MSP admins interact with the pool.

**Terminology note.** The existing `billing-wholesale` PRD §4.6 uses `scope IN ('org', 'reseller_pool')`. The pricing-decision task brief uses `scope IN ('customer', 'reseller_pool')`. This spec adopts **`'org'` and `'reseller_pool'`** to stay consistent with the already-drafted schema in `billing-wholesale`. Semantically `'org'` = customer-sub-org-scoped, which covers the brief's intent. Any future rename should update both PRDs in lockstep.

---

## 2. Default Behavior — Per-Customer (scope='org')

### 2.1 Allocation

- Every paid customer sub-org has a monthly plan allocation:
  - Pro: 1,500 credits per seat per month (pooled across the sub-org's seats).
  - Business: 4,000 credits per seat per month (pooled across the sub-org's seats).
  - Free: 500 credits flat per month (not per-seat).
- Allocation is created as a synthetic `credit_blocks` row at subscription-period start:
  - `scope = 'org'`
  - `org_id = <customer_sub_org_id>`
  - `credits = <plan_monthly_total>`
  - `remaining = <plan_monthly_total>`
  - `purchased_at = <period_start>`
  - `expires_at = <period_end>` (plan credits do not roll over)
  - `stripe_payment_intent_id = NULL` (synthetic allocation, not a purchase)
  - `source = 'plan_allocation'` (new nullable column or tag in `billing_events`)

### 2.2 Deduction

Each billable tool call deducts 1 credit per the existing `CreditService.deductFromBlock` logic. The upstream implementation selects the oldest unexpired block for the org; Conduit preserves this within `scope='org'` as the first-pass rule.

### 2.3 Overage

When the `scope='org'` blocks are exhausted, the default upstream behavior is to bill overage to the customer's own Stripe customer record. **Under wholesale, the customer has no Stripe customer record** (per `billing-wholesale` §3.1 — the reseller is the billing subject). Behavior diverges here — see §3.

---

## 3. Optional Reseller-Pool Behavior (scope='reseller_pool')

### 3.1 What it is

An MSP reseller may purchase credit blocks **in advance** at the wholesale overage rate ($7.50 / 1,000 credits per `pricing-proposal-discount-schedule.md`, 25% off the $10 list). These blocks are owned by the reseller, not any single customer sub-org, and drain automatically on behalf of any customer sub-org under that reseller whose plan credits are exhausted.

### 3.2 Schema (aligned to `billing-wholesale` §4.6)

```sql
ALTER TABLE credit_blocks
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'org'
    CHECK (scope IN ('org', 'reseller_pool'));
ALTER TABLE credit_blocks
    ADD COLUMN IF NOT EXISTS reseller_org_id TEXT REFERENCES organizations(id);
-- Existing org_id column is reused:
--   scope='org'           → org_id = customer sub-org id, reseller_org_id = NULL (or same-as-parent for convenience)
--   scope='reseller_pool' → org_id = reseller org id,     reseller_org_id = reseller org id (denormalized for faster lookup)
CREATE INDEX IF NOT EXISTS idx_credit_blocks_reseller_pool
    ON credit_blocks(reseller_org_id, expires_at)
    WHERE scope = 'reseller_pool' AND remaining > 0;
```

### 3.3 Reseller-pool block creation

- Purchased via Stripe Checkout from MSP admin UI (`billing-wholesale` §14 task 10).
- Priced at wholesale rate per the discount schedule (Option A: $7.50 / 1,000 credits).
- Written with:
  - `scope = 'reseller_pool'`
  - `org_id = <reseller_org_id>`
  - `reseller_org_id = <reseller_org_id>`
  - `credits = <purchased_amount>`
  - `remaining = <purchased_amount>`
  - `purchased_at = NOW()`
  - `expires_at = purchased_at + INTERVAL '90 days'` (see §5 edge case — survives MSP subscription cancellation for 90 days)
  - `stripe_payment_intent_id = <real PI>`

### 3.4 MSP gift blocks (also scope='org')

`billing-wholesale` §11.3 notes that MSPs may gift credits to a specific customer. Those are written with `scope='org'`, `org_id=<customer>`, `stripe_payment_intent_id=NULL`, `source='msp_gift'`. These behave identically to plan allocations from the deduction engine's perspective and are drawn strictly before reseller-pool.

---

## 4. Deduction Algorithm — FIFO with Scope Fallback

Given a deduction request of N credits for customer sub-org C under reseller R:

```
1. blocks_customer = SELECT * FROM credit_blocks
                     WHERE scope = 'org' AND org_id = C
                           AND remaining > 0
                           AND (expires_at IS NULL OR expires_at > NOW())
                     ORDER BY purchased_at ASC, id ASC  -- FIFO, id as tiebreak
2. For each block in blocks_customer:
     take = min(block.remaining, remaining_needed)
     block.remaining -= take
     remaining_needed -= take
     write credit_ledger row (org_id=C, block_id=block.id, scope='org', amount=-take)
     if remaining_needed == 0: return

3. # Customer plan + gifts exhausted. Check reseller pool.
   blocks_pool = SELECT * FROM credit_blocks
                 WHERE scope = 'reseller_pool' AND reseller_org_id = R
                       AND remaining > 0
                       AND (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY purchased_at ASC, id ASC
4. On first draw from pool for this deduction cycle, emit a scope-transition event:
     billing_events INSERT (
       event_type='credit_scope_transition',
       reseller_org_id=R,
       customer_org_id=C,
       from_scope='org',
       to_scope='reseller_pool',
       ts=NOW(),
       metadata={trigger_block_id: <first pool block id>}
     )
5. For each block in blocks_pool:
     take = min(block.remaining, remaining_needed)
     block.remaining -= take
     remaining_needed -= take
     write credit_ledger row (org_id=C, block_id=block.id, scope='reseller_pool',
                              reseller_org_id=R, amount=-take)
     if remaining_needed == 0: return

6. # Both pools exhausted. Trigger overage billing on the reseller per billing-wholesale §11.2.
   emit billing_events row event_type='credit_exhausted' and hand to metered-overage path.
```

### 4.1 FIFO rationale and concern

FIFO ensures the oldest paid credits are consumed first, which is the industry-standard expectation and matches upstream behavior.

**Concern (surface to leadership):** Because plan-allocation blocks expire at period end (§2.1 `expires_at = period_end`), and reseller-pool blocks live for 90 days from purchase, there is a corner case at **period boundary** where a long-running customer operation spanning 23:59:59 → 00:00:00 UTC could:

- Start by drawing from the period-N `scope='org'` allocation.
- The allocation expires at period-N end (midnight).
- At period-N+1 start, a new `scope='org'` allocation is created with a new `purchased_at`.
- If a reseller_pool block exists with `purchased_at` earlier than the new allocation, FIFO-by-purchased_at would draw from the **pool** before the **new plan allocation**, which is wrong (plan credits are "free" to the MSP in the sense they're already paid via subscription and should be used first).

**Recommended resolution:** Change the ORDER BY in step 1 *and* make the scope-precedence rule explicit: always exhaust `scope='org'` before checking `scope='reseller_pool'`, regardless of `purchased_at` comparison across scopes. FIFO applies **within scope**, not across. The algorithm above already encodes this (steps 1–2 are scope='org' only, steps 3–5 are scope='reseller_pool' only, so the cross-scope FIFO bug cannot arise). Worth documenting explicitly so future refactors don't collapse the two queries into one ORDER BY.

### 4.2 Concurrency

Deduction must be atomic to prevent double-spend when multiple tool calls from the same sub-org hit the service simultaneously. Upstream uses row-level `SELECT ... FOR UPDATE` on `credit_blocks` within a transaction. Conduit inherits this. The only Conduit-new consideration: the reseller-pool path must also `FOR UPDATE` the selected pool block, and since multiple customer sub-orgs share the pool, contention is higher. For large MSPs (dozens of customers) consider advisory-lock on `reseller_org_id` or partitioned pool blocks.

---

## 5. Audit Trail

Every credit deduction writes a row to `credit_ledger` (upstream) with Conduit additions:

| Column | Meaning |
|---|---|
| `id` | ledger entry id |
| `org_id` | customer sub-org consuming the credit (always the sub-org, even if drawn from pool) |
| `block_id` | which `credit_blocks` row was decremented |
| `scope` | `'org'` or `'reseller_pool'` — redundant with block.scope but denormalized for query speed |
| `reseller_org_id` | set when scope='reseller_pool' so reseller dashboards can roll up without join |
| `amount` | negative integer (credits debited) |
| `ts` | timestamp |
| `request_id` | correlates with the originating tool call |

Scope transitions are additionally logged to `billing_events` (one row per customer-sub-org per billing period the *first* time a pool draw happens) per step 4 of the algorithm. Example:

```json
{
  "event_type": "credit_scope_transition",
  "reseller_org_id": "org_msp_abc",
  "customer_org_id": "org_cust_xyz",
  "from_scope": "org",
  "to_scope": "reseller_pool",
  "ts": "2026-05-14T23:05:17Z",
  "metadata": {
    "trigger_block_id": "blk_9f2a",
    "customer_plan": "pro",
    "remaining_pool_credits_before": 47500
  }
}
```

This lets the MSP dashboard surface "your customer Acme Corp started drawing from your pool on May 14" without scanning the whole ledger.

---

## 6. MSP Admin UI Implications

Builds on `billing-wholesale` §9.1 (MSP admin UI usage panels) and `msp-admin` PRD customer-detail views. Additions:

- **Reseller-pool balance widget** on MSP admin home:
  - Current remaining credits across unexpired pool blocks.
  - Burn rate (credits / day over last 7 days drawn from pool).
  - Projected days remaining at current burn.
  - "Buy more" CTA linking to Stripe Checkout for additional pool blocks.
- **Threshold alerts** (MSP-configurable):
  - Email / webhook when pool drops below `X%` of last purchase (default 20%).
  - Email / webhook when any single customer sub-org exceeds `Y credits / day` drawn from pool (default off, opt-in abuse signal).
- **Per-customer view** shows scope breakdown: "this customer used 1,200 plan credits + 340 reseller-pool credits this month."
- **Pool block inventory table**: list each pool block, purchase date, expiry, remaining. Expiring-soon highlight at 14 days.

---

## 7. Edge Cases

### 7.1 MSP cancels reseller subscription with unused pool blocks

**Behavior:** Existing reseller-pool blocks continue to drain until either:
- `remaining == 0`, or
- `expires_at` (90 days from purchase) is reached, whichever comes first.

After subscription cancellation, the MSP's downstream customer sub-orgs also lose active reseller status (per `billing-wholesale` §7), so in practice the blocks drain rapidly or not at all. No refund of unused credits on cancellation — credits are a prepaid consumable, not a deposit.

Implementation: the deduction algorithm only checks `scope='reseller_pool' AND reseller_org_id=R AND remaining > 0 AND expires_at > NOW()`. It does not check the reseller's subscription status. This is deliberate: the credits are paid-for inventory.

### 7.2 MSP cancels mid-cycle, customer sub-org still active

Customer sub-orgs are suspended alongside the reseller per `billing-wholesale` §7.2 (suspension cascade). In the grace window, they can still consume credits, which draw from their `scope='org'` allocation first and pool second — same algorithm.

### 7.3 Customer sub-org is migrated between resellers

Not a v1 supported flow. Flag as out-of-scope. If ever supported, rule is: plan-allocation blocks travel with the customer (still `scope='org'` for that sub-org), pool blocks remain with the original reseller.

### 7.4 Pool block partial draw at expiry

If a pool block expires with `remaining > 0`, the remaining credits are **forfeited**. Ledger entry of type `credit_expiry` with negative amount = remaining, `block_id=<expired block>`. MSP is notified via `billing_events` so they can adjust purchasing cadence.

### 7.5 Customer sub-org on Free plan draws from pool

Free plan gives 500 flat credits. If the MSP has configured the customer as Free but an active pool exists, do Free-plan customers fall back to pool when their 500 are exhausted, or do they hit a hard cap?

**Recommendation:** Yes — fall back to pool, same as any other sub-org. Pool is reseller's money; reseller chose to provision the customer and can decide whether to stop them. If the MSP wants a hard cap on a Free customer, use the per-customer cap feature (`billing-wholesale` §8.3). Default behavior: drain the pool if the MSP hasn't set a cap.

### 7.6 Refund of a pool block purchase

Stripe refund of a pool-block payment intent invalidates the block: set `remaining=0`, `expires_at=NOW()`, write `billing_events` row `event_type='credit_block_refunded'`. If credits from the block had already been consumed, the refund is partial (credits consumed × wholesale rate remains billed). Not unique to wholesale — Conduit inherits whatever refund policy upstream defines.

### 7.7 Race: purchase and draw simultaneously

MSP buys a new pool block at T, a customer's deduction hits at T+10ms. The new block is visible only after the Stripe payment_intent succeeds and the block row is inserted and committed. If deduction loses the race, the customer hits overage (step 6) rather than the new block. Acceptable — the race window is small and deduction is retried on the next tool call.

---

## 8. Acceptance Checks (append to `billing-wholesale` §15)

- Given a customer sub-org with plan credits remaining, tool calls deduct from `scope='org'` blocks FIFO. Verified by credit_ledger rows with scope='org'.
- Given a customer sub-org with plan credits exhausted and an active reseller-pool block, tool calls deduct from the pool. Verified by credit_ledger rows with scope='reseller_pool' and a `credit_scope_transition` billing_event.
- Given a reseller with a cancelled subscription but active pool blocks (unexpired), tool calls from their customer sub-orgs still draw from the pool until empty or 90-day expiry.
- Given a pool block expiring with remaining > 0, the remaining amount is forfeited and a `credit_expiry` ledger row is written.
- Concurrency: 50 parallel deductions against a single pool block with `remaining=25` leave `remaining=0` and produce exactly 25 successful + 25 overage-bound deductions, never 30/20 or any over-draw.

---

## 9. Open Question

**Should pool blocks be spendable across resellers in a white-label / parent-reseller hierarchy?**
Current spec: no. `reseller_org_id` is strictly scoped to one reseller org. If we ever introduce multi-level reseller trees (a distributor owning many MSPs — hinted at but out-of-scope in `reseller-tenancy` PRD), this rule needs revisiting. Flag for v2.

---

*End of spec.*
