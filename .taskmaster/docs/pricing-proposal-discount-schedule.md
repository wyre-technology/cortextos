# Pricing Proposal: Wholesale Discount Schedule

Status: Draft for leadership review
Date: 2026-04-18
Owner: Conduit / Pricing
Tag: `pricing-decision`
Task: #2
Hands off to: `billing-wholesale` §3.2, §5, §11; `pricing-decision` PRD §0.5.4.1

---

## Executive Summary (1 page)

Conduit inherits the upstream mcp-gateway retail tier structure (Free / Pro $49 / Business $99, 1,500–4,000 credits per seat, overage $10 / 1,000). The open question is **what wholesale discount MSP resellers receive** when they pay Wyre and resell the platform to their own SMB customers. Three candidate schedules have been modeled:

- **Option A — Flat discount (RECOMMENDED for v1).** 30% off Pro and Business per-seat list, 25% off credit overage blocks. Wholesale Pro seat = **$34.30/mo**; Wholesale Business seat = **$69.30/mo**; wholesale overage = **$7.50 / 1,000 credits**. Simple, one number per SKU, no tier boundaries to argue about, easy to encode in `reseller_plan` table.
- **Option B — Tiered by active customer count.** 20% / 30% / 40% brackets at 1–10 / 11–50 / 51+ customers. Rewards MSPs for scale but introduces cliff effects, ops complexity (monthly reclassification), and perverse incentives around customer count reporting.
- **Option C — Volume commit.** MSP pre-commits $2,500 / $10,000 / $25,000 per month and receives 25% / 35% / 45% discount with unused commit rolling to reseller-pool credits. Best margin for committed partners; worst UX for smaller MSPs and early pilots. Requires contract infrastructure we do not have.

**Recommendation:** Ship **Option A** at launch. It is the PRD's stated default (§0.5.4.1) and is defensible on three grounds: (1) 30% flat sits squarely inside the 25–40% band that is standard for SaaS channel programs; (2) it is trivial to implement against the existing `reseller_plans.reseller_discount_pct` column already specified in `billing-wholesale` §4.2; (3) it is easily upgraded — nothing in Option A forecloses introducing tiers (Option B) or commits (Option C) later if pilot MSPs push back.

At 30% flat, Wyre retains **$34.30 / Pro seat / mo** and **$69.30 / Business seat / mo** gross margin pre-COGS. A representative 10-customer MSP (2 seats Pro each, 20 seats total, modest overage) generates **~$740 / mo wholesale revenue to Wyre** and leaves the MSP roughly **$280–$640 / mo margin** depending on whether they resell at 1.5× or 2× list. Details in §3 below.

The key decision for leadership is whether the simplicity of Option A outweighs the possibility that a large future MSP partner walks because they wanted a deeper tier. We judge that risk low in v1 (no such partner is currently in the pipeline) and recommend a T+90 retro (pricing-decision PRD §0.5.6 task 11) to reassess.

---

## 1. Context

### 1.1 Where this fits

The `pricing-decision` PRD §0.5.4 narrowed Conduit's open pricing questions to four items after the reality-check revision of 2026-04-20. Item 1 — **wholesale discount schedule** — is the highest-urgency item because it blocks concrete implementation of `billing-wholesale` (specifically the `reseller_plans` row seed values and the discount engine in `billing-wholesale` §5).

