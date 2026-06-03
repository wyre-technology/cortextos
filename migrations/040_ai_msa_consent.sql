-- 040_ai_msa_consent.sql
--
-- WYREAI-98: AI MSA accept-at-signup consent recording (Aaron 2026-06-02
-- pivot to wire-existing-MSA-not-draft-new at https://docs.ourterms.live/
-- WYRE/AI-Attachment.pdf).
--
-- ARCHITECTURE-OF-RECORD: WYREAI-98 issue body holds the canonical contract.
-- This migration implements the schema side of that contract:
--
--   - `org_consents`: the BINDING legal record. One row per accepted MSA
--     version per org. Org-scoped per scribe's 2026-06-02 lean (an MSA is a
--     WYRE↔Customer-org contract signed by an authorized admin; per-user
--     acceptance is a user-AUP shape, not an MSA shape). Carries the
--     SHA256-at-consent-time `document_version` as cryptographic evidence of
--     EXACTLY which bytes the signatory accepted. `document_size_bytes` is
--     the cheap-detector belt-and-suspenders for mismatch-canary use cases
--     (pre-hash size-mismatch detection); the SHA is the load-bearing
--     canonical-change-detection primitive. Both serve the next-reader at
--     different cost/precision points (cheap-detector + load-bearing-decider
--     paired-canary pattern — boss/scribe-banked 2026-06-02).
--
--   - `user_consent_acknowledgments`: the INFORMATIONAL user-layer over the
--     binding org-record. Each user clicks "I acknowledge the MSA" on first
--     org-access post-accept; the click writes here. NOT a binding record
--     unless Aaron+counsel over-rule scribe's org-scoped lean (in which
--     case this becomes the binding shape OR merges into org_consents with
--     a different scope-flag). Schema is positioned for that flip without
--     disruption — both tables share the SHA256 contract via the FK to
--     org_consents.
--
-- THREE [ARCHITECTURE-DECISION] flags remain in WYREAI-98 body pending
-- Aaron+counsel resolution. This migration does not pre-commit any of them:
--   1. Material-change classification ownership: scribe + Aaron-legal call
--      per update; no SHA-diff-threshold auto-re-accept (cryptographic-
--      layer + policy-layer cleanly separated per scribe's 2026-06-02
--      pin — canary alerts, human decides).
--   2. User-vs-org-scoped acceptance: scribe + pearl lean = org-scoped
--      binding with informational user-layer; Aaron+counsel confirm at
--      fact-fills step. Schema models org-scoped now; informational layer
--      exists alongside.
--   3. Who CAN accept on behalf of the org: scribe + pearl lean = owner-
--      only-first-accept, owner-or-admin-re-accept. Enforced at the
--      application layer (signup-flow + admin re-accept handler), NOT in
--      SQL — the role-gate lives in the route handler so it can read the
--      current org_members.role at handler-time without SQL coupling.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS org_consents (
  -- Synthetic id; nanoid in application layer.
  id                   TEXT        PRIMARY KEY,
  -- Bound to organizations(id) — cascade on org-delete (gone-org has no
  -- need for its prior consent record; the admin_audit_log entry preserves
  -- the history-of-acceptance independently of this table).
  org_id               TEXT        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Constrained string for now ('ai_msa'); extend the CHECK if Aaron adds
  -- other consent types (e.g. AUP, DPA) later. Discriminator for queries
  -- and for the unique-current-row constraint below.
  consent_type         TEXT        NOT NULL CHECK (consent_type IN ('ai_msa')),
  -- Canonical PDF URL as displayed-and-clicked at consent moment.
  document_url         TEXT        NOT NULL,
  -- SHA256 hex of the PDF bytes at consent-time. 64-char hex string.
  -- CRYPTOGRAPHIC layer: mechanical evidence of which bytes were accepted.
  document_version     TEXT        NOT NULL CHECK (char_length(document_version) = 64),
  -- Raw byte count at consent-time. Cheap pre-hash mismatch canary.
  document_size_bytes  BIGINT      NOT NULL CHECK (document_size_bytes >= 0),
  -- The authorized signatory (owner-only-first-accept / owner-or-admin-
  -- re-accept per pending [ARCHITECTURE-DECISION] #3). Set-null on
  -- user-delete preserves the consent record's existence; identity of the
  -- signatory at-the-moment-of-signing lives additionally in
  -- admin_audit_log so user-deletion doesn't lose the audit-trail.
  accepted_by_user_id  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  accepted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_ip          TEXT,
  user_agent           TEXT,
  -- Audit fields (CREATE/UPDATE) consistent with the rest of the schema.
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Find-the-current-consent index. Multiple rows per (org_id, consent_type)
-- are intentional — when a material-change re-accept happens, a NEW row is
-- inserted (NOT an UPDATE of the prior row), so the history of accepted
-- versions is preserved by-construction. The current row is the
-- newest-by-accepted_at; queries use ORDER BY accepted_at DESC LIMIT 1.
-- Same newest-row-authoritative pattern as `subscriptions` (post-#291
-- cutover-grace seed). DO NOT add a UNIQUE constraint on
-- (org_id, consent_type) — that would prevent the re-accept INSERT.
CREATE INDEX IF NOT EXISTS idx_org_consents_org_type_accepted
  ON org_consents (org_id, consent_type, accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_org_consents_document_version
  ON org_consents (document_version);

-- ---------------------------------------------------------------------------
-- user_consent_acknowledgments: informational user-layer over org_consents.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_consent_acknowledgments (
  id              TEXT        PRIMARY KEY,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          TEXT        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- FK to the org_consents row this acknowledgment is bound to. If the org
  -- ever re-accepts (new org_consents row), each user re-acknowledges
  -- (new user_consent_acknowledgments row).
  consent_id      TEXT        NOT NULL REFERENCES org_consents(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_ip TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One acknowledgment per (user, consent_id). Re-rendering the
-- acknowledgment UI is a no-op once the row exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_consent_ack_user_consent
  ON user_consent_acknowledgments (user_id, consent_id);

-- Fast lookup: does THIS user need to acknowledge the CURRENT consent for
-- THIS org? Query shape: SELECT 1 FROM user_consent_acknowledgments WHERE
-- user_id = $1 AND consent_id = (newest org_consents for org). The
-- (org_id) index supports the by-org listing for admin views.
CREATE INDEX IF NOT EXISTS idx_user_consent_ack_org
  ON user_consent_acknowledgments (org_id);

-- ---------------------------------------------------------------------------
-- signup_intents extension: carry the SHA-at-click-time across the
-- Auth0-callback hop, so the SHA recorded in org_consents at user+org
-- materialization matches EXACTLY the bytes the user saw at /signup.
-- ---------------------------------------------------------------------------
--
-- Without these columns, the callback would have to re-fetch + re-SHA the
-- PDF, and in the (rare) case where the PDF changes between /signup POST
-- and the Auth0 callback returning, the recorded SHA would differ from
-- what the user actually accepted. Capturing at click-time eliminates the
-- race window. NULL is allowed because legacy signup_intents (pre-this
-- migration) don't have consent fields; the callback treats NULL as
-- "no consent recorded at signup" and either prompts a post-creation
-- accept (if the org gets created without consent) OR rejects the
-- callback (if consent is required for callback completion; route-handler
-- decision).

ALTER TABLE signup_intents
  ADD COLUMN IF NOT EXISTS consent_accepted             BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_document_url         TEXT,
  ADD COLUMN IF NOT EXISTS consent_document_version     TEXT
    CHECK (consent_document_version IS NULL OR char_length(consent_document_version) = 64),
  ADD COLUMN IF NOT EXISTS consent_document_size_bytes  BIGINT
    CHECK (consent_document_size_bytes IS NULL OR consent_document_size_bytes >= 0),
  ADD COLUMN IF NOT EXISTS consent_accepted_at          TIMESTAMPTZ;
