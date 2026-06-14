import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-grep regression-guards for WYREAI-118 + WYREAI-119 admin
 * create-org-with-stub-owner + invitation-driven owner-swap discipline.
 *
 * The flow has several security-critical invariants that must hold under
 * refactor. Source-grep tests enforce the discipline at the test sub-layer
 * (sibling to drip-escape-discipline.test.ts from PR #302 + auth0-funnel-
 * a-discipline.test.ts from PR #326). The pattern is now operationally
 * reflexive: every PR with a load-bearing security invariant gets a
 * source-grep regression guard.
 *
 * Invariants enforced:
 *
 *  1. POST /admin/orgs route exists in admin/org-routes.ts and is gated
 *     on requireAdminMutation (admin role + CSRF).
 *  2. Admin's auth0User.sub is used as the stub-owner — invitation-flow
 *     is the ownership-grant path, NOT direct binding to unverified email.
 *  3. Invitation type 'owner_swap_to_invited' is passed to createInvitation
 *     with swapFromUserId=adminSub.
 *  4. acceptInvitation branches on invite_type — the new branch uses the
 *     NARROWED-DELETE filter (WHERE user_id = ${swapFromUserId}) NOT the
 *     blanket DELETE-all-others from the legacy customer-create path.
 *  5. The owner-swap-to-invited branch does NOT include the customer-only
 *     STRUCTURAL ASSERTION (which is correct for the customer-create
 *     transition but blocks admin-create-org for reseller/standalone types).
 *  6. Org-type allowlist at the admin route restricts to 'reseller' +
 *     'standalone' (customer orgs are reseller-driven, not admin-create).
 *  7. The CHECK constraint at mig 041 is paired with a service-side
 *     consistency-pair validator (paired-canary: DB-side discriminator-
 *     consistency + service-side throw on misuse).
 *  8. Audit event 'org_created_by_admin' fires on successful create.
 */

const ADMIN_ROUTES_TS = join(__dirname, "..", "org-routes.ts");
const INVITATION_SERVICE_TS = join(
  __dirname,
  "..",
  "..",
  "org",
  "invitation-service.ts",
);
const AUDIT_SERVICE_TS = join(
  __dirname,
  "..",
  "..",
  "audit",
  "admin-audit-service.ts",
);
const MIG_041 = join(
  __dirname,
  "..",
  "..",
  "..",
  "migrations",
  "041_invitation_owner_swap.sql",
);

describe("WYREAI-118 + 119 admin create-org + owner-swap discipline (source-grep regression guards)", () => {
  const adminSrc = readFileSync(ADMIN_ROUTES_TS, "utf8");
  const invSrc = readFileSync(INVITATION_SERVICE_TS, "utf8");
  const auditSrc = readFileSync(AUDIT_SERVICE_TS, "utf8");
  const migSrc = readFileSync(MIG_041, "utf8");

  describe("Migration 041 schema invariants", () => {
    it("adds invite_type column with default member_join", () => {
      expect(migSrc).toMatch(
        /ADD COLUMN IF NOT EXISTS invite_type[\s\S]*?DEFAULT 'member_join'/,
      );
    });

    it("adds swap_from_user_id with FK to users + ON DELETE SET NULL", () => {
      expect(migSrc).toMatch(
        /ADD COLUMN IF NOT EXISTS swap_from_user_id[\s\S]*?REFERENCES users\(id\)[\s\S]*?ON DELETE SET NULL/,
      );
    });

    it("enforces invite_type CHECK constraint (allowlist)", () => {
      expect(migSrc).toMatch(
        /CHECK[\s\S]*?invite_type IN \(\s*'member_join',\s*'owner_swap_to_invited'\s*\)/,
      );
    });

    it("enforces swap-consistency CHECK: owner_swap_to_invited iff swap_from_user_id IS NOT NULL", () => {
      expect(migSrc).toMatch(
        /invite_type = 'owner_swap_to_invited'\s+AND swap_from_user_id IS NOT NULL/,
      );
      expect(migSrc).toMatch(
        /invite_type <> 'owner_swap_to_invited'\s+AND swap_from_user_id IS NULL/,
      );
    });
  });

  describe("POST /admin/orgs route discipline", () => {
    it("route registered with requireAdminMutation gate", () => {
      // Route registration must immediately gate on requireAdminMutation.
      // Match: app.post<{...Body:{...}}>('/admin/orgs', async (request, reply) => { if (!requireAdminMutation(...)) return;
      expect(adminSrc).toMatch(
        /app\.post<[\s\S]*?>\(\s*'\/admin\/orgs'\s*,[\s\S]*?if\s*\(\s*!requireAdminMutation\(/,
      );
    });

    it("admin sub from request.auth0User used as stub-owner (NOT invited email)", () => {
      expect(adminSrc).toMatch(/const adminSub = request\.auth0User\?\.sub/);
      // The createOrg call MUST use adminSub as ownerId (the stub).
      expect(adminSrc).toMatch(
        /orgService\.createOrg\(\s*\n?\s*name,\s*\n?\s*adminSub,/,
      );
    });

    it("createInvitation passes inviteType=owner_swap_to_invited + swapFromUserId=adminSub", () => {
      expect(adminSrc).toMatch(/inviteType:\s*'owner_swap_to_invited'/);
      expect(adminSrc).toMatch(/swapFromUserId:\s*adminSub/);
    });

    it("org_type allowlist restricts to reseller + standalone", () => {
      // Customer orgs are reseller-driven via the separate
      // /admin/reseller/:resellerId/customers route. Admin-create must
      // not accept 'customer' at this boundary.
      expect(adminSrc).toMatch(/org_type must be 'reseller' or 'standalone'/);
    });

    it("audit event org_created_by_admin fires on success", () => {
      // Quote-style-agnostic: linter formatter may normalize source files
      // to either single or double quotes; the regression-guard should
      // catch the literal regardless of which quote-style is active.
      expect(adminSrc).toMatch(/eventType:\s*['"]org_created_by_admin['"]/);
      expect(auditSrc).toMatch(/\|\s*['"]org_created_by_admin['"]/);
    });
  });

  describe("InvitationService owner-swap branch discipline", () => {
    it("createInvitation accepts inviteType + swapFromUserId options", () => {
      expect(invSrc).toMatch(/inviteType\?:\s*InvitationType/);
      expect(invSrc).toMatch(/swapFromUserId\?:\s*string/);
    });

    it("createInvitation throws on owner_swap_to_invited without swapFromUserId (paired-canary)", () => {
      expect(invSrc).toMatch(
        /inviteType === 'owner_swap_to_invited' && !swapFromUserId/,
      );
      expect(invSrc).toMatch(/throw new Error\(/);
    });

    it("createInvitation INSERT carries invite_type + swap_from_user_id", () => {
      expect(invSrc).toMatch(
        /INSERT INTO org_invitations[\s\S]*?invite_type,\s*swap_from_user_id/,
      );
    });

    it("acceptInvitation branches on invitation.inviteType", () => {
      expect(invSrc).toMatch(
        /if\s*\(\s*invitation\.inviteType === 'owner_swap_to_invited'\s*\)/,
      );
    });

    it("owner-swap branch uses NARROWED DELETE (filter on swap_from_user_id), NOT blanket-DELETE", () => {
      // The owner-swap branch's DELETE must filter on the SPECIFIC
      // swap_from_user_id, not blanket WHERE user_id != ${userId}.
      // Match: DELETE FROM org_members WHERE org_id = ... AND role = 'owner'
      //          AND user_id = ${fromUserId} AND user_id != ${userId}
      expect(invSrc).toMatch(
        /DELETE FROM org_members[\s\S]*?WHERE org_id = \$\{invitation\.orgId\}[\s\S]*?AND role = 'owner'[\s\S]*?AND user_id = \$\{fromUserId\}[\s\S]*?AND user_id != \$\{userId\}/,
      );
    });

    it("owner-swap branch does NOT include the customer-only structural assertion", () => {
      // Carve out the new owner_swap_to_invited branch and verify the
      // customer-only assertion (`type !== 'customer'`) is absent. The
      // assertion belongs only to the legacy member_join owner-invite
      // branch (customer-create reseller-channel transition).
      const swapBranchStart = invSrc.indexOf(
        "if (invitation.inviteType === 'owner_swap_to_invited')",
      );
      // End of swap branch = the next 'LEGACY' marker comment
      const legacyMarker = invSrc.indexOf("LEGACY", swapBranchStart);
      expect(swapBranchStart).toBeGreaterThan(0);
      expect(legacyMarker).toBeGreaterThan(swapBranchStart);
      const swapBranch = invSrc.slice(swapBranchStart, legacyMarker);
      expect(swapBranch).not.toMatch(
        /orgRow\[0\] && orgRow\[0\]\.type !== 'customer'/,
      );
      expect(swapBranch).not.toMatch(/owner_invite_scope_violation/);
    });

    it("toInvitation maps invite_type + swap_from_user_id to the OrgInvitation type", () => {
      expect(invSrc).toMatch(
        /inviteType:\s*row\.invite_type as InvitationType/,
      );
      expect(invSrc).toMatch(/swapFromUserId:\s*row\.swap_from_user_id/);
    });
  });
});
