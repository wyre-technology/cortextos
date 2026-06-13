-- 045_brand_template_overrides.sql
--
-- RC2 PR-A — Brand-resolver escape-hatch for per-reseller template overrides
-- on the 15+ transactional/Loops fire-sites. Boss-locked HYBRID strategy at
-- msg-1780673136515: single-slug-with-merge-tags is the DEFAULT path (~95%
-- of resellers); per-reseller-slug-override is the OPT-IN ESCAPE-HATCH for
-- resellers who need bespoke copy. This migration adds the storage substrate
-- for the override.
--
-- ARCHITECTURE-OF-RECORD: dev coord msg-1780675534858 (division-of-labor) +
-- msg-1780675609808 (3 leans confirmed) + msg-1780675648001 (scope locked).
-- The 4 [ARCHITECTURE-DECISION] flags pending Aaron+counsel review:
--   1. Template-override schema shape: Record<EventName, SlugName> JSONB
--      (vs richer per-tenant template-config; this PR commits to the simpler
--      shape pending Aaron-tier-feature-scope decision)
--   2. Escape-boundary site: brand-resolver toBrandConfig (vs per-template
--      defensive escape; this PR commits to single-point at resolver per
--      attacker-influenced-value-flowing-into-rendered-output-requires-escape-
--      at-seam pin at N=2 cross-cycle)
--   3. Cache strategy: existing 60s TTL preserved (vs RC2-load-revisit;
--      defer to warden review during PR-A triangle)
--   4. LoopsEventName ownership: dev's PR-B (per architecture-of-record-at-
--      the-artifact — union lives at consumer-site, not reference-site)
--
-- The column is NULL-able + defaults NULL. NULL = no override = use default
-- slug + merge-tags (the ~95% case). Non-NULL = JSONB object mapping
-- event-name strings to override-slug strings. Schema-side validates valid
-- JSON object via CHECK constraint; runtime LoopsEventName narrowing is
-- consumer-discipline (dev's PR-B).
--
-- Trust-on-write per the existing brand_profiles update pattern: schema
-- accepts any Record<string, string>; the LoopsEventName union enforced at
-- the brand-update API handler (deferred) reads the union when it lands.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.

ALTER TABLE brand_profiles
  ADD COLUMN IF NOT EXISTS template_overrides JSONB;

-- Constraint: when present, must be a JSON object (not array/scalar). A null
-- value is allowed (=no overrides for this brand); a non-null value MUST be
-- an object whose keys map to override-slug strings. The per-value type
-- (string) isn't enforced in SQL — that's consumer-discipline via the
-- LoopsEventName union type in PR-B. SQL guards the SHAPE (object); TS
-- guards the CONTENTS (event-name keys + slug-name values).
--
-- Idempotent CHECK constraint via the DO $$ + pg_constraint-lookup pattern
-- (same shape as migration 041_invitation_owner_swap.sql:invite_type_check —
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints, so
-- the conditional ADD lives in a DO block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brand_profiles_template_overrides_is_object'
  ) THEN
    ALTER TABLE brand_profiles
      ADD CONSTRAINT brand_profiles_template_overrides_is_object
      CHECK (template_overrides IS NULL OR jsonb_typeof(template_overrides) = 'object');
  END IF;
END $$;
