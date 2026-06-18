/**
 * Caller-tier resolver — maps the caller's organizational role to a
 * `PermissionTier` for the Phase-2 runtime gate (src/auth/tier-check.ts).
 *
 * Decision (boss-locked 2026-06-18 per Phase-2 dispatch 1781788686408):
 *   - owner  → admin
 *   - admin  → admin
 *   - member → write
 *
 * Reasoning: owner+admin are privileged operator roles (manage org/customers,
 * remediation including admin-tier destructive/RCE tools). Member is the
 * regular technician role (read + write, NO admin-destructive/RCE). Per-user
 * override is Phase-3+ if ever needed; per-org policy is Phase-3+ if ever
 * needed.
 *
 * FAIL-CLOSED on null role (unresolvable caller) — every caller MUST have a
 * resolved OrgRole; absence is a bug, not a "treat as read" silent default.
 *
 * ActingAs (per #398 LIFECYCLE-BIND + #441 audit-triplet) uses the same
 * mapping over `actingAs.effectiveRole` so an operator acting on behalf of a
 * customer-org gets whatever tier the customer-org-role-mapping would give
 * them. Symmetric with how `scopeAllows` operates on `actingAs.effectiveRole`.
 */
import type { PermissionTier } from './tier-check.js';
import type { OrgRole } from '../org/org-service.js';

/**
 * OrgRole → PermissionTier deterministic map. Pure, total, branch-coverage-
 * tested. Returns null for an unknown role string (FAIL-CLOSED downstream).
 */
export function tierForOrgRole(role: OrgRole | null | undefined): PermissionTier | null {
  if (!role) return null;
  switch (role) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'member':
      return 'write';
    default:
      // TypeScript exhaustive guard — an unknown role string at runtime
      // (e.g. a future OrgRole addition not yet mapped here) FAIL-CLOSED-denies.
      return null;
  }
}
