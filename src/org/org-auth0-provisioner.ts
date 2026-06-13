/**
 * Org Auth0 provisioner — the seam between createOrg and the Auth0
 * Management API peer-create.
 *
 * Multi-IdP foundation slice 3 (June 29 launch directive 2026-06-13):
 *   The slice-2 Auth0ManagementClient (PR #381) ships the operations;
 *   this seam is the injection point that wires them into createOrg
 *   under BOTH-OR-NEITHER discipline. Mirrors the shape of
 *   src/org/org-billing-provisioner.ts (Stripe-side peer-create at
 *   org-create moment) — both run at createOrg as side-effects on the
 *   newly-minted orgId, both are injected via setters on OrgService
 *   construction so tests can omit them cleanly.
 *
 * BOTH-OR-NEITHER discipline:
 *   The Auth0 call runs BEFORE the DB INSERT (vs the billing provisioner
 *   which runs AFTER). Order rationale:
 *
 *   - If Auth0 createOrganization fails: NO DB writes happen, NOTHING to
 *     roll back. The provisioner throws; createOrg propagates the error;
 *     the HTTP layer surfaces it as 503-temporarily-unavailable.
 *
 *   - If the DB INSERT fails AFTER Auth0 createOrganization succeeded:
 *     we have an orphan Auth0 Org peer with no Conduit org. createOrg
 *     wraps the DB INSERT in try/catch and calls deleteOrganization to
 *     reverse the Auth0-side state before re-throwing.
 *
 *   This ordering guarantees the BOTH-OR-NEITHER invariant at the
 *   substrate level — there's no transient "DB row exists, Auth0 Org
 *   doesn't" state visible to readers in between the two writes.
 *
 * Name derivation:
 *   Auth0 Org names must be alphanumeric + hyphens, lowercase, and
 *   unique. We derive from orgId (a nanoid, already alphanumeric +
 *   case-insensitive) with a `conduit-` prefix to keep them visually
 *   distinguishable from any human-created Auth0 Orgs in the dashboard.
 *   Display name carries the human-readable Conduit org name verbatim.
 *
 * Metadata:
 *   We stamp the Conduit orgId + org-type on the Auth0 Org's metadata so
 *   the reverse-lookup (Auth0 Org id → Conduit org) is queryable from
 *   the Auth0 dashboard without needing a separate Conduit query. Helps
 *   ops in incident reviews. The actual Conduit → Auth0 lookup uses the
 *   organizations.auth0_org_id column (mig 046).
 *
 * Skip semantics:
 *   When the Auth0ManagementClient is unavailable (M2M creds unset, dev/
 *   test environments), createAuth0OrgProvisioner returns null and the
 *   OrgService setter is never invoked — every createOrg falls through
 *   to the legacy null-auth0OrgId path.
 */

import type { Auth0ManagementClient } from '../auth/auth0-management.js';
import type { OrgType } from './org-service.js';

export interface OrgAuth0ProvisionInputs {
  /** The to-be-inserted org's id — nanoid, alphanumeric, lowercase. */
  orgId: string;
  /** Human-readable org name; passed through as Auth0 display_name. */
  orgName: string;
  /** Org type — recorded on Auth0 metadata for ops-visibility round-trip. */
  orgType: OrgType;
}

export interface OrgAuth0ProvisionResult {
  /** Auth0 Org id (`org_<alnum>`) — persisted to organizations.auth0_org_id. */
  auth0OrgId: string;
}

/**
 * Injected into OrgService; called from createOrg BEFORE the DB INSERT
 * with the to-be-minted org's identity. Returns the Auth0 Org id to
 * INSERT alongside the org row.
 *
 * Returns a result OR throws. There is no `null` return — the slice-3
 * scope-doc requires BOTH-OR-NEITHER, so a "skip Auth0" outcome means
 * the provisioner shouldn't have been called in the first place (boot-
 * time decision via Auth0ManagementClient.createIfConfigured()).
 */
export type OrgAuth0Provisioner = (
  inputs: OrgAuth0ProvisionInputs,
) => Promise<OrgAuth0ProvisionResult>;

/**
 * Rollback hook — called when the DB INSERT fails AFTER the Auth0 create
 * succeeded. Reverses the Auth0-side state under BOTH-OR-NEITHER.
 * Separate from the provisioner so the rollback can also be invoked
 * directly by tests + by future state-reconciliation tooling without
 * going through the full provisioner.
 */
export type OrgAuth0Rollback = (auth0OrgId: string) => Promise<void>;

/**
 * Builds the production Auth0 org-provisioner alongside its rollback hook
 * by closing over a configured Auth0ManagementClient. Captured at
 * OrgService construction time. Returns null when the client is null —
 * callers in src/index.ts null-check and skip the OrgService setter, so
 * the legacy Universal Login path stays active when M2M is unconfigured.
 */
export function createAuth0OrgProvisioner(
  client: Auth0ManagementClient | null,
): { provisioner: OrgAuth0Provisioner; rollback: OrgAuth0Rollback } | null {
  if (!client) return null;

  return {
    provisioner: async ({ orgId, orgName, orgType }) => {
      // Auth0 Org names must be alphanumeric + hyphens, lowercase. orgId
      // is a nanoid (62-char alphabet [A-Za-z0-9_-]). Lowercase it +
      // strip underscores defensively (underscore isn't in Auth0's
      // allowed set; the `conduit-` prefix keeps the result non-empty).
      //
      // Collapse-risk note (boss-flagged 2026-06-13): two distinct
      // nanoids that differ ONLY in case (e.g. `aB` vs `Ab`) would
      // collide here. Probability is astronomically low for nanoid's
      // default 21-char alphanumeric output (~10^-37 for a same-prefix
      // pair across the lifetime of WYRE), and the Auth0 UNIQUE
      // constraint on `name` is the load-bearing catch — the createOrg
      // call surfaces as `409 already exists` which propagates as a
      // 503-class error through BOTH-OR-NEITHER. Acceptable trade-off
      // for the simpler-name + ops-readability win.
      const safeId = orgId.toLowerCase().replace(/_/g, '-');
      const name = `conduit-${safeId}`;
      const response = await client.createOrganization({
        name,
        displayName: orgName,
        metadata: {
          conduit_org_id: orgId,
          conduit_org_type: orgType,
        },
      });
      return { auth0OrgId: response.id };
    },
    rollback: async (auth0OrgId) => {
      await client.deleteOrganization(auth0OrgId);
    },
  };
}
