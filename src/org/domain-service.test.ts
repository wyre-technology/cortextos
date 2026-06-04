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
import { describe, it, expect, vi } from 'vitest';

// Stub getSql() so verify()'s UPDATE path returns a deterministic row without
// touching real DB context. runAsSystem is also stubbed to pass-through.
// Mirrors the pattern from src/oauth/vendor-state-store.test.ts (PR A
// canary, 2026-06-02) for service tests that exercise SQL-touching paths.
vi.mock('../db/context.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlStub: any = ((..._args: unknown[]) => Promise.resolve([
    {
      id: 'd1',
      org_id: 'org-1',
      domain: 'example.com',
      verification_token: 'conduit-verify=PLACEHOLDER',
      verified_at: '2026-06-04T13:00:00Z',
      verified_by: 'user-1',
      auto_join_role: 'member',
      created_at: '2026-06-04T00:00:00Z',
      created_by: 'user-1',
    },
  ]));
  return {
    getSql: () => sqlStub,
    runAsSystem: <T,>(fn: () => Promise<T>) => fn(),
  };
});

import {
  OrgDomainService,
  OrgDomainError,
  isValidDomain,
  bareNanoidFromVerificationToken,
} from './domain-service.js';
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

describe('bareNanoidFromVerificationToken — tolerance-by-construction helper', () => {
  it('extracts the bare nanoid from the canonical token format', () => {
    expect(bareNanoidFromVerificationToken('conduit-verify=4raS0pU7Pu59zl3C7ESG2Zxv'))
      .toBe('4raS0pU7Pu59zl3C7ESG2Zxv');
  });

  it('extracts the bare nanoid regardless of prefix variation (case where DNS provider strips the hyphen)', () => {
    // Even if the stored token has the hyphen stripped (defensive — shouldn't
    // happen via current add() but legacy / schema-divergence rows would
    // surface here), the helper still recovers the bare nanoid.
    expect(bareNanoidFromVerificationToken('conduitverify=4raS0pU7Pu59zl3C7ESG2Zxv'))
      .toBe('4raS0pU7Pu59zl3C7ESG2Zxv');
  });

  it('returns null when the token has no equals sign', () => {
    expect(bareNanoidFromVerificationToken('conduit-verify-no-equals')).toBeNull();
  });

  it('returns null when the part after equals is shorter than 16 chars (anti-false-positive)', () => {
    // Defensive: prevents accidental match against any short string after
    // a literal '=' in the TXT record. The current nanoid(24) format
    // produces 24-char strings; 16 is a conservative floor.
    expect(bareNanoidFromVerificationToken('conduit-verify=short')).toBeNull();
  });
});

describe('OrgDomainService.verify — tolerance-by-construction at customer-input substrate', () => {
  // Build a service with an injected TxtResolver + an in-memory store stub
  // for the existing/getById path. We only need enough surface to exercise
  // the verify() comparison logic.
  function makeService(stubbedDomain: {
    id: string;
    orgId: string;
    domain: string;
    verificationToken: string;
  }, txtRecords: string[][]) {
    const service = new OrgDomainService(async () => txtRecords);
    // Stub getById without going through the real SQL path.
    (service as unknown as { getById: () => Promise<unknown> }).getById = async () => ({
      id: stubbedDomain.id,
      orgId: stubbedDomain.orgId,
      domain: stubbedDomain.domain,
      verificationToken: stubbedDomain.verificationToken,
      verifiedAt: null,
      verifiedBy: null,
      autoJoinRole: 'member',
      createdAt: '2026-06-04T00:00:00Z',
      createdBy: 'user-1',
    });
    return service;
  }

  it('accepts a TXT record matching the bare nanoid even when the prefix differs (hyphen stripped)', async () => {
    // The Aaron-2026-06-04 prod case: stored token has hyphen,
    // customer's actual DNS record does not.
    const service = makeService(
      {
        id: 'd1',
        orgId: 'org-1',
        domain: 'wyretechnology.com',
        verificationToken: 'conduit-verify=4raS0pU7Pu59zl3C7ESG2Zxv',
      },
      [['conduitverify=4raS0pU7Pu59zl3C7ESG2Zxv']],
    );
    const logger = { warn: vi.fn() };
    // Should not throw VERIFICATION_TOKEN_MISSING — tolerance path matches.
    // (The actual SQL UPDATE returns a stub via vi.mock at top of file.)
    await expect(service.verify('d1', 'org-1', 'user-1', logger)).resolves.toBeTruthy();
    // Telemetry fired exactly once on the tolerance-fallback path.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'domain_verify_hyphen_normalize_fired' }),
      expect.stringContaining('customer-input variation accepted'),
    );
  });

  it('strict-match happy-path does NOT fire the telemetry event', async () => {
    // When the customer's TXT record matches the full token exactly (the
    // common case), the strict path matches first and the fallback never
    // runs. Telemetry stays silent so the metric is a clean signal of
    // tolerance-path-usage, not a noise-floor.
    const service = makeService(
      {
        id: 'd1',
        orgId: 'org-1',
        domain: 'example.com',
        verificationToken: 'conduit-verify=Abc123Def456Ghi789Jkl012',
      },
      [['conduit-verify=Abc123Def456Ghi789Jkl012']],
    );
    const logger = { warn: vi.fn() };
    await expect(service.verify('d1', 'org-1', 'user-1', logger)).resolves.toBeTruthy();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still rejects when neither the full token nor the bare nanoid match (negative)', async () => {
    // Defense against tolerance-overshoot: a TXT record with a completely
    // different value must still fail. The 24-char nanoid is the entropy
    // source; without a substring-match on it the verify must throw.
    const service = makeService(
      {
        id: 'd1',
        orgId: 'org-1',
        domain: 'example.com',
        verificationToken: 'conduit-verify=Abc123Def456Ghi789Jkl012',
      },
      [['some-other-totally-different-value']],
    );
    const logger = { warn: vi.fn() };
    await expect(service.verify('d1', 'org-1', 'user-1', logger)).rejects.toMatchObject({
      code: 'VERIFICATION_TOKEN_MISSING',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