This document answers §0.5.4.1. It does not restate the decisions on markup policy (§0.5.4.2 — handed to Task #6 elsewhere), credit pooling (§0.5.4.3 — Task #7, see `spec-credit-pooling.md`), or default customer tier (§0.5.4.4 — Task #8, see `spec-customer-default-tier.md`).

### 1.2 Retail anchor (non-negotiable for v1)

From pricing-decision PRD §0.5.1:

| Tier | Retail price | Seats | Credits per seat / mo |
|---|---|---|---|
| Free | $0 | 1 | 500 (flat) |
| Pro | $49 / user / mo | up to 3 | 1,500 |
| Business | $99 / user / mo | 5+ | 4,000 (pooled) |

Credit overage list price: **$10 per 1,000 credits**, no expiry.

The wholesale question is strictly: *what does Wyre charge the MSP* for the same SKUs, to leave room for MSP margin.

### 1.3 Guiding principles

1. **Simplicity wins in v1.** We have zero MSP partners today and no contract infrastructure. Whatever schedule we ship must be encodable as a single number per reseller plan row.
2. **Do not foreclose future moves.** Whatever we pick should not make Option B or C harder to introduce later.
3. **Leave real margin on the table.** MSPs need enough spread to cover billing ops, support escalations, and their own sales effort. A 10% discount is not a channel program; it is an insult. 30%+ is table stakes.
4. **Protect list pricing.** Whatever wholesale we offer, the MSP must not be able to resell so cheaply that they undercut direct retail buyers on the marketing site.

---

## 2. Candidate Schedules

All unit economics below assume per-seat monthly billing with plan-allocated credits included. Overage is separately priced.

### 2.1 Option A — Flat Discount (RECOMMENDED)

**Structure:**

- 30% off Pro list: wholesale = $49 × 0.70 = **$34.30 / seat / mo**
- 30% off Business list: wholesale = $99 × 0.70 = **$69.30 / seat / mo**
- 25% off credit overage blocks: wholesale = $10 × 0.75 = **$7.50 / 1,000 credits**

**Encoding:** One row per wholesale plan in `reseller_plans` (billing-wholesale §4.2). Single column `reseller_discount_pct = 0.30` per the PRD, plus `overage_discount_pct = 0.25`. Discount engine (billing-wholesale §5.1) applies percentage at invoice line-item generation.

**Unit economics — per-seat view:**

| SKU | Retail | Wholesale | Wyre gross / seat / mo | MSP cost | MSP margin at 1.5× retail resale | MSP margin at 2× retail resale |
|---|---|---|---|---|---|---|
| Pro | $49 | $34.30 | $34.30 | $34.30 | $49 × 1.5 − $34.30 = **$39.20** | $49 × 2 − $34.30 = **$63.70** |
| Business | $99 | $69.30 | $69.30 | $69.30 | $99 × 1.5 − $69.30 = **$79.20** | $99 × 2 − $69.30 = **$128.70** |
| Overage (1,000 cr) | $10 | $7.50 | $7.50 | $7.50 | $10 × 1.5 − $7.50 = **$7.50** | $10 × 2 − $7.50 = **$12.50** |

Note: "MSP margin at 1.5× retail resale" assumes the MSP marks up *list* by 1.5×, i.e., charges their customer $73.50 for a Pro seat. A flat passthrough where the MSP resells *at* list ($49) leaves them $14.70 / Pro seat margin — the minimum-margin case. Most MSPs bundle Conduit into a broader managed-service invoice with hidden markup and will effectively resell at 1.5–2.5× list.

**Projected Wyre revenue — representative 10-customer MSP:**

Assumptions: 10 downstream customers, average 2 seats each (half Pro, half Business mix per customer), modest overage of 500 cr / customer / mo above plan (0.5 overage blocks).

- 10 Pro seats × $34.30 = $343.00
- 10 Business seats × $69.30 = $693.00
- 10 × 0.5 overage blocks × $7.50 = $37.50
- **Wyre monthly revenue from this MSP: $1,073.50**
- (Compare list-equivalent: $1,533.00 — Wyre gives up $459.50 = 30% to the channel, on plan.)

A more conservative "small MSP" case — 10 customers × 1.5 seats, all Pro, minimal overage:

- 15 Pro seats × $34.30 = $514.50
- 2 overage blocks × $7.50 = $15.00
- **Wyre monthly revenue: ~$530**

**Pros:**

- One number per SKU. Trivially explainable on a pricing conversation.
- Zero tier boundaries → no gaming, no monthly reclassification job.
- Matches existing `billing-wholesale` PRD data model with no schema changes.
- Sits inside industry-standard 25–40% channel band (§4).

**Cons:**

- No built-in growth incentive for the MSP to add customers beyond their own margin math.
- Large MSPs (50+ customers) may reasonably ask for more; Option A gives us no quick answer.

### 2.2 Option B — Tiered by Active Customer Count

**Structure:**

| Active customers | Seat discount | Overage discount |
|---|---|---|
| 1–10 | 20% | 20% |
| 11–50 | 30% | 25% |
| 51+ | 40% | 30% |

"Active customer" = customer sub-org with at least one paid seat and `status='active'` at month close (billing-wholesale §4.1 definition of reseller aggregate).

**Encoding:** Requires a small bracket table (`reseller_discount_brackets`) or a JSON column on `reseller_plans`. Discount engine must look up current-period customer count before applying line-item transform. New monthly reclassification job.

**Unit economics — Pro seat across brackets:**

| Bracket | Wholesale Pro | Wyre gross / seat | Wholesale Business | MSP margin Pro @ 2× | MSP margin Business @ 2× |
|---|---|---|---|---|---|
| 1–10 | $39.20 | $39.20 | $79.20 | $58.80 | $118.80 |
| 11–50 | $34.30 | $34.30 | $69.30 | $63.70 | $128.70 |
| 51+ | $29.40 | $29.40 | $59.40 | $68.60 | $138.60 |

**Projected Wyre revenue — same 10-customer MSP as above (bracket 1–10, 20% off):**

- 10 Pro × $39.20 = $392.00
- 10 Business × $79.20 = $792.00
- 10 × 0.5 overage × $8.00 = $40.00
- **Wyre revenue: $1,224.00** (vs. $1,073.50 under Option A)

So at 10 customers, Option B is **more profitable for Wyre** than Option A. The crossover — where Option B gives Wyre *less* revenue than Option A — occurs at 11 customers when the MSP jumps to 30% bracket. Past that, Option B is worse for Wyre at any given volume than the flat 30%, until the 51+ bracket where the delta widens further.

**Pros:**

- Aligns incentives: MSPs are motivated to grow book to unlock deeper discount.
- Gives Wyre leverage with prospective large MSPs ("reach 50 customers and you're at 40%").
- Preserves margin on small MSPs (who are more expensive to support per dollar of revenue).

**Cons:**

- **Cliff effects.** Going from customer #10 to #11 drops the MSP's Pro wholesale from $39.20 to $34.30 — a 12.5% cost reduction at the seat level but applied retroactively to the whole fleet, this is a $58.80 / month gain to the MSP on a 20-seat base. MSPs will game this (fake customers to cross thresholds, delay offboarding churn so as not to fall back).
- **Ops complexity.** Requires a customer-count-freeze job per billing period, dispute process, probably manual overrides.
- **Contract friction.** Every MSP conversation becomes a tier-bracket negotiation.
- **Harder to explain on a first sales call.**

### 2.3 Option C — Volume Commit

**Structure:**

| Tier | Monthly commit | Discount | Unused spend |
|---|---|---|---|
| Starter | $0 (no commit) | 20% flat | n/a |
| Growth | $2,500 / mo | 35% off all SKUs | Rolls to reseller-pool credits at wholesale rate |
| Scale | $10,000 / mo | 45% off all SKUs | Rolls to reseller-pool credits |
| Enterprise | $25,000 / mo | 50% off, custom | Negotiated |

Commit is prepaid monthly via Stripe. Any unused commit at month-end converts to reseller-pool credit blocks (see `spec-credit-pooling.md`) usable for any downstream customer.

**Encoding:** Requires `reseller_min_commit_cents` column on `organizations` (already planned in `billing-wholesale` §4.1 / §14 task 4 — this row exists), plus rollover credit-block generation logic, plus contract infrastructure.

**Unit economics — Growth tier MSP, 20 Pro seats, 10 Business seats, moderate overage:**

- Gross at 35% discount: 20 × $31.85 + 10 × $64.35 + 5 overage × $6.50 = $637 + $643.50 + $32.50 = **$1,313**
- Commit: $2,500. Actual consumption: $1,313. Unused: $1,187 → converts to 182 reseller-pool overage blocks (182k credits) at $6.50 / 1,000 = $1,187. MSP gets credits they can resell to their customers as overage.
- **Wyre revenue: $2,500** regardless of consumption.

**Pros:**

- Deepest discount for committed partners.
- Guaranteed revenue for Wyre (commit is paid regardless of usage).
- Self-funding marketing dollar: over-committed partners over-buy credits, which incentivizes them to push Conduit harder to burn inventory.

**Cons:**

- **No commit infrastructure today.** Requires contracts (legal review), commit-tracking billing logic, credit rollover mechanic.
- **Scary for small MSPs** who will be pushed to Starter (20% — worse than Option A flat).
- **Premature for the current stage of the product.** Commits are a tool for known, scaled partners. We have zero.

---

## 3. Side-by-Side Comparison

| Dimension | Option A (Flat) | Option B (Tiered) | Option C (Commit) |
|---|---|---|---|
| Implementation effort | ~1 day (seed `reseller_plans`) | 1–2 weeks (brackets + recalc job) | 3–4+ weeks (commits + rollover + contracts) |
| Schema changes vs. current billing-wholesale PRD | None | Small (brackets table) | Moderate (commit tracking, rollover, legal) |
| Wyre revenue per 10-cust MSP / mo | $1,073 | $1,224 | $2,500 (guaranteed) |
| MSP margin at 2× retail (Pro seat) | $63.70 | $58.80–$68.60 | $67.15 (Growth) |
| Channel appeal (subjective) | Good | Strong for large MSPs | Strong for large MSPs, hostile to small |
| Gaming risk | None | High (bracket boundaries) | Moderate (commit under-consumption) |
| Reversibility | High — can upgrade to B or C later | Low — hard to walk brackets back | Low — commits are legally binding |
| T+90 learnability | High — clean experiment | Medium — confounded by bracket shifts | Low — commit partners are different segment |

---

## 4. Competitive Context

Typical SaaS channel discount ranges surveyed (April 2026):

- **Broad SaaS MSP programs** (Atlassian Solution Partners, HubSpot Solutions Partners): 15–25% baseline, 25–30% for certified tiers. Flat percentage per certified tier is standard; brackets on customer count are rare because they drive gaming.
- **Security / MSP-specific** (Huntress MSP, SentinelOne MDR, ConnectWise): 25–40% flat; deepest tiers for committed partners. Pax8-style marketplaces typically publish 20–25% list-minus and let the MSP keep any additional margin.
- **AI / usage-product precedents** (OpenAI, Anthropic): no public channel programs yet in 2026. This is a gap in competitive intelligence; Conduit can help define the norm rather than follow it.
- **Cloud distribution** (Ingram Micro, TD SYNNEX): 15–20% flat plus volume rebates; these are reference points for mature programs, not for our stage.

Reading: **30% flat is slightly generous but defensible** for a nascent program whose primary need is partner acquisition, not margin protection. We would rather attract 10 partners at 30% than 3 at 20%.

---

## 5. Commercial & Legal Implications

### 5.1 Contracts

- Option A: clickwrap reseller agreement sufficient. No custom terms. Reseller plan selected at `/signup` per `onboarding` PRD §4.5.
- Option B: clickwrap still works, but bracket definitions must be in-line in the MSA or an incorporated schedule. Monthly reclassification disputes need a defined process.
- Option C: requires signed order form per commit, legal review of commit terms, early-termination clauses. Adds 2–4 weeks to any partner onboard.

### 5.2 Minimum commits

- Option A: none. Any MSP who clicks through onboarding and adds one customer is a reseller.
- Option B: none (bracket 1–10 available at 20% for any MSP).
- Option C: $2,500 / mo minimum to see meaningful discount. Many prospective partners disqualified at this gate.

### 5.3 Trial handling

- Upstream mcp-gateway offers a 30-day Business trial (pricing-decision PRD §0.5.1). For MSP provisioning of customer sub-orgs under Option A/B, trial converts to paid Pro/Business at end of trial and the wholesale discount applies from conversion forward. No special trial-period discount — the MSP is paying $0 during the customer's trial anyway (no seat consumption on Wyre's side until conversion).
- For Option C, trial revenue does not count toward commit. This creates a pathological case where an MSP with $2,500 commit has all customers on trial and still owes $2,500 for nothing. Needs an explicit commit-holiday for first 30 days of each new customer or a commit reset. Adds complexity.

