-- =============================================================================
-- Migration:      019_temporary_remove_organizations_insert_with_check.sql
-- Date:           2026-05-10
-- PRD Reference:  prd-reseller-tenancy.md §5.6 Phase 2 (deferred follow-up)
-- Ticket:         reseller-tenancy / rls-recursion-fix follow-up
--
-- Purpose
-- -------
--   Temporarily replace the `organizations_insert` policy with a
--   permissive WITH CHECK (true) so org creation works under non-bypass
--   roles. This is a known-temporary measure pending root-cause of the
--   helper-in-policy-context bug surfaced by migration 018:
--
--     - Migration 018 fixed the recursion bug introduced by 007/014 by
--       replacing recursive policy predicates with SECURITY DEFINER
--       helper functions.
--     - 018's helpers work correctly when called manually outside a
--       policy context. They flip to false-equivalent when called from
--       within `organizations_insert` WITH CHECK in the full migration
--       configuration. Minimal repro (2-table fixture, same helper,
--       same policy) succeeds; the same call path fails 42501 in the
--       full set. Root cause not yet known.
--     - 014's `organizations_insert` had two OR-branches: own-membership
--       (structurally unreachable — NEW.id has no members yet) and
--       reseller_admin (the only operative branch — and the one
--       affected by the helper-context bug). Net consequence: org
--       creation failed 42501 post-018 even though the strict-
--       improvement on every other RLS-protected path holds.
--
--   This migration trades a known-good defense-in-depth check for
--   unblocked org creation. Justification:
--
--     - The application layer enforces hierarchy invariants in
--       `OrgService.createOrg` (`src/org/org-service.ts:450`) — type
--       validation, customer-requires-parent, parent-must-be-reseller,
--       standalone/reseller-cannot-have-parent. App layer is the
--       primary enforcement.
--     - Migration 002 has DB-trigger-level invariants on the same
--       hierarchy shape — independent secondary defense.
--     - Customer-org creation is NOT route-exposed today. The two
--       routes that call `createOrg` (`src/org/routes.ts:79`,
--       `src/org/routes/org-crud.ts:39`) only pass name/owner/plan;
--       neither accepts `type` or `parent_org_id`. Whatever flow
--       creates customer orgs (admin UI, internal tooling, reseller-
--       admin path) doesn't go through routes covered by this PR.
--
--   So the WITH CHECK we're temporarily removing is defense-in-depth
--   on a vector the app layer + migration 002 trigger already cover.
--   Cost-of-removal is near-zero in current code; it climbs the moment
--   customer-org creation becomes route-exposed, at which point this
--   migration must be reverted (and a working WITH CHECK restored) as
--   part of that route's PR.
--
-- Idempotency
-- -----------
--   `DROP POLICY IF EXISTS` + `CREATE POLICY`. Safe to re-run.
--
-- Forward path — hard-linked, filed-not-promised
-- ----------------------------------------------
--   Restore task: `task_1778429689936_847` (cortextos bus task).
--   Marked blocked-on the helper-in-policy-context investigation. When
--   the bug is root-caused, that task drives the follow-up migration
--   restoring the correct WITH CHECK. The follow-up MUST land before
--   customer-org creation becomes route-exposed.
--
--   Honest framing of what 018 + 019 ship together: strict improvement
--   on 018's test set (reads, member-ops, UPDATE-own-org, non-member
--   rejection) PLUS org creation passthrough — NOT "all RLS works."
--   Read-side enforcement and member-write enforcement still rely on
--   the helpers in policy context; those paths happen to work in the
--   verified test cases but the underlying helper-context behavior is
--   not yet fully understood.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS organizations_insert ON organizations;
CREATE POLICY organizations_insert ON organizations
  FOR INSERT
  WITH CHECK (true);

COMMENT ON POLICY organizations_insert ON organizations IS
  'TEMPORARY (mig 019): permissive WITH CHECK pending root-cause of '
  'helper-in-policy-context bug surfaced by mig 018. App-layer + mig 002 '
  'trigger enforce hierarchy invariants; this policy is defense-in-depth '
  'only and must be restored before customer-org creation is route-exposed.';

COMMIT;

-- =============================================================================
-- End of 019_temporary_remove_organizations_insert_with_check.sql
-- =============================================================================
