# PRD: Conduit Pricing Model Decision

**Tag:** `pricing-decision`
**Type:** Decision artifact + rollout plan (NOT a feature spec)
**Status:** Reality-checked 2026-04-20 — scope narrowed (see §0.5)
**Owner:** Aaron
**Last updated:** 2026-04-20

---

## 0.5. Reality check (added 2026-04-20) — READ FIRST

The original analysis below (§1–§9) assumed Conduit pricing was greenfield. It is not. The upstream `mcp-gateway` product has already defined and partially shipped a seat + credit tier model, and the marketing pricing page (PR #53 at `wyre-technology/msp-claude-plugins`, **Draft — not yet merged**) publishes those tiers. Conduit inherits this model by default; the Conduit-specific decisions are a narrower set.

### 0.5.1. Locked tier structure (retail / list prices)

| Tier | Price | Users | Personal conns | Shared org conns | Credits/seat/mo | Features |
|---|---|---|---|---|---|---|
| **Free** | $0 | 1 | 3 | — | 500 (flat) | Community support |
| **Pro** | $49/user/mo | up to 3 | 3/user | 5 | **1,500** (code) / **2,000** (PR #53) — **DISCREPANCY** | Team roles, invites, tool allowlists, email support |
| **Business** | $99/user/mo | 5+ | unlimited | unlimited | 4,000 (pooled) | Above + audit log, log shipping, service clients, dedicated support |

Sources: `mcp-gateway/src/billing/gate.ts` (constants, enforcement), `wyre-technology/msp-claude-plugins#53` → `docs/src/pages/pricing.astro` (marketing). 30-day Business trial implemented (commit `7ad9527`).

- **Credit = 1 successful tool call.** Browsing / failed calls don't count.
- **Overage:** credit blocks at $10 / 1,000 credits, no expiry.
- **Plan gating** enforced in `BillingGate` — team features, member adds, tool allowlists, advanced features (audit/log shipping/service clients) are all plan-checked.

### 0.5.2. 🚨 Pre-launch blocker for mcp-gateway team

**`PRO_CREDITS_PER_SEAT` mismatch**: code says `1_500`, PR #53 pricing page advertises `2,000`. This must be reconciled before PR #53 merges — either bump code to 2,000 (preferred, marketing commitment) or edit page to 1,500. File an issue upstream in `wyre-technology/wyre-mcp-gateway-platform`.

### 0.5.3. What this collapses in the original analysis

- §2 "Options catalog (a–f)" — **mostly moot.** The shipped model is closest to **Option F: hybrid per-seat + metered credits** with overage top-ups. Options A/B/C/D/E are retired as active candidates.
- §3 "Decision criteria matrix" — retained as useful framing for the wholesale discount choice below, but scoring is no longer about retail model selection.
- §5 "Recommendation" (Option D per-seat with free customer tier) — **rescinded.** Conduit defaults to the retail tier structure above; the recommendation now applies only to wholesale layer (§0.5.4).
- §6 "Rollout plan: choose and validate a pricing model" — **collapses.** Customer interviews still valuable but scoped to validating discount schedule + markup policy, not pricing shape.

### 0.5.4. Actual remaining Conduit decisions

The real open questions, ordered by urgency:

1. **Wholesale discount schedule** (highest urgency — blocks `billing-wholesale` implementation)
   - Flat percentage off list (simple; e.g., 30% off all paid tiers)?
   - Tiered by customer count (e.g., 20% off 1–10 customers, 30% off 11–50, 40% off 51+)?
   - Volume commit (MSP pre-commits monthly spend, gets deeper discount)?
   - Recommendation: **start with flat 30% off Pro and Business seat prices + 25% off credit overage blocks**, revisit with first 5 MSP partners.
2. **MSP→customer markup policy**
   - Free-form: MSP sets any retail price; Wyre invisible to customer. Max flexibility, complicates Stripe setup (MSP bills customer off-platform).
   - Pass-through: MSP charged wholesale, customer sees list price; MSP earns margin implicitly. Simpler but removes MSP pricing autonomy.
   - Enforced floor: MSP must charge ≥ list; can mark up but not discount below list. Protects Wyre positioning.
   - Recommendation: **v1 = free-form off-platform**. MSP handles customer billing entirely; Conduit only bills MSP. Revisit if MSPs request embedded customer-billing in v2 (Stripe Connect territory).
3. **Credit pooling across customer sub-orgs** under one MSP
   - Per-customer pool (credits tied to each sub-org's plan — current upstream behavior).
   - Reseller-wide pool (MSP buys credit blocks wholesale, allocates or pools across all customers).
   - Recommendation: **both.** Default = per-customer from their plan. Add optional `reseller_pool` credit_block scope so MSPs can buy overflow credits at wholesale and let sub-orgs draw from the shared pool when their plan credits are exhausted. Depends on `billing-wholesale` credit_blocks extension.
4. **Default customer tier at provisioning**
   - Free (MSP decides when to upgrade).
   - Pro (MSP must opt customer into a paid tier to create them — matches "MSPs only resell paid").
   - Business (high default, high spend).
   - MSP-selectable at provisioning (recommended): MSP picks from {Free, Pro, Business} per-customer in the Add Customer flow. Defaults to Pro.
5. **Annual / commitment pricing** — deferred. Pricing page says "coming soon." Wholesale tier can offer the same annual discount if/when it ships.

### 0.5.5. Updated acceptance criteria for this tag

- AC-1: Wholesale discount schedule documented and approved (§0.5.4.1).
- AC-2: Markup policy decided for v1 (§0.5.4.2).
- AC-3: Credit pooling behavior specified in `billing-wholesale` PRD (§0.5.4.3).
- AC-4: Provisioning tier selection behavior specified in `onboarding` PRD (§0.5.4.4).
- AC-5: PRO_CREDITS_PER_SEAT discrepancy filed and resolved upstream.
- AC-6: 3–5 MSP partner interviews validating discount schedule before launch.
- AC-7: Discount schedule encoded in `reseller_plan` table per `billing-wholesale` PRD.
- AC-8: Conduit pricing page drafted (distinct from mcp-gateway's; surfaces MSP-channel framing). Hands off to `docs` PRD.

### 0.5.6. Updated task list (supersedes §9)

1. File issue in `wyre-technology/wyre-mcp-gateway-platform` for PRO_CREDITS_PER_SEAT 1500/2000 reconciliation.
2. Draft wholesale discount schedule proposal (flat % recommendation).
3. Internal review of discount schedule with Wyre leadership.
4. Recruit 3–5 pilot MSP partners for discount validation.
5. Conduct MSP discount validation interviews.
6. Lock wholesale discount schedule.
7. Decide markup policy for v1 (recommendation: free-form off-platform).
8. Spec credit pooling behavior (reseller_pool scope) into `billing-wholesale` PRD.
9. Spec default-tier selection in `onboarding` PRD customer provisioning flow.
10. Draft Conduit MSP-facing pricing page (handoff to `docs`).
11. T+90 retro: measure MSP activation, margin realization, requests to change discount.

---

## 0. Preface: Why this PRD is different

Sibling PRDs in the Conduit project (`billing-wholesale`, `msp-admin`, `docs`, `branding`, etc.) describe **features to build**. This PRD is different: its primary deliverable is a **decision**, not a feature. The implementation work that follows from that decision is largely delegated to other tags (especially `billing-wholesale`).

The taskmaster backlog generated from this PRD is therefore weighted toward:

- Strategic research
- Internal review cycles
- Customer validation interviews
- Commercial / legal artifacts (term sheets, discount schedules)
- Minimal implementation stubs that link back to sibling PRDs

It is intentionally lighter weight (target 300-700 lines vs. feature PRDs at 800-1500).

---

## 1. Problem framing

### 1.1 The question

**How should Conduit price the MSP channel relationship?**

Concretely, this breaks down into three sub-questions:

1. **What does the MSP pay Wyre?** (Per-seat flat, usage-metered, tiered SKUs, hybrid?)
2. **What does the MSP's end customer pay the MSP?** (Free, MSP-set retail, Wyre-fixed retail, rev-share?)
3. **How visible is Wyre's pricing in the channel?** (White-label opaque, co-branded, or Wyre-branded pricing page?)

### 1.2 Why pricing shape matters

Pricing is not just a number — it is a **shape** that ripples into every other system:

| Area                    | Impact of pricing shape                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Billing engine          | Per-seat vs. usage vs. hybrid dictates metering, invoicing, and Stripe product model |
| UI / MSP admin          | Do we show retail prices? Margin? Customer-facing plan selector?                     |
| Contracts               | MFN clauses, minimum commits, discount schedules, termination-for-convenience        |
| Sales motion            | Self-serve MSP signup vs. sales-led wholesale contract                               |
| Margin predictability   | Fixed retail → Wyre knows its take; free-form retail → Wyre doesn't                  |
| Competitive positioning | Are we the "cheap white-label" or the "premium branded-as-yours" play?               |
| Compliance / tax        | Rev-share triggers different accounting treatment than pure wholesale                |

### 1.3 Known constraints

- MSPs pay Wyre a **wholesale discount** off Wyre's published standard plans — this is a given.
- `mcp-gateway` has a `feat/billing` branch already in flight. Whatever we pick, we inherit that engine rather than rewriting it.
- Customers of the MSP are hierarchical sub-tenants under the MSP org.
- The MSP's retail pricing to its own customers is **OPEN**. This PRD exists to close that.

### 1.4 What success looks like

- A chosen pricing model, documented and defensible to investors, sales, and MSP partners.
- A discount schedule (volume tiers, commit discounts) signed off by finance.
- A billing engine configuration that maps cleanly onto the chosen model without forks.
- Sales enablement that lets a rep quote an MSP in <10 minutes.

---

## 2. Options catalog

Six viable models. Each described with model, pros/cons, billing plumbing, industry precedent, and a rough fit rating (1-5 stars for Conduit's context).

### Option A: Wholesale + MSP sets retail freely

**Model.** MSP buys seats/usage from Wyre at a discount (e.g. 30% off list). MSP charges their end customer whatever they want. Wyre never sees the retail price.

**Pros.**
- Maximum MSP flexibility → low adoption friction, channel-friendly.
- Simple from Wyre's billing POV: MSP is the customer of record.
- Aligns with how most MSP tools (ConnectWise, Datto, N-able) sell.

**Cons.**
- Wyre has **zero visibility** into retail margin → no data-driven upsell, no competitive benchmarking.
- Race-to-the-bottom risk: MSPs undercut each other and devalue the brand.
- Hard to build a "recommended retail price" narrative for new MSPs.

**Billing plumbing.** Simplest. One Stripe customer per MSP. Seat/usage metering rolls up to MSP invoice. No rev-share accounting.

**Industry precedent.** Standard in traditional MSP RMM/PSA tooling.

**Fit rating.** 4/5 — channel-standard, low friction, but gives up strategic data.

---

### Option B: Fixed retail + rev-share

**Model.** Wyre publishes retail prices on a pricing page. MSP resells at those prices, earns a revenue share (e.g. 20-35% of MRR from customers they bring).

**Pros.**
- Brand consistency — no race to the bottom.
- Wyre collects full retail data → better pricing iteration.
- Predictable margin for Wyre.

**Cons.**
- MSPs hate it. Channel perception: "Wyre is competing with me on price."
- MSP loses pricing as a lever for bundling with their own services.
- Rev-share accounting is more complex (1099/partner reporting).

**Billing plumbing.** Moderate. End customers are Stripe customers, MSPs get partner payouts. Needs partner ledger + payout module.

**Industry precedent.** Common in SaaS affiliate/referral programs. Rare in true MSP channel.

**Fit rating.** 2/5 — clean for Wyre, hostile to MSPs.

---

### Option C: Resale SKUs / tiers

**Model.** Wyre publishes a small catalog of MSP-resale SKUs (e.g. "Conduit Starter — 10 seats / $X wholesale", "Conduit Pro — 50 seats / $Y wholesale"). MSP picks which SKUs to stock and marks up however they like.

**Pros.**
- Middle ground: structure for Wyre, flexibility for MSP on retail.
- SKU-level telemetry → good data.
- Easier sales enablement (quote = pick SKU + quantity).

**Cons.**
- SKU proliferation risk over time.
- Doesn't handle usage-heavy customers well unless SKUs include usage bands.

**Billing plumbing.** Moderate. Stripe products per SKU, MSP subscribes on behalf of customer.

**Industry precedent.** Microsoft CSP, AWS Marketplace private offers, Pax8.

**Fit rating.** 4/5 — aligns with how MSPs already buy Microsoft/Azure.

---

### Option D: Per-seat MSP plan + free customer tier

**Model.** MSP pays Wyre a flat per-seat fee (e.g. $X/seat/month, where "seat" = an end-customer user). End customers pay nothing to Wyre. MSP's margin is whatever they charge the customer minus $X.

**Pros.**
- Simplest billing imaginable. One Stripe subscription per MSP.
- Frictionless onboarding for end customers (no payment capture).
- MSP owns 100% of customer relationship.

**Cons.**
- Doesn't handle wildly variable usage well (heavy user pays same as light user).
- MSP is on the hook for seats whether their customer pays them or not.
- Caps upside for Wyre — no usage-based scaling.

**Billing plumbing.** Trivial. Stripe per-seat subscription on MSP, metered only on seat count.

**Industry precedent.** Slack Enterprise Grid partner model, many MSP tooling vendors.

**Fit rating.** 4/5 — simple and MSP-friendly; limits Wyre's usage-revenue upside.

---

### Option E: Usage-metered only

**Model.** MSP pays per tool-call, per token, or per MCP session at a wholesale rate. MSP passes through, marks up, or bundles.

**Pros.**
- Most accurate: cost tracks value delivered.
- Scales linearly with customer activity.
- Aligns with MCP gateway's nature (it's fundamentally a usage product).

**Cons.**
- Hardest UX. MSPs hate "I don't know what my bill will be."
- End customers hate it even more.
- Requires rock-solid metering + attribution per sub-tenant.

**Billing plumbing.** Highest complexity. Usage records per call, aggregation per sub-tenant, per MSP. Stripe metered billing with custom aggregation.

**Industry precedent.** AWS, Twilio, OpenAI API. Rare in MSP channel.

**Fit rating.** 2/5 for pure form; component of hybrid (see F).

---

### Option F: Hybrid — platform fee + usage

**Model.** MSP pays a flat monthly platform fee (covers tenancy, white-label, support SLA) PLUS metered usage above an included allowance. Discount applied to both components.

**Pros.**
- Predictable floor for Wyre (platform fee) + upside on usage.
- MSP gets an "included" bucket to sell confidently.
- Industry-standard pattern in channel SaaS.

**Cons.**
- Two line items to explain.
- Requires both subscription and metered billing in the engine.
- Overage handling needs clear UX (alerts, throttles, auto-upgrade).

**Billing plumbing.** Moderate-high. Stripe subscription + metered component. Overage logic in app.

**Industry precedent.** Twilio Flex, Auvik, Datadog, Cloudflare for Partners.

**Fit rating.** 5/5 — best fit for a usage-intensive product sold to a channel that wants predictability.

---

## 3. Decision criteria matrix

Each option scored 1 (worst) to 5 (best) on five dimensions. Weights reflect Conduit's priorities at this stage (early, channel-first, usage-heavy product).

| Criterion                     | Weight | A: Wholesale+Free Retail | B: Fixed+Rev-share | C: Resale SKUs | D: Per-seat | E: Usage-only | F: Hybrid |
| ----------------------------- | ------ | ------------------------ | ------------------ | -------------- | ----------- | ------------- | --------- |
| Margin predictability (Wyre)  | 20%    | 3                        | 5                  | 4              | 4           | 3             | 4         |
| MSP adoption friction (lower=better, shown inverted) | 25% | 5              | 2                  | 4              | 5           | 2             | 4         |
| Billing engine complexity (lower=better, inverted) | 15% | 5                | 3                  | 4              | 5           | 2             | 3         |
| Competitive differentiation   | 15%    | 2                        | 3                  | 3              | 2           | 4             | 5         |
| Time-to-market                | 25%    | 5                        | 2                  | 4              | 5           | 2             | 3         |
| **Weighted score**            |        | **4.15**                 | **2.95**           | **3.85**       | **4.25**    | **2.55**      | **3.75**  |

**Read carefully.** The top-scoring options (D, A, C) are the ones that ship fastest and cause least friction. Option F (hybrid) scores lower on speed-to-market but arguably wins on strategic fit. This is a classic "do it right vs. do it fast" split — see §5 for the recommendation that reconciles this.

---

## 4. Competitive scan

Brief survey of how comparable MSP-channel SaaS products price. Not exhaustive — meant to orient the decision.

### 4.1 MSP-adjacent products

- **Auvik** (network monitoring, MSP-focused). Tiered per-device pricing with wholesale discount for MSPs. Published retail prices; MSPs negotiate volume tiers. Model ≈ hybrid C + F.
- **Liongard** (inspection/config monitoring). Per-inspector model (≈ per-seat). Wholesale partner program. Model ≈ D.
- **IT Glue / Hudu** (documentation). Per-user tiered pricing, MSP volume discounts. Model ≈ C.
- **Pax8 / AppDirect** (channel marketplaces). They aggregate SKUs from many vendors — vendors themselves publish wholesale SKUs (model C) and Pax8 handles billing/rev-share.
- **ConnectWise / Kaseya / N-able** (RMM+PSA). Per-endpoint or per-technician seat pricing with steep volume discounts. Model ≈ D+C.

### 4.2 AI-/usage-product precedents

- **OpenAI (via partners)**. API-level usage billing with volume discounts. Partners mostly repackage into their own SKUs. Model E.
- **Cloudflare for Partners**. Platform fee + usage overages. Model F.
- **Twilio**. Pure usage with commit discounts. Model E with volume-commit overlay.

### 4.3 Channel expectations

MSPs broadly expect:

1. **Predictable monthly cost** — usage-only is a turn-off unless bundled with an allowance.
2. **Flexibility on retail pricing** — do not tell them what to charge their customer.
3. **Wholesale discounts that scale** with volume commitment.
4. **Co-brand or white-label** control.
5. **Quote-to-invoice workflows** — they live in ConnectWise/Autotask, not custom portals.

Implication: any model that publishes fixed retail (Option B) or is pure-usage (Option E) will face uphill adoption in the traditional MSP channel.

---

## 5. Recommendation (proposed default)

### 5.1 Proposed model: **Option F (Hybrid) with Option D as launch-simplified variant**

**Proposed default:**

> **Launch with Option D** (per-seat MSP plan, free customer tier) for the first 6-12 months, and **graduate to Option F** (platform fee + metered usage) once we have 6+ months of usage data and at least 10 MSP partners generating real workload.

Why this phasing:

1. **D ships fast.** The billing engine inherited from `mcp-gateway` can handle per-seat subscriptions on day one. No usage-attribution-per-sub-tenant work is on the critical path.
2. **D is MSP-friendly.** Predictable, familiar, zero friction for the end customer. Low adoption risk during the phase where we need learning velocity, not revenue optimization.
3. **F captures long-run value.** Once we understand real usage distributions, the platform fee + usage model captures upside from heavy users without punishing light ones. It is also the industry-standard shape for usage-intensive channel SaaS.
4. **Migration path is clean.** Going D → F is additive (introduce a metered component, set allowance high enough that existing customers see no change at first). Going D → anything else would be disruptive.

### 5.2 Retail layer recommendation

On the second sub-question (what the MSP charges their customer): **Option A posture** — MSP sets retail freely. Wyre will publish a **"recommended retail price" (RRP)** as guidance only, not as a contractual floor. This:

- Keeps MSPs in control (table stakes for channel adoption).
- Gives new MSPs a starting point so they don't have to invent pricing from scratch.
- Preserves Wyre's ability to influence positioning without creating conflict.

### 5.3 What Wyre gives up with this recommendation

- **Retail margin visibility.** We will not know what MSPs charge unless they tell us. Mitigation: voluntary margin reporting tied to partner-tier benefits (e.g. co-marketing budget).
- **Short-term usage upside.** Per-seat caps revenue at seat count × price. Mitigation: phased move to F.

### 5.4 This is a default, not a verdict

The user is unsure about pricing — appropriately so. This recommendation exists to give the decision-making process a starting point, not to pre-empt it. See §9 for the open questions that the user must answer before this default becomes final.

---

## 6. Decision rollout plan

Ordered sequence of work. Each step has a clear artifact.

### Phase 1: Internal alignment (weeks 1-2)

1. **Draft term sheet.** A 1-2 page document codifying the proposed model: wholesale discount %, per-seat price, commit tiers, RRP guidance, termination/MFN/exclusivity stance. Reviewed by founders + finance.
2. **Internal pricing review.** 60-minute session with founders, finance, and sales. Output: term sheet v2 with red-lines resolved.

### Phase 2: External validation (weeks 3-6)

3. **Customer interviews.** Talk to 3-5 target MSPs (ideally a mix: one big national MRR > $10M, two mid-sized regionals, one or two small boutiques specializing in AI). Structured questions on:
   - Current tool spend per customer
   - Billing cadence preferences
   - Reaction to per-seat vs. hybrid
   - Acceptable discount floors
4. **Synthesize findings.** Note where reality disagreed with the recommendation. Update term sheet → v3.

### Phase 3: Lock the model (week 7)

5. **Final pricing decision.** Founders sign off on v3. Discount schedule locked. RRP guidance locked. This is the gate that closes this PRD's core decision work.

### Phase 4: Implementation (weeks 8-14)

6. **Implement in billing engine.** Handoff to `billing-wholesale` PRD. This PRD contributes only a thin implementation stub task that references the locked model.
7. **Publish pricing / partner page.** Handoff to `docs` PRD. Stub task here references the content brief.
8. **Wire MSP-admin plan display.** Handoff to `msp-admin` PRD. Stub task references required fields (plan name, seats used, included allowance if F).

### Phase 5: Launch enablement (weeks 12-16, overlaps Phase 4)

9. **Sales enablement.** One-pager + quote template + objection handling cheat-sheet.
10. **Margin / KPI dashboard.** Internal view: MRR per MSP, seats sold, activation rate, churn, voluntary retail reporting coverage.

---

## 7. Dependencies

| Dependency                | Relationship                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| `billing-wholesale` PRD   | Receives the locked model and implements it in the billing engine          |
| `docs` PRD                | Publishes pricing page / partner program content                            |
| `msp-admin` PRD           | Displays plan info, seat count, allowance (if F) to MSP admins             |
| `branding` PRD            | Co-brand vs. white-label decisions affect RRP guidance presentation        |
| `feat/billing` (upstream) | Inherits metering primitives; we do NOT fork this                          |

---

## 8. Acceptance criteria

This PRD's tag is closed when **all** of the following are true:

- [ ] A pricing model is **chosen** and documented in a locked term sheet.
- [ ] A discount schedule is **signed off** by finance.
- [ ] RRP guidance is **drafted** (if applicable to chosen model).
- [ ] The chosen model is **configurable** in the billing engine (implementation delegated to `billing-wholesale` but verified here).
- [ ] Pricing content is **live** on the public pricing/partner page.
- [ ] MSP-admin UI **displays** plan + usage correctly for at least one test MSP tenant.
- [ ] Sales enablement one-pager is **distributed**.
- [ ] Internal margin dashboard shows **at least MRR and seats-sold per MSP**.

---

## 9. Open questions for the user

These are the questions the user should answer (or explicitly defer) before the default recommendation becomes the actual decision.

1. **Do you want Wyre to have retail-price visibility at all?** If yes, that rules out pure Option A and pushes toward B, C, or F with voluntary reporting.
2. **How much usage-based revenue upside are you willing to defer for launch speed?** Direct input on the D-then-F vs. F-day-one tradeoff.
3. **What's the target wholesale discount %?** Typical ranges: 20% (low-touch), 30% (standard channel), 40%+ (strategic/anchor MSPs). This affects the term sheet directly.
4. **Do you want commit-based discount tiers, or a flat rate for all MSPs?** Tiers reward scale but add sales complexity.
5. **Who are the 3-5 target MSPs for validation interviews?** Need names to kick off Phase 2.
6. **Is there a budget / headcount constraint on the discount schedule?** E.g. finance requirement that gross margin stays above X%.
7. **Should end customers ever see a Wyre invoice / Wyre brand, or is white-label strict?** Affects Option D feasibility (free-to-customer is easier if white-label is strict).
8. **Are we selling through marketplaces (Pax8, AppDirect) at launch, or direct only?** Marketplace distribution changes the SKU structure materially.

---

## 10. Risks

| Risk                                                        | Likelihood | Impact | Mitigation                                                          |
| ----------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------- |
| Chosen model doesn't survive first 3 MSP negotiations       | Medium     | High   | Phase 2 validation interviews before locking                        |
| D → F migration is more disruptive than predicted           | Low        | Medium | Design metered allowance from day one, even if inactive             |
| MSPs demand MFN / exclusivity clauses we can't offer        | Medium     | Medium | Legal input during term sheet drafting; predetermined stance        |
| Finance blocks discount schedule on margin grounds          | Low        | High   | Involve finance in Phase 1 not Phase 3                              |
| Competitor undercuts us in the channel after we publish     | Medium     | Medium | Keep wholesale discount schedule confidential; publish RRP only     |

---

## Proposed task list

Mix of decision-making, research, commercial artifact, and implementation stub tasks. These become the taskmaster backlog for the `pricing-decision` tag.

1. **Draft v1 term sheet** covering wholesale discount, per-seat price, commit tiers, RRP guidance, termination / MFN posture. (Decision artifact)
2. **Internal pricing review session** with founders + finance; produce v2 term sheet with red-lines resolved. (Decision)
3. **Identify and recruit 3-5 target MSPs** for validation interviews; produce interview guide. (Research)
4. **Conduct MSP validation interviews** and synthesize findings into a report. (Research)
5. **Lock the pricing model** — founders sign off on v3 term sheet; publish internal decision memo. (Decision gate)
6. **Write discount schedule spec** — volume tiers, commit discounts, renewal terms — for finance sign-off. (Commercial)
7. **Billing engine implementation stub** — handoff ticket to `billing-wholesale` PRD with the locked model config (plan shape, metering requirements, overage handling if any). (Implementation stub)
8. **Pricing page content brief** — handoff ticket to `docs` PRD with RRP guidance, partner-program description, and FAQ. (Implementation stub)
9. **MSP-admin plan-display requirements** — handoff ticket to `msp-admin` PRD listing fields to surface (plan name, seats, included allowance, overage status). (Implementation stub)
10. **Sales enablement one-pager** — quote template, objection-handling, discount-tier cheat-sheet. (Launch)
11. **Margin / KPI dashboard spec** — metrics (MRR per MSP, seats, activation, churn), data sources, access control. (Launch)
12. **Post-launch retro checkpoint (T+90 days)** — review actual margins and MSP feedback vs. recommendation; decide whether to advance D → F or adjust. (Governance)

---

*End of PRD. This is a living document until §8 acceptance criteria are met.*
