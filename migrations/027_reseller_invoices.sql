-- =============================================================================
-- Migration:      027_reseller_invoices.sql
-- Date:           2026-05-15
-- PRD Reference:  Track C scope-doc + β-lock (Aaron 2026-05-15: Stripe-issued
--                 WYRE-merchant, cards-only at WYRE layer) + DP-K=(a) lock
--                 (require MSP on Pro plan to use reseller-channel-billing).
-- Ticket:         Track C PR-B — Layer B invoice-generation foundation
--
-- Purpose:
--   Introduce `reseller_invoices` + `reseller_invoice_line_items` — the
--   record of WYRE→MSP invoices for reseller-channel-billing.
--
--   Invoicing topology (β-lock):
--     - WYRE bills MSP (reseller-admin org) for marked-up subtenant usage.
--     - One Stripe Customer per MSP under WYRE merchant account.
--     - Card-on-file (no ACH/check at WYRE layer).
--     - MSP→subtenant billing is OUT OF SCOPE for Conduit (MSP handles
--       their own AR off-platform).
--
--   reseller_invoices.id is our internal id; stripe_invoice_id is the
--   Stripe Invoice resource id, populated after Stripe API call. Status
--   reflects Stripe lifecycle (draft → open → paid|uncollectible|void).
--
--   reseller_invoice_line_items: one row per (subtenant_org_id,
--   billing_period). Per-subtenant rollup granularity per DP-I (per-vendor
--   detail deferred v2). zero-usage subtenants skipped per DP-J — no
--   $0 line items emitted.
--
-- Aaron-locked DPs (recap):
--   DP-A: percentage + absolute_per_seat (via reseller_pricing_config)
--   DP-B: platform-account-with-metadata + cards-only
--   DP-G: monthly billing-period cadence
--   DP-H: cron-driven invoice generation at MSP's period-close
--   DP-I: per-subtenant rollup granularity
--   DP-J: skip zero-usage subtenants
--   DP-K: require MSP on Pro plan (gated at service layer via
--         canAccessPaidFeatures, NOT at schema layer — schema admits
--         the row, gate is enforced by the markup-application service)
--
-- Append-only-ish: reseller_invoices ROW can transition statuses
--   (draft→open→paid|uncollectible|void) via UPDATE. line_items are
--   write-once at invoice-generation time and never updated; voiding
--   an invoice does not delete line_items, just transitions the
--   invoice status. Rationale: regulatory audit-of-truth on what we
--   actually billed; voids preserved as evidence.
--
-- =============================================================================
-- RLS shape
-- =============================================================================
--
-- reseller_invoices:
--   SELECT: reseller-admin of MSP-org branch can read (uses mig 023
--           ancestor helper). MSP-side org-members (rare; the MSP IS
--           the org, not a sub-org) can read their own org's invoices
--           via conduit_is_member_of_org. WYRE-admin reads via
--           bypass_rls role outside RLS.
--   INSERT/UPDATE: reseller-admin of MSP-org (service layer in app
--           context; status transitions also from Stripe webhook on
--           bypass-rls connection).
--
-- reseller_invoice_line_items:
--   SELECT: reseller-admin of the parent invoice's MSP-org (joined
--           via reseller_invoices FK).
--   INSERT: reseller-admin of MSP-org (service writes at invoice-gen
--           time).
--   UPDATE/DELETE: not exposed (append-only; voiding lives on the
--           parent invoice status).
--
-- Structural trigger: reseller_invoices.msp_org_id MUST reference an
--   org with type='reseller'. Same enforcement pattern as mig 025.
--
-- Subtenant visibility OUT OF SCOPE for this PR. MSP→subtenant billing
-- is handled off-platform by the MSP; subtenants do not read
-- reseller_invoices (the bill they see is from their MSP, not WYRE).
--
-- =============================================================================
-- Three-pin discipline (sub-pattern #10)
-- =============================================================================
--
-- Pin 1 (docblock): this header — names β-lock + DP-K-gating-at-service
--   layer + append-only-ish status semantics + line-item write-once
--   invariant.
-- Pin 2 (helper): enforce_reseller_invoice_structure trigger names the
--   msp_org_id.type='reseller' invariant.
-- Pin 3 (runtime-check): DO-block audit at apply-time asserts both
--   tables exist with expected columns, RLS enabled+forced, trigger
--   attached, expected policy counts.
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. reseller_invoices — header table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_invoices (
  id                   TEXT PRIMARY KEY,
  -- ON DELETE RESTRICT: invoices are regulatory/billing evidence.
  -- Hard-purge of an MSP-org must explicitly clear invoice history
  -- (GDPR-class operation under bypass_rls), not silently cascade.
  -- Matches the same preserve-evidence principle as
  -- reseller_invoice_line_items.subtenant_org_id ON DELETE RESTRICT.
  msp_org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  period_start         TIMESTAMPTZ NOT NULL,
  period_end           TIMESTAMPTZ NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
  amount_cents         INTEGER NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'USD',
  stripe_invoice_id    TEXT UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoices_status_check'
       AND conrelid = 'reseller_invoices'::regclass
  ) THEN
    -- Statuses mirror Stripe Invoice lifecycle (draft/open/paid/
    -- uncollectible/void) plus 'past_due' for MSP-dunning bridge per
    -- Track A pattern (first_failure_at lives on subscriptions table,
    -- not here; invoice carries a derivable status from Stripe).
    ALTER TABLE reseller_invoices
      ADD CONSTRAINT reseller_invoices_status_check
      CHECK (status IN ('draft', 'open', 'paid', 'past_due', 'uncollectible', 'void'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoices_currency_check'
       AND conrelid = 'reseller_invoices'::regclass
  ) THEN
    ALTER TABLE reseller_invoices
      ADD CONSTRAINT reseller_invoices_currency_check
      CHECK (currency = 'USD');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoices_period_check'
       AND conrelid = 'reseller_invoices'::regclass
  ) THEN
    ALTER TABLE reseller_invoices
      ADD CONSTRAINT reseller_invoices_period_check
      CHECK (period_end > period_start);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoices_amount_check'
       AND conrelid = 'reseller_invoices'::regclass
  ) THEN
    ALTER TABLE reseller_invoices
      ADD CONSTRAINT reseller_invoices_amount_check
      CHECK (amount_cents >= 0);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS reseller_invoices_msp_period_idx
  ON reseller_invoices (msp_org_id, period_start DESC);

