import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the tool-access role policy (WYREAI-58 / parity port of
// gateway PR #107, 2026-05-31). The PUT + DELETE handlers used to be
// `requireOrgRole(..., 'owner')` — same asymmetry gateway #107 customer hit
// (HTTP 403 on a legitimate admin user). The GET + discover handlers were
// already admin; admin should write too.
//
// Lock the literal at the source level — this PR is a 2-line change that's
// easy to revert silently. The regression-guard makes a silent revert visible.

const src = readFileSync(
  fileURLToPath(new URL('./tool-access-routes.ts', import.meta.url)),
  'utf8',
);

describe('tool-access role policy (WYREAI-58, gateway #107 parity)', () => {
  it('PUT /tool-access/:vendor/:role is gated to admin (not owner)', () => {
    // The PUT handler is the block introduced by the `app.put<...>` literal
    // followed by the `/api/orgs/:orgId/tool-access/:vendor/:role` route. The
    // requireOrgRole call inside that block must carry 'admin'.
    const putIdx = src.indexOf('app.put<');
    expect(putIdx).toBeGreaterThan(0);
    // Slice forward to the next app.delete (i.e. the PUT handler body) and
    // assert the role string in this region is 'admin', never 'owner'.
    const delIdx = src.indexOf('app.delete<', putIdx);
    const putBlock = src.slice(putIdx, delIdx);
    expect(putBlock).toContain("'admin'");
    expect(putBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });

  it('DELETE /tool-access/:vendor/:role is gated to admin (not owner)', () => {
    const delIdx = src.indexOf('app.delete<');
    expect(delIdx).toBeGreaterThan(0);
    // Slice forward to the next app.get (the discover handler) and assert
    // 'admin' inside the DELETE block.
    const nextGet = src.indexOf('app.get<', delIdx);
    const delBlock = src.slice(delIdx, nextGet);
    expect(delBlock).toContain("'admin'");
    expect(delBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });

  it('no requireOrgRole call in this file gates on owner (writes + reads all admin-tier)', () => {
    // Belt for the per-handler asserts: this file is admin-only — `owner`
    // belongs in billing / subscription / ownership-transfer / org-deletion
    // routes, not here.
    expect(src).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });
});

describe('team-scoped tool-access routes (WYREAI-62, gateway #200 + #126 parity)', () => {
  // Per warden #295 review skim-lens: admin-tier read parity with admin-tier
  // write — audit reads should not differ in authz from writes on the same
  // resource. All three new routes (GET / PUT / DELETE) are admin-gated.
  const src2 = readFileSync(
    fileURLToPath(new URL('./tool-access-routes.ts', import.meta.url)),
    'utf8',
  );

  it('GET /api/orgs/:orgId/teams/:teamId/tool-access/:vendor is admin-gated', () => {
    expect(src2).toMatch(/'\/api\/orgs\/:orgId\/teams\/:teamId\/tool-access\/:vendor'/);
    // The GET handler's body comes between the route literal and the next
    // `app.put<` — extract that slice and assert 'admin' literal.
    const getStart = src2.indexOf("'/api/orgs/:orgId/teams/:teamId/tool-access/:vendor'");
    const putStart = src2.indexOf('app.put<', getStart);
    const getBlock = src2.slice(getStart, putStart);
    expect(getBlock).toMatch(/requireOrgRole\([^)]*'admin'\)/);
    expect(getBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });

  it('PUT /api/orgs/:orgId/teams/:teamId/tool-access/:vendor is admin-gated', () => {
    const putStart = src2.indexOf('app.put<', src2.indexOf('teams/:teamId/tool-access'));
    const delStart = src2.indexOf('app.delete<', putStart);
    const putBlock = src2.slice(putStart, delStart);
    expect(putBlock).toMatch(/requireOrgRole\([^)]*'admin'\)/);
    expect(putBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });

  it('DELETE /api/orgs/:orgId/teams/:teamId/tool-access/:vendor is admin-gated', () => {
    const delStart = src2.indexOf('app.delete<', src2.indexOf('teams/:teamId/tool-access'));
    const delBlock = src2.slice(delStart);
    expect(delBlock).toMatch(/requireOrgRole\([^)]*'admin'\)/);
    expect(delBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });

  it('GET response shape includes tools + grantedBy + grantedAt (WYREAI-62 audit extension)', () => {
    // The GET handler delegates to getTeamToolAllowlistWithAudit which returns
    // {tools, grantedBy, grantedAt} — pin the call.
    expect(src2).toMatch(/getTeamToolAllowlistWithAudit\(orgId, teamId, vendorSlug\)/);
  });

  it('PUT delegates to setTeamToolAllowlist + DELETE delegates to clearTeamToolAllowlist', () => {
    expect(src2).toMatch(/setTeamToolAllowlist\(orgId, teamId, vendorSlug, tools, user\.sub\)/);
    expect(src2).toMatch(/clearTeamToolAllowlist\(orgId, teamId, vendorSlug\)/);
  });

  it('no requireOrgRole call in the team-routes block gates on owner (all admin-tier)', () => {
    const teamBlock = src2.slice(src2.indexOf('Team-scoped tool-access routes'));
    expect(teamBlock).not.toMatch(/requireOrgRole\([^)]*'owner'\)/);
  });
});