### 5.4 Termination & claw-back

- Option A/B: MSP cancellation ends future billing; no claw-back. Per billing-wholesale §7.
- Option C: unused commit at termination lost (or pro-rated — TBD by legal). Standard in enterprise SaaS. Needs contract language.

### 5.5 Most-favored-nation risk

Under Option B/C, if any MSP negotiates a deeper discount than published, MFN clauses in other partners' contracts may trigger. Option A has nothing to negotiate down to; this risk is zero.

---

## 6. Recommendation

**Adopt Option A (30% flat off seats, 25% flat off overage) for v1.**

Concretely:

1. Seed `reseller_plans` (`billing-wholesale` §4.2) with a single row:
   - slug: `reseller_standard`
   - `reseller_discount_pct`: 0.30
   - `overage_discount_pct`: 0.25
   - `stripe_price_id`: (provisioned during Stripe setup)
2. All MSPs onboarded in the first 90 days are assigned `reseller_standard`.
3. Conduit admin (Wyre internal) has a manual override mechanism (`reseller_discount_pct_override` on `organizations`, already planned in `billing-wholesale` §14 task 4) for one-off bespoke deals pre-contract. Use sparingly, log in `billing_events`.
4. At T+90, run the retro (pricing-decision PRD §0.5.6 task 11). If 2+ partners have requested tier structure or commit pricing, draft Option B as v2 schedule.
5. Do not publish Option C commit pricing publicly in v1. Keep as a quiet option for any prospect who asks "can we get more if we commit?" — answered on a case-by-case basis with `reseller_discount_pct_override`.