CREATE INDEX IF NOT EXISTS reseller_invoices_stripe_idx
  ON reseller_invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- Idempotency: one invoice per (MSP, period_start). Regeneration paths
-- void the existing invoice (status='void') and create a new one with a
-- distinct period_start (corrected period) — never two live invoices for
-- the same (MSP, period). Boss-locked 2026-05-15.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoices_msp_period_unique'
       AND conrelid = 'reseller_invoices'::regclass
  ) THEN
    ALTER TABLE reseller_invoices
      ADD CONSTRAINT reseller_invoices_msp_period_unique
      UNIQUE (msp_org_id, period_start);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. reseller_invoice_line_items — per-subtenant rollup
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_invoice_line_items (
  id                         TEXT PRIMARY KEY,
  invoice_id                 TEXT NOT NULL REFERENCES reseller_invoices(id) ON DELETE CASCADE,
  subtenant_org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  usage_units                INTEGER NOT NULL,
  base_rate_cents            INTEGER NOT NULL,
  markup_applied_cents       INTEGER NOT NULL,
  final_rate_cents           INTEGER NOT NULL,
  source_subscription_id     TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  -- Audit-traceability pointer to the specific reseller_pricing_config
  -- row that produced this line's markup. mig 025 is append-only so the
  -- row WILL exist for the lifetime of the database; ON DELETE SET NULL
  -- preserves the line if a hard-purge ever happens. Without this FK,
  -- a dispute six months out forces (subtenant + period + effective_at)
  -- reconstruction, which is subtle around period boundaries and
  -- retroactive effective_at edits.
  applied_pricing_config_id  TEXT REFERENCES reseller_pricing_config(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_invoice_line_items_amounts_check'
       AND conrelid = 'reseller_invoice_line_items'::regclass
  ) THEN
    -- All amounts non-negative; DP-J enforces upstream (skip-zero-usage)
    -- but the schema accepts >=0 in case future v2 wants zero-usage
    -- audit rows. usage_units > 0 IS enforced because DP-J says zero
    -- skipped; any row that lands here MUST have non-zero usage.
    ALTER TABLE reseller_invoice_line_items
      ADD CONSTRAINT reseller_invoice_line_items_amounts_check
      CHECK (
        usage_units            > 0
        AND base_rate_cents    >= 0
        AND markup_applied_cents >= 0
        AND final_rate_cents   >= 0
        AND final_rate_cents = base_rate_cents + markup_applied_cents
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS reseller_invoice_line_items_invoice_idx
  ON reseller_invoice_line_items (invoice_id);

CREATE INDEX IF NOT EXISTS reseller_invoice_line_items_subtenant_idx
  ON reseller_invoice_line_items (subtenant_org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Structural-invariant trigger on reseller_invoices
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_reseller_invoice_structure()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_msp_type TEXT;
BEGIN
  SELECT type INTO v_msp_type
    FROM organizations
   WHERE id = NEW.msp_org_id;

  IF v_msp_type IS NULL THEN
    RAISE EXCEPTION 'reseller_invoices.msp_org_id % does not exist', NEW.msp_org_id;
  END IF;

  IF v_msp_type IS DISTINCT FROM 'reseller' THEN
    RAISE EXCEPTION
      'reseller_invoices.msp_org_id must reference an org with type=reseller (got %)',
      v_msp_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reseller_invoice_structure ON reseller_invoices;
CREATE TRIGGER trg_enforce_reseller_invoice_structure
  BEFORE INSERT ON reseller_invoices
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reseller_invoice_structure();

-- ---------------------------------------------------------------------------
-- 4. updated_at maintenance for reseller_invoices (status transitions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reseller_invoices_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reseller_invoices_set_updated_at ON reseller_invoices;
CREATE TRIGGER trg_reseller_invoices_set_updated_at
  BEFORE UPDATE ON reseller_invoices
  FOR EACH ROW
  EXECUTE FUNCTION reseller_invoices_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS — reseller_invoices
-- ---------------------------------------------------------------------------
ALTER TABLE reseller_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reseller_invoices_select ON reseller_invoices;
CREATE POLICY reseller_invoices_select ON reseller_invoices
  FOR SELECT
  USING (
       -- Reseller-admin reads their MSP-org's invoices.
       conduit_is_reseller_admin_of_ancestor(
         current_setting('conduit.current_user_id', true),
         msp_org_id
       )
    OR
       -- MSP-org members (the org IS the MSP; org_members on a
       -- reseller-type org cover MSP staff who are not reseller-admins
       -- but are MSP employees). reseller-channel-billing visibility
       -- to MSP staff is reseller-internal — they need to see their
       -- own bill.
       conduit_is_member_of_org(
         current_setting('conduit.current_user_id', true),
         msp_org_id
       )
  );

DROP POLICY IF EXISTS reseller_invoices_insert ON reseller_invoices;
CREATE POLICY reseller_invoices_insert ON reseller_invoices
  FOR INSERT
  WITH CHECK (
    conduit_is_reseller_admin_of_ancestor(
      current_setting('conduit.current_user_id', true),
      msp_org_id
    )
  );

DROP POLICY IF EXISTS reseller_invoices_update ON reseller_invoices;
CREATE POLICY reseller_invoices_update ON reseller_invoices
  FOR UPDATE
  USING (
    conduit_is_reseller_admin_of_ancestor(
      current_setting('conduit.current_user_id', true),
      msp_org_id
    )
  )
  WITH CHECK (
    conduit_is_reseller_admin_of_ancestor(
      current_setting('conduit.current_user_id', true),
      msp_org_id
    )
  );

-- No DELETE policy — invoices are never deleted at application layer.
-- Void = status transition, preserved as audit-of-truth. ON DELETE
-- CASCADE from organizations is still honored for org-purge scenarios
-- (GDPR), which run as bypass_rls.

-- ---------------------------------------------------------------------------
-- 6. RLS — reseller_invoice_line_items
-- ---------------------------------------------------------------------------
ALTER TABLE reseller_invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_invoice_line_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reseller_invoice_line_items_select ON reseller_invoice_line_items;
CREATE POLICY reseller_invoice_line_items_select ON reseller_invoice_line_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM reseller_invoices inv
       WHERE inv.id = reseller_invoice_line_items.invoice_id
         AND (
              conduit_is_reseller_admin_of_ancestor(
                current_setting('conduit.current_user_id', true),
                inv.msp_org_id
              )
           OR conduit_is_member_of_org(
                current_setting('conduit.current_user_id', true),
                inv.msp_org_id
              )
         )
    )
  );

DROP POLICY IF EXISTS reseller_invoice_line_items_insert ON reseller_invoice_line_items;
CREATE POLICY reseller_invoice_line_items_insert ON reseller_invoice_line_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM reseller_invoices inv
       WHERE inv.id = reseller_invoice_line_items.invoice_id
         AND conduit_is_reseller_admin_of_ancestor(
               current_setting('conduit.current_user_id', true),
               inv.msp_org_id
             )
    )
  );

