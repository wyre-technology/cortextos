/**
 * OrgDomainService unit tests — the pure, pre-DB layer:
 *  - the public-email-domain blocklist (the account-takeover guard),
 *  - domain syntax validation,
 *  - the two add() rejections that fire BEFORE any DB query.
 *
 * The DB-touching paths (RLS scoping, claim cross-org read, verify) are
 * covered by the container-backed RLS integration test —
 * src/db/__tests__/rls-organization-domains.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { OrgDomainService, OrgDomainError, isValidDomain } from './domain-service.js';
import { isPublicEmailDomain, domainFromEmail, normalizeDomain } from './public-email-domains.js';

describe('public-email-domains', () => {
  it('flags known public providers', () => {
    for (const d of ['gmail.com', 'GMAIL.com', '  yahoo.com ', 'outlook.com', 'proton.me']) {
      expect(isPublicEmailDomain(d)).toBe(true);
    }
  });

  it('lets corporate domains through', () => {
    for (const d of ['wyretechnology.com', 'anthropic.com', 'acme.io']) {
      expect(isPublicEmailDomain(d)).toBe(false);
    }
  });

  it('domainFromEmail extracts the lowercased domain', () => {
    expect(domainFromEmail('Beau@WyreTechnology.com')).toBe('wyretechnology.com');
    expect(domainFromEmail('no-at-sign')).toBeNull();
    expect(domainFromEmail('trailing@')).toBeNull();
    expect(domainFromEmail('@leading.com')).toBeNull();
  });

  it('normalizeDomain strips @ and lowercases', () => {
    expect(normalizeDomain('@Wyre.COM')).toBe('wyre.com');
  });
});

describe('isValidDomain', () => {
  it('accepts typical domains', () => {
    expect(isValidDomain('wyretechnology.com')).toBe(true);
    expect(isValidDomain('sub.example.co.uk')).toBe(true);
  });

  it('rejects malformed input', () => {
    for (const bad of [
      '',
      'no-tld',
      '.leading-dot.com',
      'trailing-dot.',
      'bad_underscore.com',
      '-leadhyphen.com',
    ]) {
      expect(isValidDomain(bad)).toBe(false);
    }
  });
});

describe('OrgDomainService.add — pre-DB rejections', () => {
  // These throw before any getSql() call, so no DB context is needed.
  const service = new OrgDomainService();

  it('rejects a syntactically invalid domain with INVALID_DOMAIN', async () => {
    await expect(service.add('org-1', 'not a domain', 'user-1')).rejects.toMatchObject({
      code: 'INVALID_DOMAIN',
    });
  });

  it('rejects a public email provider with PUBLIC_DOMAIN_NOT_ALLOWED', async () => {
    // The account-takeover guard: nobody can claim gmail.com.
    await expect(service.add('org-1', 'gmail.com', 'user-1')).rejects.toMatchObject({
      code: 'PUBLIC_DOMAIN_NOT_ALLOWED',
    });
    await expect(service.add('org-1', 'gmail.com', 'user-1')).rejects.toBeInstanceOf(
      OrgDomainError,
    );
  });
});
