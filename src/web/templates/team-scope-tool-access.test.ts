import { describe, it, expect } from 'vitest';
import {
  renderTeamScopeToolAccess,
  type TeamScopeToolAccessData,
} from './team-scope-tool-access.js';
import type { Organization, OrgTeam } from '../../org/org-service.js';

// WYREAI-63 UI: tests pin the load-bearing presentational invariants of the
// team-scoped tool-access page. Source-grep-style regression guards on the
// HTML output — a silent template change that loses the audit metadata, the
// inherit-org-defaults empty-state copy, or the IDOR-relevant data leakage
// surface goes red.

const org: Organization = {
  id: 'org_x',
  name: 'WYRE Technology',
  ownerId: 'auth0|1',
  plan: 'conduit',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'reseller',
  parentOrgId: null,
  auth0OrgId: null,
  suspendedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-31T00:00:00Z',
};

const team: OrgTeam = {
  id: 'team_engineering',
  orgId: 'org_x',
  name: 'Engineering',
  createdBy: 'auth0|1',
  createdAt: '2026-05-01T00:00:00Z',
};

function data(overrides: Partial<TeamScopeToolAccessData> = {}): TeamScopeToolAccessData {
  return {
    org,
    team,
    vendorSlug: 'datto-rmm',
    vendorName: 'Datto RMM',
    allowlist: { tools: ['list_devices', 'list_alerts'], grantedBy: 'C. Ramirez', grantedAt: '2026-05-30T12:00:00Z' },
    ...overrides,
  };
}

describe('renderTeamScopeToolAccess (WYREAI-63, gateway #200 frontend parity)', () => {
  describe('the audit-extended populated state', () => {
    it('renders the team name + vendor name in the title', () => {
      const html = renderTeamScopeToolAccess(data());
      expect(html).toContain('Engineering');
      expect(html).toContain('Datto RMM');
      expect(html).toMatch(/<h1[^>]*>Engineering — Datto RMM tool access<\/h1>/);
    });

    it('renders the grantedBy + grantedAt audit metadata (WYREAI-62 extension)', () => {
      const html = renderTeamScopeToolAccess(data());
      expect(html).toContain('Granted by');
      expect(html).toContain('C. Ramirez');
      expect(html).toContain('Granted');
      // The relative-time formatter result will vary (h/d ago), so pin the
      // ISO timestamp into the title attribute for hover-precise display.
      expect(html).toContain('2026-05-30T12:00:00Z');
    });

    it('renders every tool in the allowlist', () => {
      const html = renderTeamScopeToolAccess(data());
      expect(html).toContain('list_devices');
      expect(html).toContain('list_alerts');
      expect(html).toMatch(/Permitted tools for Engineering via Datto RMM \(2\)/);
    });

    it('renders an explicit deny-all message for an empty (but present) allowlist', () => {
      // tools=[] with allowlist row present is a legitimate "explicit deny-all"
      // state (gateway #200 + WYREAI-60 narrow-only semantics). Must distinguish
      // from null (= inherit org defaults).
      const html = renderTeamScopeToolAccess(
        data({ allowlist: { tools: [], grantedBy: 'C. Ramirez', grantedAt: '2026-05-30T12:00:00Z' } }),
      );
      expect(html).toContain('explicit deny-all');
      expect(html).toContain('no tools permitted');
    });
  });

  describe('the inherit-org-defaults empty state (null allowlist)', () => {
    it('renders the load-bearing "inherit org defaults" copy beat', () => {
      // Gateway #200 Aaron-ruled product Q: null = inherit, no lock-out warning.
      // Empty-state must distinguish from explicit deny-all so a reviewer
      // doesn't read "no team-scoped row" as "this team has zero tools".
      const html = renderTeamScopeToolAccess(data({ allowlist: null }));
      expect(html).toContain('No team-scoped allowlist set');
      expect(html).toContain('inherits the org-level allowlist');
      expect(html).not.toContain('explicit deny-all');
      expect(html).not.toContain('no tools permitted');
    });

    it('does not render an audit-metadata block when allowlist is null', () => {
      const html = renderTeamScopeToolAccess(data({ allowlist: null }));
      expect(html).not.toContain('Granted by');
      expect(html).not.toContain('Granted ');
    });
  });

  describe('XSS hardening — escape user-controlled names', () => {
    it('escapes the team name', () => {
      const html = renderTeamScopeToolAccess(
        data({ team: { ...team, name: '<script>x</script>' } }),
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes the vendor name + slug', () => {
      const html = renderTeamScopeToolAccess(
        data({ vendorName: '<x>', vendorSlug: 'evil"slug' }),
      );
      expect(html).not.toContain('<x>');
      expect(html).toContain('&lt;x&gt;');
      expect(html).not.toContain('evil"slug');
    });

    it('escapes the org name (in the breadcrumb)', () => {
      const html = renderTeamScopeToolAccess(
        data({ org: { ...org, name: '<i>org</i>' } }),
      );
      expect(html).not.toContain('<i>org</i>');
      expect(html).toContain('&lt;i&gt;org&lt;/i&gt;');
    });

    it('escapes every tool name (admin-managed but defensive)', () => {
      const html = renderTeamScopeToolAccess(
        data({
          allowlist: {
            tools: ['list_<img>', '"><script>x</script>'],
            grantedBy: 'C. Ramirez',
            grantedAt: '2026-05-30T12:00:00Z',
          },
        }),
      );
      expect(html).not.toContain('<img>');
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;img&gt;');
    });
  });

  describe('audit-row labels gracefully degrade', () => {
    it('renders "unknown" when grantedBy label is null (deleted user / legacy row)', () => {
      const html = renderTeamScopeToolAccess(
        data({ allowlist: { tools: ['x'], grantedBy: null, grantedAt: '2026-05-30T12:00:00Z' } }),
      );
      expect(html).toContain('unknown');
    });

    it('renders "never" when grantedAt is null (legacy row before WYREAI-62)', () => {
      const html = renderTeamScopeToolAccess(
        data({ allowlist: { tools: ['x'], grantedBy: 'C. Ramirez', grantedAt: null } }),
      );
      expect(html).toContain('never');
    });
  });
});
