# Spec: Default Customer Tier Selection at Provisioning

Status: Draft addendum to `onboarding` PRD §5.3
Date: 2026-04-18
Tag: `pricing-decision`
Task: #8
Hands off to: `onboarding` PRD §5.3, §5.4; `billing-wholesale` PRD §4.2, §5
Resolves: pricing-decision PRD §0.5.4.4 / AC-4

---

## 1. Purpose

Define how an MSP admin selects a plan tier when provisioning a new customer sub-org in the Funnel B "Add Customer" flow (`onboarding` PRD §5.3), what the default selection is, how MSPs can override that default globally, and what guardrails prevent misconfiguration.

Scope: UI selection, reseller-level default override, guardrails, billing handoff. Does **not** cover credit allocation (see `spec-credit-pooling.md`) or discount math (see `pricing-proposal-discount-schedule.md`).

---

## 2. Provisioning UX

### 2.1 Dropdown in Add Customer form

`onboarding` §5.3 already specifies a `plan` field. This spec tightens it:

- **Control type:** single-select dropdown (not radio tiles — tiles are for end-user pricing pages).
- **Options:** `Free`, `Pro`, `Business`. Presented in that order.
- **Default selection:** **Pro** (unless reseller-level override is set — see §3).
- **Each option shows inline:**
  - Tier name
  - Retail list price per user / mo (for MSP awareness; the MSP is billed wholesale, but retail is the anchor for their own markup)
  - Key feature line
  - Credit allocation

Example rendered option (mid-dropdown):

```
Pro — $49/user/mo retail  (you pay $34.30/seat wholesale)
1,500 credits per seat / mo · up to 3 users · team roles & invites
```

- **Help link:** "Which tier should I pick?" → opens inline modal with a short decision tree (copy in §6).
- The dropdown is required; no empty state.
- On select, the form updates a secondary panel showing projected MSP cost for this customer at their current seat count (reseller_discount_pct applied).

### 2.2 Seat count entry

Conditional on tier:

- Free: seat count locked at 1 (non-editable input, label "Free is single-user").
- Pro: seat count editable 1–3, default 1. Validation error if > 3 ("Pro supports up to 3 users. Upgrade to Business for more.").
- Business: seat count editable, minimum 5, default 5. Validation error if < 5 ("Business requires 5+ seats.").

Seat count at provisioning is a planning hint; upstream billing is driven by actual `organizations.plan_seats` at invoice close (per `billing-wholesale` §4.3).

### 2.3 Draft state

Per `onboarding` §5.3, `send_invite_now=false` allows creating the sub-org in draft. Draft customers still have a committed `plan` — billing does not start until the customer admin accepts the invite and the subscription is activated. This is consistent with `billing-wholesale` §6.2 (subscription created at activation, not provisioning).

---

## 3. Reseller Configuration Override

### 3.1 `default_customer_plan` setting

New column on `organizations` (for resellers only — constraint `kind='reseller'`):

```sql
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS default_customer_plan TEXT NOT NULL DEFAULT 'pro'
    CHECK (default_customer_plan IN ('free', 'pro', 'business'));
```

- Editable in reseller admin settings: **Settings → Customers → Default plan for new customers**.
- Changes apply to subsequent Add Customer flows; does not retroactively modify existing customer sub-orgs.
- Single-field form, immediate save, toast on success.
- Audit-logged via `billing_events` with `event_type='reseller_setting_changed'`.

### 3.2 Per-form override

The MSP admin can always change the plan in the Add Customer dropdown — the reseller default only pre-selects it. No "locked default" mode in v1.

---

## 4. Guardrails

### 4.1 Reseller-plan capability gating

Per pricing-decision PRD §0.5.4.4 and aligned to the open question in `pricing-proposal-discount-schedule.md` §7 question 4, some MSPs may not be authorized to resell every retail tier. Guardrail implementation:

- New column on `plans` table (the reseller-plan catalog side — `billing-wholesale` §4.2):
  ```sql
  ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS allowed_customer_plans TEXT[] NOT NULL DEFAULT ARRAY['free','pro','business'];
  ```
- For v1 with a single `reseller_standard` plan (per `pricing-proposal-discount-schedule.md` §6), `allowed_customer_plans = ['free','pro','business']` — all three. This is effectively a no-op gate in v1, but the column exists so that future wholesale plans can restrict (e.g., a hypothetical `reseller_entry` tier that only resells Pro, not Business).
- The Add Customer dropdown filters options to the intersection of `{free, pro, business}` and the reseller's `allowed_customer_plans`.
- Server-side validation on POST rejects a tier outside the allowed set with a 400 and a message identifying which tier was rejected and why.

### 4.2 Seat-count guardrails

Already covered in §2.2; repeated here for completeness of server-side validation:

- Free → `plan_seats = 1` enforced.
- Pro → `1 ≤ plan_seats ≤ 3` enforced.
- Business → `plan_seats ≥ 5` enforced.

Server rejects violations with 400 and the offending field name.

### 4.3 Reseller subscription status

If the reseller's own subscription is in `past_due`, `grace`, or `suspended` state (per `billing-wholesale` §7.1), block new customer provisioning entirely. Return 403 with message "Your reseller subscription is past due. Add a payment method to provision new customers." This prevents accruing new billable customers under a delinquent reseller.

### 4.4 Free-tier abuse