-- No UPDATE/DELETE on line_items — write-once at invoice-gen time.
-- Invoice-level void transitions parent status; line items preserved.

-- ---------------------------------------------------------------------------
-- 7. Apply-time audit (sub-pattern #10 third-pin)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls_inv  BOOLEAN;
  v_rls_li   BOOLEAN;
  v_trg      BOOLEAN;
  v_pol_inv  INTEGER;
  v_pol_li   INTEGER;
BEGIN
  -- Tables exist with expected columns.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'reseller_invoices'
       AND column_name = 'msp_org_id' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'mig 027 audit: reseller_invoices.msp_org_id missing or wrong shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'reseller_invoice_line_items'
       AND column_name = 'invoice_id' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'mig 027 audit: reseller_invoice_line_items.invoice_id missing or wrong shape';
  END IF;

  -- RLS enabled + forced on both.
  SELECT relrowsecurity AND relforcerowsecurity INTO v_rls_inv
    FROM pg_class WHERE relname = 'reseller_invoices';
  IF NOT COALESCE(v_rls_inv, false) THEN
    RAISE EXCEPTION 'mig 027 audit: RLS not enabled+forced on reseller_invoices';
  END IF;
  SELECT relrowsecurity AND relforcerowsecurity INTO v_rls_li
    FROM pg_class WHERE relname = 'reseller_invoice_line_items';
  IF NOT COALESCE(v_rls_li, false) THEN
    RAISE EXCEPTION 'mig 027 audit: RLS not enabled+forced on reseller_invoice_line_items';
  END IF;

  -- Trigger attached.
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_enforce_reseller_invoice_structure'
       AND tgrelid = 'reseller_invoices'::regclass
       AND NOT tgisinternal
  ) INTO v_trg;
  IF NOT v_trg THEN
    RAISE EXCEPTION 'mig 027 audit: structure-enforcement trigger missing on reseller_invoices';
  END IF;

  -- Policy counts: reseller_invoices = 3 (SELECT, INSERT, UPDATE);
  -- reseller_invoice_line_items = 2 (SELECT, INSERT).
  SELECT COUNT(*) INTO v_pol_inv
    FROM pg_policies WHERE tablename = 'reseller_invoices';
  IF v_pol_inv <> 3 THEN
    RAISE EXCEPTION 'mig 027 audit: expected 3 policies on reseller_invoices, found %', v_pol_inv;
  END IF;

  SELECT COUNT(*) INTO v_pol_li
    FROM pg_policies WHERE tablename = 'reseller_invoice_line_items';
  IF v_pol_li <> 2 THEN
    RAISE EXCEPTION 'mig 027 audit: expected 2 policies on reseller_invoice_line_items, found %', v_pol_li;
  END IF;
END$$;

COMMIT;
