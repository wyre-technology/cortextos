-- =============================================================================
-- Migration:      041_invitation_owner_swap.sql
-- Date:           2026-06-03
-- Linear:         WYREAI-118 + WYREAI-119 (E1 PR-1 backend collapse under
--                 WYREAI-117 admin create-org launch-blocker)
--
-- Purpose:
--   Extend org_invitations to support invitation-driven ownership-transfer
--   from an admin-stub-owner (placed at /admin/orgs creation) to the
--   intended owner (the email the admin invites). When the invitation is
--   accepted, the placeholder owner is replaced atomically by the invited
--   user — a NARROWED DELETE predicate that swaps the specific stub-owner
--   only (NOT all-other-owners, which would silently wipe legitimate co-
--   owners and re-introduce the customer-create blanket-DELETE warning
--   from invitation-service.ts:333-340).
--
--   The existing customer-create → first-owner-claim transition uses an
--   atomic-swap with DELETE-all-other-owners; that path stays untouched
--   (invite_type = 'member_join' default + existing logic). The new path
--   (invite_type = 'owner_swap_to_invited') swaps the specific stub-owner
--   recorded at create-time via swap_from_user_id.
--
-- Schema additions:
--   - invite_type        — discriminator: 'member_join' (default,
--                          backward-compatible) | 'owner_swap_to_invited'.
--   - swap_from_user_id  — the stub-owner user_id to swap from (NOT NULL
--                          when invite_type='owner_swap_to_invited',
--                          NULL otherwise). FK to users(id) ON DELETE
--                          SET NULL preserves the invitation row's
--                          existence if the stub user gets removed.
--
-- Schema invariants (CHECK + idempotent guards):
--   - invite_type ∈ ('member_join','owner_swap_to_invited')
--   - swap_from_user_id IS NOT NULL ⇔ invite_type = 'owner_swap_to_invited'
--
-- WARDEN-WARNED PATTERN: see invitation-service.ts lines 333-340 — the
-- existing DELETE-all-others is correct for customer-create → first-
-- owner-claim, but DESTRUCTIVE for any owner-transfer use case. The
-- swap_from_user_id column lets the new path narrow the DELETE to the
-- specific interim-owner, preserving the warning's intent at the
-- schema layer (paired-canary discipline: schema-side discriminator
-- + service-side narrowed-DELETE = construction-side enforcement).
-- =============================================================================

BEGIN;

ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS invite_type TEXT NOT NULL DEFAULT 'member_join';

ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS swap_from_user_id TEXT
    REFERENCES users(id) ON DELETE SET NULL;

-- invite_type CHECK (idempotent guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_invitations_invite_type_check'
       AND conrelid = 'org_invitations'::regclass
  ) THEN
    ALTER TABLE org_invitations
      ADD CONSTRAINT org_invitations_invite_type_check
        CHECK (invite_type IN ('member_join', 'owner_swap_to_invited'));
  END IF;
END $$;

-- Discriminator-consistency invariant: swap_from_user_id required iff
-- invite_type = 'owner_swap_to_invited'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_invitations_swap_consistency_check'
       AND conrelid = 'org_invitations'::regclass
  ) THEN
    ALTER TABLE org_invitations
      ADD CONSTRAINT org_invitations_swap_consistency_check
        CHECK (
          (invite_type = 'owner_swap_to_invited' AND swap_from_user_id IS NOT NULL)
          OR
          (invite_type <> 'owner_swap_to_invited' AND swap_from_user_id IS NULL)
        );
  END IF;
END $$;

COMMIT;
