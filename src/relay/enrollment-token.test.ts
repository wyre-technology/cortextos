import { describe, it, expect } from 'vitest';
import { mintEnrollmentToken, verifyEnrollmentToken } from './enrollment-token.js';

describe('enrollment-token', () => {
  it('mints a token that verifies and returns the bound subtenant + capabilities', async () => {
    const token = await mintEnrollmentToken({ subtenantId: 'org-1', capabilities: ['echo'] });
    const result = await verifyEnrollmentToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.subtenantId).toBe('org-1');
      expect(result.claims.capabilities).toEqual(['echo']);
      expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('produces a stable fingerprint for the same token', async () => {
    const token = await mintEnrollmentToken({ subtenantId: 'org-1', capabilities: ['echo'] });
    const a = await verifyEnrollmentToken(token);
    const b = await verifyEnrollmentToken(token);
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true);
  });

  it('produces different fingerprints for different tokens', async () => {
    const t1 = await mintEnrollmentToken({ subtenantId: 'org-1', capabilities: ['echo'] });
    const t2 = await mintEnrollmentToken({ subtenantId: 'org-2', capabilities: ['echo'] });
    const a = await verifyEnrollmentToken(t1);
    const b = await verifyEnrollmentToken(t2);
    expect(a.ok && b.ok && a.fingerprint !== b.fingerprint).toBe(true);
  });

  it('rejects an empty / non-string token as malformed', async () => {
    const r1 = await verifyEnrollmentToken('');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('malformed');
    // @ts-expect-error — exercising the runtime guard against a non-string.
    const r2 = await verifyEnrollmentToken(undefined);
    expect(r2.ok).toBe(false);
  });

  it('rejects a garbage / non-JWT token as invalid_identity', async () => {
    const result = await verifyEnrollmentToken('not.a.jwt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_identity');
  });

  it('rejects an expired token as invalid_identity', async () => {
    // Mint with a 1-second TTL, wait it out.
    const token = await mintEnrollmentToken({ subtenantId: 'org-1', capabilities: ['echo'] }, 1);
    await new Promise((r) => setTimeout(r, 1100));
    const result = await verifyEnrollmentToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_identity');
  });

  it('binds to exactly one subtenant — a token for org-A never verifies as org-B', async () => {
    const token = await mintEnrollmentToken({ subtenantId: 'org-A', capabilities: ['echo'] });
    const result = await verifyEnrollmentToken(token);
    expect(result.ok && result.claims.subtenantId).toBe('org-A');
    // The subtenant is carried IN the signed token — it cannot be reassigned
    // by anything off the wire without invalidating the signature.
  });
});