### 6.1 Upgrade path to Option B

If adopted at v2:

- Add `reseller_discount_brackets` table (JSON or normalized).
- Add monthly customer-count recalculation job running at UTC period close.
- Write migration that re-tier-maps existing `reseller_standard` MSPs into the correct bracket based on their current customer count. Existing MSPs are protected: they move only to brackets ≥ their current 30%.
- Announce with 60-day notice per standard pricing-change practice.

### 6.2 Upgrade path to Option C

If adopted at v2 or v3:

- Introduce as a new, opt-in `reseller_plan` tier (`reseller_growth`, `reseller_scale`, `reseller_enterprise`) per the catalog hinted at in `billing-wholesale` §3.2 line 125.
- Implement commit tracking as separate `reseller_commits` table with monthly-close job.
- Implement unused-commit-to-credits rollover via existing reseller-pool credit mechanism (see `spec-credit-pooling.md`).

---

## 7. Open Questions for Leadership

1. **Is 30% too generous for v1?** A 25% flat schedule ($36.75 / Pro, $74.25 / Business, 20% off overage) gives Wyre an additional $73.50 / mo per 10-customer MSP but risks fewer partners signing. Preference?
2. **Should overage discount match or differ from seat discount?** Current proposal: seats at 30%, overage at 25%. Rationale: overage is pure variable-cost to Wyre (inference compute) and has thinner intrinsic margin; less room to discount. Acceptable, or simplify to single 30% flat across everything?
3. **Do we gate Option A behind an application?** Current plan (`onboarding` PRD §4.3) has no approval step — any MSP-who-clicks is a reseller. Should we instead require application review (§4.4 exists but is optional) before granting wholesale pricing, to prevent single-customer arbitrage?
4. **Single wholesale plan slug, or two (Pro-only vs. Business-capable)?** Option A as drafted assumes one plan covers both. Alternative: require MSP to explicitly opt into the Business tier (perhaps with a basic business-readiness check — log-shipping destinations documented, etc.) before they can provision Business customers. Ties to Task #8 default-tier guardrails.
5. **Public pricing transparency?** Do we publish 30% wholesale on the Conduit pricing page, or keep it in a "Partner Program" behind a contact form?

