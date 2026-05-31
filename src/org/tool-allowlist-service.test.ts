import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolAllowlistService } from './tool-allowlist-service.js';
import { OrgService } from './org-service.js';

// Regression guard for the team-scoped allowlist schema + service (WYREAI-59,
// parity port of gateway PR #189). Integration tests live in the resolver +
// enforcement PRs (WYREAI-60 / WYREAI-61) where they exercise the team paths
// naturally; this file locks the schema-DDL and service-method contracts at
// the source level so a silent revert goes red.

const orgServiceSrc = readFileSync(
  fileURLToPath(new URL('./org-service.ts', import.meta.url)),
  'utf8',
);
const allowlistSrc = readFileSync(
  fileURLToPath(new URL('./tool-allowlist-service.ts', import.meta.url)),
  'utf8',
);

describe('team-scoped allowlist schema (WYREAI-59, gateway #189 spine)', () => {
  it('adds nullable team_id column with FK to org_teams ON DELETE CASCADE', () => {
    expect(orgServiceSrc).toMatch(
      /ALTER TABLE org_tool_allowlist[\s\S]*ADD COLUMN IF NOT EXISTS team_id TEXT[\s\S]*REFERENCES org_teams\(id\) ON DELETE CASCADE/,
    );
  });

  it('makes role nullable', () => {
    expect(orgServiceSrc).toMatch(
      /ALTER TABLE org_tool_allowlist ALTER COLUMN role DROP NOT NULL/,
    );
  });

  it('drops the legacy 4-column UNIQUE so the two partial UNIQUEs can take over', () => {
    expect(orgServiceSrc).toMatch(
      /DROP CONSTRAINT IF EXISTS org_tool_allowlist_org_id_vendor_slug_role_tool_name_key/,
    );
  });

  it('enforces the team-XOR-role CHECK invariant: (team_id IS NULL) <> (role IS NULL)', () => {
    expect(orgServiceSrc).toMatch(
      /CONSTRAINT org_tool_allowlist_team_xor_role\s*CHECK \(\(team_id IS NULL\) <> \(role IS NULL\)\)/,
    );
  });

  it('creates partial UNIQUE for role-scoped rows (WHERE team_id IS NULL)', () => {
    expect(orgServiceSrc).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_tool_allowlist_role[\s\S]*ON org_tool_allowlist\(org_id, vendor_slug, role, tool_name\)[\s\S]*WHERE team_id IS NULL/,
    );
  });

  it('creates partial UNIQUE for team-scoped rows (WHERE role IS NULL)', () => {
    expect(orgServiceSrc).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_tool_allowlist_team[\s\S]*ON org_tool_allowlist\(org_id, vendor_slug, team_id, tool_name\)[\s\S]*WHERE role IS NULL/,
    );
  });

  it('creates team-lookup index (partial WHERE team_id IS NOT NULL)', () => {
    expect(orgServiceSrc).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_org_tool_allowlist_team_lookup[\s\S]*ON org_tool_allowlist\(org_id, vendor_slug, team_id\)[\s\S]*WHERE team_id IS NOT NULL/,
    );
  });

  it('preserves the legacy role-lookup index (role-scoped query path unchanged)', () => {
    // The existing idx_org_tool_allowlist_lookup index stays — role-scoped
    // reads continue to use it; the new partial uniques + team-lookup add to,
    // they don't replace, the role-side index.
    expect(orgServiceSrc).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_org_tool_allowlist_lookup[\s\S]*ON org_tool_allowlist\(org_id, vendor_slug, role\)/,
    );
  });
});

describe('ToolAllowlistService team-scoped methods (WYREAI-59)', () => {
  const svc = new ToolAllowlistService();

  it('exposes the team-scoped trio (get/set/clear) on the class', () => {
    expect(typeof svc.getTeamToolAllowlist).toBe('function');
    expect(typeof svc.setTeamToolAllowlist).toBe('function');
    expect(typeof svc.clearTeamToolAllowlist).toBe('function');
  });

  it('setTeamToolAllowlist INSERTs with role explicitly NULL (the team-shape)', () => {
    // The INSERT must carry role=NULL so the CHECK invariant + the team
    // partial UNIQUE keep the row in the team shape. Source-grep — a silent
    // revert to role='member' default would silently violate the invariant.
    expect(allowlistSrc).toMatch(
      /INSERT INTO org_tool_allowlist \(id, org_id, vendor_slug, team_id, role, tool_name, granted_by\)[\s\S]*VALUES \(\$\{id\}, \$\{orgId\}, \$\{vendorSlug\}, \$\{teamId\}, \$\{null\}, \$\{toolName\}, \$\{grantedBy\}\)/,
    );
  });

  it('all three team methods scope by team_id (not role) in WHERE clauses', () => {
    // Find each method's body and confirm it uses team_id, not role.
    const getMatch = /async getTeamToolAllowlist[\s\S]+?ORDER BY/.exec(allowlistSrc);
    const setDelMatch = /async setTeamToolAllowlist[\s\S]+?for \(const/.exec(allowlistSrc);
    const clearMatch = /async clearTeamToolAllowlist[\s\S]+?\n {2}\}/.exec(allowlistSrc);
    for (const m of [getMatch, setDelMatch, clearMatch]) {
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/AND team_id = \$\{teamId\}/);
      expect(m![0]).not.toMatch(/AND role = \$\{role\}/);
    }
  });
});

describe('OrgService team-allowlist delegation (WYREAI-59)', () => {
  it('exposes the team-scoped trio on OrgService (delegation to ToolAllowlistService)', () => {
    // Static class-shape check — the delegations exist on the prototype.
    expect(typeof OrgService.prototype.getTeamToolAllowlist).toBe('function');
    expect(typeof OrgService.prototype.setTeamToolAllowlist).toBe('function');
    expect(typeof OrgService.prototype.clearTeamToolAllowlist).toBe('function');
  });
});
