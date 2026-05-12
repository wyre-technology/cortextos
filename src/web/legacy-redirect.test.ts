import { describe, it, expect } from 'vitest';
import { legacyOrgRedirectTarget } from './legacy-redirect.js';

describe('legacyOrgRedirectTarget', () => {
  describe('/settings/team prefix → /org', () => {
    it('redirects the exact /settings/team root', () => {
      expect(legacyOrgRedirectTarget('/settings/team')).toBe('/org');
    });

    it('redirects each of the 11 hoisted sub-paths', () => {
      const subs = [
        'members',
        'invitations',
        'teams',
        'service-clients',
        'audit',
        'connections',
        'dashboard',
        'log-shipping',
        'scim',
        'server-access',
        'tool-access',
      ];
      for (const sub of subs) {
        expect(legacyOrgRedirectTarget(`/settings/team/${sub}`)).toBe(`/org/${sub}`);
      }
    });

    it('preserves nested params (team-id, client-id)', () => {
      expect(legacyOrgRedirectTarget('/settings/team/teams/abc123/connections')).toBe(
        '/org/teams/abc123/connections',
      );
      expect(legacyOrgRedirectTarget('/settings/team/service-clients/xyz/connections')).toBe(
        '/org/service-clients/xyz/connections',
      );
    });

    it('preserves query strings', () => {
      expect(legacyOrgRedirectTarget('/settings/team/members?invited=1')).toBe(
        '/org/members?invited=1',
      );
      expect(legacyOrgRedirectTarget('/settings/team?source=email')).toBe('/org?source=email');
    });
  });

  describe('/settings/billing → /org/billing', () => {
    it('redirects the exact path', () => {
      expect(legacyOrgRedirectTarget('/settings/billing')).toBe('/org/billing');
    });

    it('preserves query strings', () => {
      expect(legacyOrgRedirectTarget('/settings/billing?status=success')).toBe(
        '/org/billing?status=success',
      );
    });
  });

  describe('non-legacy URLs pass through (no redirect)', () => {
    const nonLegacy = [
      '/',
      '/connect/datto-rmm',
      '/settings',
      '/settings/profile',
      '/org/members',
      '/org/teams/abc/connections',
      '/api/orgs',
      '/healthz',
      // Path that contains /settings/team as a non-prefix substring → no redirect
      '/api/something/settings/team',
    ];
    for (const url of nonLegacy) {
      it(`returns null for ${url}`, () => {
        expect(legacyOrgRedirectTarget(url)).toBeNull();
      });
    }
  });

  describe('boundary cases that must NOT redirect', () => {
    it('does not match /settings/team-stuff (no segment boundary)', () => {
      // Hypothetical future route that happens to start with the same letters
      expect(legacyOrgRedirectTarget('/settings/team-stuff')).toBeNull();
    });

    it('does not match /settings/billing-history (no segment boundary)', () => {
      expect(legacyOrgRedirectTarget('/settings/billing-history')).toBeNull();
    });
  });

  describe('open-redirect resistance (security-bearing property)', () => {
    // The transform always prepends "/org" or "/org/billing" to the post-prefix
    // suffix, so output always starts with single-leading-slash → same-origin.
    // A protocol-relative redirect (Location: //evil.com) would require the
    // output to start with "//", which the transform never produces because
    // the leading "/" of the original URL is preserved in the prefix swap.

    it('extra-slash payload stays same-origin (single-leading-slash preserved)', () => {
      expect(legacyOrgRedirectTarget('/settings/team//evil.com')).toBe('/org//evil.com');
      // '/org//evil.com' is a same-origin path (single leading slash); browsers
      // do NOT interpret '//evil.com' mid-path as protocol-relative.
    });

    it('does not strip the leading slash, ever', () => {
      const cases = [
        '/settings/team/members',
        '/settings/team//foo',
        '/settings/team/teams/abc/connections',
        '/settings/billing?refer=external',
      ];
      for (const url of cases) {
        const out = legacyOrgRedirectTarget(url);
        expect(out).not.toBeNull();
        expect(out!.startsWith('/')).toBe(true);
        expect(out!.startsWith('//')).toBe(false);
      }
    });

    it('URL-encoded slash bypass attempts return null (raw-string prefix check)', () => {
      // %2F is not decoded by the transform; the prefix check is literal
      expect(legacyOrgRedirectTarget('/settings/team%2Fevil')).toBeNull();
      expect(legacyOrgRedirectTarget('/settings%2Fteam/evil')).toBeNull();
    });
  });
});
