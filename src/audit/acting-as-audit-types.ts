// =============================================================================
// src/audit/acting-as-audit-types.ts
//
// LINCHPIN-DROP COMMIT (boss msg-1781439100263, Aaron sprint-continuous):
// schema-ratification replaces the compile-fail placeholder with the
// canonical ActingAsAuditEvent discriminated union. V4-sub-clause resolved
// as B (transactional security-notice; customer-org-owner-email recipient
// + notification fires by-construction at session_started boundary).
//
// Ratifies all triangle items from PR #386:
//   - Warden Angle 1 (linchpin hardening): self-decommissioning CI-test
//     deleted alongside this placeholder-replacement (by design — see
//     test file docstring).
//   - Warden Angle 2 (LIFECYCLE-BIND): revoke-event variant included.
//   - Analyst Item 1 (type-level required-ness): preserved.
//   - Analyst Item 2 (FIELD-NAMING discriminated-union evolution-path):
//     pinned in CallerContext docstring + this schema is shape-discriminated
//     by `type` field, accommodating future 3rd-party-IdP variants without
//     breaking change.
//   - Analyst Item 3 (event-name semantic-cut): msp_operator_session_*
//     family (NOT msp_acting_as_customer_session_*).
//   - Analyst Item 4 (Auth0 Organizations primitive contract): the
//     resellerOrgId + customerOrgId fields are storage-orthogonal to
//     Auth0's organization concept — this schema records the org-tier
//     concept; dev's slice-3 maps to Auth0 Organizations independently.
//   - Ruby Finding 1 (SCOPE-vs-AUTHORIZATION doc-comment): pinned at
//     CallerContext.actingAs docstring + here at event-payload docstring.
//   - Ruby Finding 2 (regression-test): lives in effective-scope.test.ts.
//   - V4=B (transactional security-notice): recipient field on
//     session_started variant + by-construction notification at fire.
//
// =============================================================================

/**
 * MSP-as-OPERATOR audit events. Three-variant discriminated union:
 *
 * 1. session_started — caller activates "Switch to customer org" session.
 *    Fires the V4=B transactional security-notice to customer-org owner
 *    by-construction (the emit-side wraps the event-write with the
 *    notification-fire; absence of either = data-integrity violation).
 *
 * 2. session_ended — caller voluntarily exits acting-as session.
 *
 * 3. session_revoked — system invalidates session mid-flight per the
 *    LIFECYCLE-BIND 3-check live-authz revalidation (warden Angle 2).
 *    Distinct from session_ended because revocation IS NOT actor-initiated;
 *    the audit-trail must distinguish "actor chose to exit" from "system
 *    revoked authority."
 *
 * AUTHORITY/SCOPE LAYERING (ruby Finding 1):
 *   - These events RECORD what happened in the SCOPE-EVALUATION layer.
 *   - They are NEVER inputs to the AUTHORIZATION layer.
 *   - A future refactor that reads these events to grant authority would
 *     violate the layer-separation. The regression-test in
 *     effective-scope.test.ts guards the runtime side; this docstring
 *     guards the design side.
 *
 * DISCRIMINATED-UNION EVOLUTION (analyst Item 2):
 *   - The `type` field is the discriminator. Future variants (e.g., if
 *     3rd-party-IdP authority-sources ship) add new `type` literals with
 *     their own payload shapes. Existing consumers narrow via type-discrim;
 *     no breaking change at the existing variants.
 *   - viaResellerOrgId on session_started/_ended/_revoked is OK to keep
 *     reseller-explicit (rather than generalizing to viaAuthorityOrgId)
 *     because each variant is named-substrate; cross-variant generalization
 *     would lose audit-event clarity.
 */
export type ActingAsAuditEvent =
  | ActingAsSessionStartedEvent
  | ActingAsSessionEndedEvent
  | ActingAsSessionRevokedEvent;

/**
 * Caller activated "Switch to customer org" session. Fires V4=B transactional
 * security-notice to customer-org owner by-construction at the emit boundary.
 */
export interface ActingAsSessionStartedEvent {
  type: 'msp_operator_session_started';
  /** Authority-source: reseller-org granting the actor's right to act-as. */
  resellerOrgId: string;
  /** Scope: customer-org being acted-on. */
  customerOrgId: string;
  /** Actor user identity (the reseller-admin). */
  actorUserId: string;
  /** Session start timestamp (ISO 8601). */
  sessionStartedAt: string;
  /** Request IP at session-start (audit-trail context); null if unavailable. */
  ip: string | null;
  /** Request user-agent at session-start; null if unavailable. */
  userAgent: string | null;
  /**
   * V4=B recipient field — customer-org owner email at session-start time.
   * The emit boundary uses this to fire the transactional security-notice
   * by-construction (data-integrity invariant: this field MUST be the
   * email currently owning the customerOrgId at fire-time, NOT a cached
   * value, so the notification reaches the current owner even after
   * ownership transfers).
   */
  customerOrgOwnerEmail: string;
}

/** Caller voluntarily ended acting-as session. */
export interface ActingAsSessionEndedEvent {
  type: 'msp_operator_session_ended';
  resellerOrgId: string;
  customerOrgId: string;
  actorUserId: string;
  /** Original session-start timestamp (for accountability-window duration). */
  sessionStartedAt: string;
  /** Voluntary-exit timestamp (ISO 8601). */
  sessionEndedAt: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * System-initiated session revocation per the LIFECYCLE-BIND 3-check
 * live-authz revalidation (warden Angle 2). Distinct from session_ended.
 */
export interface ActingAsSessionRevokedEvent {
  type: 'msp_operator_session_revoked';
  resellerOrgId: string;
  customerOrgId: string;
  actorUserId: string;
  sessionStartedAt: string;
  /** Revocation timestamp (ISO 8601). */
  revokedAt: string;
  /**
   * Revocation reason — maps to the 3-check live-authz revalidation cases
   * from src/reseller/operator-routes.ts LIFECYCLE-BIND comment, plus
   * actor-initiated-elsewhere (e.g., admin-side force-revoke).
   */
  revokeReason:
    | 'actor_removed_from_reseller'      // check 1 failed
    | 'role_demoted_below_admin'         // check 2 failed
    | 'customer_unparented_from_reseller' // check 3 failed (parent-relationship)
    | 'customer_archived'                 // check 3 failed (suspended_at set OR row absent)
    // LAYER-C deleted-customer reason (mig 053 + boss msg-1781750604363
    // warden VERIFY-1 extension). Split from customer_archived so the
    // forensics surface can distinguish operator-pause-revoke from
    // operator-delete-revoke. Fires when the middleware revalidate
    // detects `customer.deletedAt` is set OR the soft-delete route
    // fires its explicit cascade.
    | 'customer_deleted'                  // check 3 failed (deleted_at set)
    | 'admin_force_revoked';              // out-of-band admin action
  ip: string | null;
  userAgent: string | null;
}
