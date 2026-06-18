-- =============================================================================
-- Migration:      054_org_discounts.sql
-- Date:           2026-06-18
-- Linear:         WYREAI-25 (flat-pricing atomic rip-out — EAP slice)
-- Pedigree:       boss msg-1781749682091 (A* + shared-apply-helper, GO),
--                 ruby msg-1781749672262 (primitive-shape spec + PK + audit),
--                 pearl msg-1781749515880 (initial slide proposal).
--
-- Purpose:
--   Minimum-viable per-org discount primitive. Replaces what would have
--   been a pair of single-purpose flags (org_fee_waived, annual_prepay)
--   with a one-row-per-reason discount registry that BOTH the display
--   layer (computeSeatBilling → composedBillLine) AND the Stripe-driving
--   layer (subscription-factory) consume through a SHARED applyDiscounts
--   helper — one apply-logic, two consumers, divergence impossible by
--   construction.
--
--   The page advertises "Org fee waived — ask us about EAP" (live at
--   conduit.wyre.ai/pricing per PR wyre-ai#32, merged 02:08Z 2026-06-18).
--   This migration lands the billing-side capability to honor that signup:
--   admin grants an eap/org_fee/100 row, and seat-service + subscription-
--   factory both stop including the $399 base in everything the org sees.
--
--   The (c) annual-prepay PR will land an annual_prepay/invoice_total/15
--   variant against the same table. The reason+applies_to enums extend
--   without schema migration; future discount-types (volume, promo, etc.)
--   are CHECK-constraint-extension only.
--
-- Why a primitive, not a boolean (cross-msg deliberation 1781749309408 →
-- 1781749596800 → 1781749657785 → 1781749682091, resolved at A*+helper):
--   * (c) annual-prepay is the IMMEDIATELY-NEXT PR in ship-order. A boolean
--     here forces (c) to either generalize-mid-ship (more rework than
--     primitive-once-now) or build a parallel mechanism (vocabulary-
--     alignment violation — EAP and annual share discount-vocabulary, so
--     the mechanism should match). The primitive serves both with the
--     enum extension and one row per reason.
--   * The "more apply-surface than a boolean" concern (one apply-site for
--     boolean vs N-discount math for primitive) is COLLAPSED by the
--     shared applyDiscounts(base, seatTotal, discounts) helper at
--     src/billing/discounts.ts — computeSeatBilling and subscription-
--     factory both call the same helper, so the math cannot diverge
--     between display and Stripe.
--   * The display-vs-invoice single-source-of-truth at seat-service is
--     PRESERVED: org_discounts rows are the SoT for the discount itself;
--     Stripe sees deterministic line items reflecting our math (the
--     AUVIK_VALID_REGIONS internal-authority-drives-external-rendering
--     pattern, at primitive scale). No Stripe-coupon-state to sync.
--
-- Schema rationale:
--   * org_id REFERENCES organizations(id) ON DELETE CASCADE: discounts
--     are part of the org's billing-substrate; org hard-delete drops them.
--   * PRIMARY KEY (org_id, reason): one active grant per reason per org
--     prevents duplicate-grant accumulation. Future reason-enum extension
--     naturally extends the PK uniqueness without schema change.
--     (ruby msg-1781749672262, PK confirmation #1.)
--   * percent INT (1..100): integer percentage applied to the line-item
--     domain named by applies_to. Stored as a whole percent rather than
--     a decimal multiplier so display copy can render the granted percent
--     verbatim ("Org fee waived — 100%", "Annual prepay — 15% off") with
--     no rounding surprise.
--   * reason TEXT with CHECK ('eap', 'annual_prepay'): the human-facing
--     semantic label for the grant. Drives the customer-facing badge
--     copy and the admin-trail entry.
--   * applies_to TEXT with CHECK ('org_fee', 'invoice_total'): the math
--     scope. 'org_fee' → discount the $399 base line only. 'invoice_total'
--     → discount the entire bill post-base+seat. The enum makes the
--     apply-side compile-fail-as-linchpin at every call site that switches
--     on it (computeSeatBilling, subscription-factory) — future discount-
--     types must extend the enum AND declare apply-side or the switch
--     fails closed. (ruby msg-1781749672262, applies_to discipline #3.)
--   * granted_by TEXT NOT NULL REFERENCES users(id): the admin who issued
--     the grant. Source-of-truth for the customer-facing "granted by X on
--     date Y" badge AND the admin-trail viewer chronological log — two
--     distinct read-side consumers pulling from the same SoT (ruby msg-
--     1781749672262, audit-housed-in-primitive payoff #2). The route
--     layer ALSO emits an adminAuditService.audit() row (belt-and-
--     suspenders defense-in-depth at audit-substrate, NOT vocabulary-
--     divergence — distinct consumers, same SoT semantics).
--   * granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(): grant timestamp.
--     Paired with granted_by for the pedigree badge.
--
-- RLS posture:
--   * Same as organizations (sibling-substrate): the read path is
--     reseller-clause + member-clause via the existing
--     conduit_is_member_of_org / conduit_is_reseller_member_of /
--     conduit_is_reseller_member_of_parent helpers (mig 030/052).
--   * Writes are SYSTEM-PATH ONLY — only the admin route at
--     src/admin/org-routes.ts (running under runAsSystem / BYPASSRLS via
--     the AdminAuditService dependency) inserts/deletes here. Customer-
--     facing writes do NOT exist (admin-set only, no self-serve EAP).
--   * Index on (org_id) — every read is "give me the discounts for THIS
--     org." Already implicit via the PK leading column; no separate index
--     needed.
--
-- Idempotency-by-construction:
--   CREATE TABLE IF NOT EXISTS + DO $$ + pg_constraint-lookup for the
--   CHECK constraints — same shape as mig 047 / 048.
--
-- SCIM-harness drift prevention:
--   src/scim/__tests__/integration-harness.ts applyBootstrap() is updated
--   in the same PR to CREATE TABLE org_discounts so the schema-harness-
--   drift gate (the same gate that caught mig 052) sees this migration
--   structurally in sync. NOT added to ALLOWED_SKIPS — the bootstrap-
--   inclusion is the structural fix.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS org_discounts (
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  applies_to  TEXT NOT NULL,
  percent     INTEGER NOT NULL,
  granted_by  TEXT NOT NULL REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, reason)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_discounts_reason_check'
  ) THEN
    ALTER TABLE org_discounts
      ADD CONSTRAINT org_discounts_reason_check
      CHECK (reason IN ('eap', 'annual_prepay'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_discounts_applies_to_check'
  ) THEN
    ALTER TABLE org_discounts
      ADD CONSTRAINT org_discounts_applies_to_check
      CHECK (applies_to IN ('org_fee', 'invoice_total'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_discounts_percent_check'
  ) THEN
    ALTER TABLE org_discounts
      ADD CONSTRAINT org_discounts_percent_check
      CHECK (percent BETWEEN 1 AND 100);
  END IF;
END $$;

ALTER TABLE org_discounts ENABLE ROW LEVEL SECURITY;

-- Read policy: org members (+ reseller-org members on customer-org parent
-- chain) see their own org's discounts. Same predicate shape as mig 052's
-- customer-org tables — copy-paste from the canonical pattern.
DROP POLICY IF EXISTS org_discounts_select ON org_discounts;
CREATE POLICY org_discounts_select ON org_discounts
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_discounts.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_discounts.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_discounts.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_discounts.org_id)
  );

-- Write policies: NO customer-facing path. Inserts and deletes run via the
-- system-path connection from src/admin/org-routes.ts only. No CREATE
-- POLICY for INSERT/UPDATE/DELETE — RLS denies all writes from non-
-- BYPASSRLS roles by default, which is precisely the admin-set-only
-- intent. The admin route uses runAsSystem (BYPASSRLS) for the mutation.

COMMIT;
