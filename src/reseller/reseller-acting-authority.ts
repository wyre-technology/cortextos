/**
 * verifyResellerActingAuthority — shared primitive that BOTH the
 * /switch entry-point (authorizeResellerAdminOnCustomer) and the
 * /every-request middleware (acting-as-middleware.revalidate) consume.
 *
 * Ruby triangle-leg MED finding on PR #398 (msg-1781540808207):
 * duplicated 3-invariant verification across two surfaces is a
 * drift-bug-class — if either implementation's role-threshold or field-
 * name diverges, sessions start successfully then immediately revoke
 * (the canonical bites-at-launch failure mode). Closes by-construction
 * via single shared primitive; both consumers funnel through here.
 *
 * Sign-axis:
 *   - This primitive is the SINGLE SOURCE OF TRUTH for actingAs
 *     authority. Future RBAC tightening (e.g., role threshold change,
 *     new check 4) flows through ONE site, never two.
 *   - Reasons returned mirror the ratified ActingAsAuditEvent
 *     ['msp_operator_session_revoked'].revokeReason union, so the
 *     middleware can pipe straight to revoke + emit without an extra
 *     translation step.
 *
 * Scope discipline:
 *   - The primitive runs the 3 reads under runAsSystem (cross-org
 *     correctness — actor is reseller-member, NOT customer-member;
 *     see acting-as-middleware.ts revalidate() docstring for full
 *     RLS rationale + delta from PR #371/#373/#375 hang class).
 *   - Caller-side wraps the result: middleware maps deny -> revoke +
 *     audit-event; /switch entry-point maps deny -> 403 response.
 *     Different surfaces, identical authority claim.
 */

import { runAsSystem } from '../db/context.js';
import { ROLE_LEVEL, type OrgRole, type Organization, type OrgService } from '../org/org-service.js';

const RESELLER_ADMIN_MIN_ROLE: OrgRole = 'admin';

/**
 * Failure-discriminator vocabulary mirrored from the ratified
 * ActingAsAuditEvent['msp_operator_session_revoked'].revokeReason union
 * (src/audit/acting-as-audit-types.ts). Single source of truth across
 * row column + audit-event payload + this primitive's deny path.
 */
export type ResellerActingAuthorityDenyReason =
  | 'actor_removed_from_reseller'
  | 'role_demoted_below_admin'
  | 'customer_archived'
  // LAYER-C destructive-lifecycle distinguishability (boss
  // msg-1781750604363 warden VERIFY-1 extension). Pre-LAYER-C the
  // single `customer_archived` reason covered hard-deleted-row +
  // suspended state (no soft-delete existed). With mig 053 adding
  // `organizations.deleted_at` for the LAYER-C soft-delete flow,
  // we split the reason so forensics + the audit-revoke event union
  // can distinguish "operator paused this customer" (suspended_at
  // set → customer_archived) from "operator soft-deleted this
  // customer" (deleted_at set → customer_deleted). Hard-delete-by-
  // sweeper future case stays on customer_archived for backward-
  // compat (the row is absent → same semantic as the current path).
  | 'customer_deleted'
  | 'customer_unparented_from_reseller';

export type ResellerActingAuthorityResult =
  | {
      ok: true;
      /** The actor's confirmed membership on the reseller-org. */
      role: OrgRole;
      /** The customer-org, freshly loaded under BYPASSRLS. */
      customerOrg: Organization;
    }
  | { ok: false; reason: ResellerActingAuthorityDenyReason };

/**
 * Verify the 3 LIFECYCLE-BIND invariants:
 *   (1) Caller IS STILL member of viaResellerOrgId
 *   (1b) Role >= reseller_admin
 *   (2) Customer-org's parentOrgId === viaResellerOrgId
 *   (3) Customer-org not hard-deleted (getOrg returns non-null)
 *
 * Both reads wrap in a SINGLE runAsSystem so cross-org RLS doesn't
 * mask a real reseller-customer pair (the actor is a member of the
 * reseller-org but NOT the customer-org by design).
 */
export async function verifyResellerActingAuthority(
  orgService: Pick<OrgService, 'getMembership' | 'getOrg'>,
  userId: string,
  viaResellerOrgId: string,
  onBehalfOfOrgId: string,
): Promise<ResellerActingAuthorityResult> {
  return runAsSystem(async () => {
    // Check 1 — Caller is STILL a member of the reseller-org.
    const resellerMembership = await orgService
      .getMembership(viaResellerOrgId, userId)
      .catch(() => null);
    if (!resellerMembership) {
      return { ok: false, reason: 'actor_removed_from_reseller' } as const;
    }

    // Check 1b — Membership exists but role demoted below the
    // reseller-admin threshold. Discriminator separation matters for
    // the audit-trail: "removed" vs "demoted" surface different upstream
    // events (user removed from org vs user's role changed).
    const role = resellerMembership.role as OrgRole;
    if (ROLE_LEVEL[role] < ROLE_LEVEL[RESELLER_ADMIN_MIN_ROLE]) {
      return { ok: false, reason: 'role_demoted_below_admin' } as const;
    }

    // Check 2+3 — Customer-of-reseller FK chain intact + customer-org
    // not retired (suspended OR soft-deleted) + not hard-deleted.
    //
    // Mig 012 added organizations.suspended_at, mig 053 added
    // organizations.deleted_at — both are LAYER-C retired-state
    // markers (boss msg-1781747082572 + msg-1781750604363). The
    // middleware MUST reject acting-as on EITHER state, otherwise:
    //   - Suspended-but-impersonable: the operator suspended a
    //     customer "to stop everything" but acting-as still works →
    //     contradicts operator intent.
    //   - Soft-deleted-but-impersonable: the operator soft-deleted
    //     a customer (pending sweeper hard-delete) but acting-as
    //     still works → soft-delete has no other cascade primitive
    //     post-mig-054, so this IS the cascade. Without this check
    //     the column-split (deleted_at vs suspended_at) silently
    //     reopens the impersonation hole that the suspend cascade
    //     closed.
    //
    // Discriminator split (warden VERIFY-1 extension):
    //   - suspended_at set → 'customer_archived' (operator-pause
    //     semantic — pre-mig-054 single-column case kept on this
    //     reason for backward-compat with prior audit-event rows)
    //   - deleted_at set → 'customer_deleted' (operator-delete
    //     semantic — new in mig 053, dedicated reason so forensics
    //     can distinguish operator-pause from operator-delete on
    //     msp_operator_session_revoked events)
    //   - row absent → 'customer_archived' (existing hard-delete
    //     path — semantically closest to "customer no longer
    //     exists"; kept on this reason for backward-compat)
    //
    // Order of checks matters: deleted_at takes precedence over
    // suspended_at on the discriminator (a row with BOTH columns set
    // means the operator suspended THEN deleted — the deleted state
    // is the latest/dominant intent for the audit-revoke).
    const customer = await orgService.getOrg(onBehalfOfOrgId).catch(() => null);
    if (!customer) return { ok: false, reason: 'customer_archived' } as const;
    if (customer.parentOrgId !== viaResellerOrgId) {
      return { ok: false, reason: 'customer_unparented_from_reseller' } as const;
    }
    if (customer.deletedAt) {
      return { ok: false, reason: 'customer_deleted' } as const;
    }
    if (customer.suspendedAt) {
      return { ok: false, reason: 'customer_archived' } as const;
    }

    return { ok: true, role, customerOrg: customer } as const;
  });
}