---

## 8. Appendix — Math Verification

Pro seat, 30% off: $49 × 0.70 = $34.30. Confirm: $49 − $14.70 = $34.30. ✓
Business seat, 30% off: $99 × 0.70 = $69.30. Confirm: $99 − $29.70 = $69.30. ✓
Overage, 25% off: $10 × 0.75 = $7.50. Confirm: $10 − $2.50 = $7.50. ✓

10-customer MSP Option A totals:
- 10 × $34.30 = $343.00
- 10 × $69.30 = $693.00
- 10 × 0.5 × $7.50 = $37.50
- Sum: $343 + $693 + $37.50 = **$1,073.50** ✓

10-customer MSP Option B bracket 1–10 totals:
- 10 × ($49 × 0.80 = $39.20) = $392.00
- 10 × ($99 × 0.80 = $79.20) = $792.00
- 10 × 0.5 × ($10 × 0.80 = $8.00) = $40.00
- Sum: $392 + $792 + $40 = **$1,224.00** ✓

Option B 11-customer step (bracket crossover to 30%):
- 11 × $34.30 = $377.30
- 11 × $69.30 = $762.30
- 11 × 0.5 × $7.50 = $41.25
- Sum: **$1,180.85** — note this is lower than Option B's 10-customer case ($1,224) for Wyre, because the MSP got a volume reward. Correctly reflects bracket drop.

---

*End of proposal.*
