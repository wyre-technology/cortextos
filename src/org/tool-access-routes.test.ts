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