Unrestricted Free provisioning creates an abuse vector: an MSP could provision hundreds of Free customers to game partner-level metrics or resell Free-tier access cheaply. Soft guardrail: a reseller may have **at most 3× more Free customers than paid customers**. Hitting the ratio shows a soft warning in the UI; a hard limit can be configured per reseller by Wyre internal ops via `reseller_discount_pct_override` -adjacent admin tools. Default: warn-only in v1.

---

## 5. Billing Implication

Successful provisioning runs the transaction in `onboarding` §5.4. The billing handoff works as follows:

1. `organizations.plan_id` is set to the selected tier's plan id.
2. A `subscriptions` row is created (or scheduled to be created on customer activation) with:
   - `org_id = <customer_sub_org_id>`
   - `stripe_customer_id = <reseller's Stripe customer>` (per `billing-wholesale` §3.1, the reseller is the billing subject)
   - `stripe_subscription_id`: either a new Stripe subscription, or a line added to the reseller's existing aggregated subscription — implementation detail per `billing-wholesale` §6.2.
   - `price_id = <plan.stripe_price_id>` at list
   - Discount applied per the reseller's `reseller_plan.reseller_discount_pct` per `pricing-proposal-discount-schedule.md` Option A (30% off seats).
3. For **Free** tier specifically, no `subscriptions` row is created. The customer sub-org still exists, still has a `plan_id` pointing to the Free plan, but no Stripe billing relationship. See §5.1.
4. Trial: if the customer is provisioned into a Business plan and is the reseller's first Business customer, Wyre's 30-day Business trial (pricing-decision PRD §0.5.1) may apply. Implementation defers to `billing-wholesale` §6.6.

### 5.1 Free-tier caveat

- Free customers have `subscriptions.stripe_subscription_id = NULL` — no Stripe artifact.
- Free customers still write `usage_records` per tool call (for analytics and abuse-detection).
- Free customers still count toward any reseller per-customer limit if one is imposed (`billing-wholesale` §8.2 aggregate caps). That is: the MSP cannot hide seat counts by provisioning Free.
- Free customers consume from their own 500-credit allocation (per `spec-credit-pooling.md` §2.1) and, if exhausted, fall through to the reseller pool if one exists (per `spec-credit-pooling.md` §7.5).
- Free customers cannot be silently "upgraded" by the MSP — changing plan from Free to Pro/Business requires an explicit UI action that warns "this will begin billing your Stripe account" and is logged.

---

## 6. UX Copy

### 6.1 Dropdown header helper

> **Choose a plan for this customer.** You pay the wholesale rate; your customer sees whatever retail price you set on your own invoice. You can change this tier later.

### 6.2 Option subtext

- **Free** — $0 · 1 user · 500 credits / mo · for trial customers or pilots you aren't billing yet.
- **Pro** — $49/user/mo retail (you pay $34.30/seat) · up to 3 users · 1,500 credits per seat · best for small teams.
- **Business** — $99/user/mo retail (you pay $69.30/seat) · 5+ users · 4,000 credits per seat · audit log, log shipping, service clients.

(Wholesale rates shown assume Option A flat 30% discount per `pricing-proposal-discount-schedule.md`. If discount changes, this copy is templated off `reseller_plan.reseller_discount_pct` — do not hard-code.)

### 6.3 "Which tier should I pick?" modal

> - Picking for a **pilot or evaluation** customer? → Free.
> - Customer has **a small team (up to 3)** and needs basic collaboration? → Pro.
> - Customer needs **5+ seats, audit logs, or compliance features**? → Business.
>
> You can always upgrade later. Downgrades are supported at the next billing cycle.

### 6.4 Dropdown validation errors

- Tier-higher-than-reseller-plan-supports: "Your reseller plan doesn't include Business tier. Contact Wyre to upgrade, or pick Pro."
- Seat count below minimum: "Business requires at least 5 users. Reduce to Pro or increase seat count."
- Reseller past_due: "Your subscription is past due. Settle your balance to provision new customers." (Shown before the form is reached — at `/admin/customers/new` load.)

---

## 7. Acceptance Checks (append to `onboarding` §7 or §10)

- Default dropdown selection on a fresh reseller is **Pro**.
- Changing reseller `default_customer_plan` to `business` makes subsequent Add Customer forms default to Business.
- Selecting Pro with seat count > 3 is rejected server-side with 400.
- Selecting Business with seat count < 5 is rejected server-side with 400.
- A reseller whose wholesale plan has `allowed_customer_plans = ['free','pro']` cannot submit a Business customer; dropdown filters Business out and server-side also rejects.
- Provisioning a Free customer creates the sub-org with no `subscriptions` row.
- Provisioning a Pro customer creates a `subscriptions` row billed to the reseller's Stripe customer at the wholesale discount from `reseller_plans`.
- Reseller in `past_due` state cannot reach the Add Customer form.

---

## 8. Out of Scope / Deferred

- Custom plan tiers beyond {Free, Pro, Business} — deferred to any future white-label work.
- MSP-set retail price on the customer sub-org — see pricing-decision PRD §0.5.4.2 (markup policy is free-form, off-platform in v1).
- Self-service upgrade by the customer admin — v2 (currently all plan changes are reseller-mediated).
- Annual / commitment plans — deferred per pricing-decision PRD §0.5.4.5.

---

*End of spec.*
