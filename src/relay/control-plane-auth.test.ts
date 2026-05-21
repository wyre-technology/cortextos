import { describe, it, expect } from 'vitest';
import {
  signRequest,
  verifyRequest,
  buildCanonicalString,
  hashBody,
  NonceStore,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  TIMESTAMP_WINDOW_SECONDS,
} from './control-plane-auth.js';

const SECRET = 'unit-test-secret-bytes';

function freshStore(): NonceStore {
  return new NonceStore();
}

describe('control-plane-auth canonicalization (warden scope-stage pins)', () => {
  it('hashBody on empty body returns sha256("") — never special-cases empty', () => {
    expect(hashBody('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashBody(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashBody returns lowercase hex sha256, 64 chars', () => {
    const h = hashBody('hello');
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('buildCanonicalString uses single \\n delimiter, method upper-cased', () => {
    const c = buildCanonicalString({
      method: 'post',
      path: '/internal/relay/route',
      timestamp: '1700000000',
      nonce: 'n1',
      bodyHashHex: 'abc',
    });
    expect(c).toBe('POST\n/internal/relay/route\n1700000000\nn1\nabc');
  });

  it('buildCanonicalString lowercases body hash to keep verification side-stable', () => {
    const c = buildCanonicalString({
      method: 'POST',
      path: '/x',
      timestamp: '1',
      nonce: 'n',
      bodyHashHex: 'ABCDEF',
    });
    expect(c.endsWith('abcdef')).toBe(true);
  });
});

describe('control-plane-auth signRequest / verifyRequest', () => {
  it('a freshly-signed request verifies', () => {
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/route',
      body: JSON.stringify({ tunnelId: 't1', target: 'echo', payload: {} }),
      nonce: 'unique-nonce-1',
    });
    const result = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/route',
      body: JSON.stringify({ tunnelId: 't1', target: 'echo', payload: {} }),
      headers,
      nonceStore: freshStore(),
    });
    expect(result.ok).toBe(true);
  });

  it('any of the three headers missing → malformed', () => {
    for (const drop of [HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE]) {
      const headers = signRequest({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: '',
        nonce: 'n',
      }) as unknown as Record<string, string>;
      delete headers[drop];
      const r = verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: '',
        headers,
        nonceStore: freshStore(),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('malformed');
    }
  });

  it('a non-numeric timestamp → malformed', () => {
    const headers = signRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', nonce: 'n' });
    headers[HEADER_TIMESTAMP] = 'not-a-number';
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok && true).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('a stale timestamp outside the ±5 min window → timestamp_skew', () => {
    const now = 1_700_000_000;
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      nonce: 'n',
      timestamp: now - TIMESTAMP_WINDOW_SECONDS - 1,
    });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_skew');
  });

  it('a future timestamp outside the window also → timestamp_skew', () => {
    const now = 1_700_000_000;
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      nonce: 'n',
      timestamp: now + TIMESTAMP_WINDOW_SECONDS + 1,
    });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_skew');
  });

  it('a tampered body → bad_signature (boss body-binding pin)', () => {
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/route',
      body: JSON.stringify({ tunnelId: 't1', target: 'echo', payload: { x: 1 } }),
      nonce: 'n-body',
    });
    // Swap the body, keep the signature — must NOT validate.
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/route',
      body: JSON.stringify({ tunnelId: 't1', target: 'echo', payload: { x: 999 } }),
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('a tampered method → bad_signature', () => {
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      nonce: 'n',
    });
    const r = verifyRequest({
      secret: SECRET,
      method: 'GET',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('a tampered path → bad_signature', () => {
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/route',
      body: '',
      nonce: 'n',
    });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/internal/relay/different-route',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('the wrong secret → bad_signature', () => {
    const headers = signRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', nonce: 'n' });
    const r = verifyRequest({
      secret: 'wrong-secret',
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('replaying the same nonce within the window → replay', () => {
    const store = freshStore();
    const headers = signRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', nonce: 'replay-n' });
    const a = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: store,
    });
    expect(a.ok).toBe(true);
    const b = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: store,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('replay');
  });

  it('a fresh nonce after the window passes (nonce store evicts)', () => {
    const store = freshStore();
    const now = 1_700_000_000;
    const earlyHeaders = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      nonce: 'n-old',
      timestamp: now,
    });
    expect(
      verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: '',
        headers: earlyHeaders,
        nonceStore: store,
        nowSeconds: now,
      }).ok,
    ).toBe(true);
    // Same nonce, fresh timestamp well past the window → nonce store should
    // have evicted the old entry; this is fresh and passes.
    const laterHeaders = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      nonce: 'n-old',
      timestamp: now + TIMESTAMP_WINDOW_SECONDS * 2,
    });
    expect(
      verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: '',
        headers: laterHeaders,
        nonceStore: store,
        nowSeconds: now + TIMESTAMP_WINDOW_SECONDS * 2,
      }).ok,
    ).toBe(true);
  });

  it('signature compare is length-checked first (no throw on unequal-length sigs)', () => {
    // timingSafeEqual throws on unequal-length buffers; verifyRequest must
    // short-circuit length-mismatch to bad_signature, never let it bubble.
    const headers = signRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', nonce: 'n' });
    headers[HEADER_SIGNATURE] = 'short';
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('an empty body signs + verifies correctly (no special-case)', () => {
    const headers = signRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', nonce: 'n-empty' });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body: '',
      headers,
      nonceStore: freshStore(),
    });
    expect(r.ok).toBe(true);
  });
});

describe('NonceStore eviction', () => {
  it('does not grow without bound — at-capacity insertion drops oldest', () => {
    const store = new NonceStore(/* capacity */ 5);
    for (let i = 0; i < 10; i += 1) store.recordOrFlag(`n${i}`, 1700000000 + i, 300);
    expect(store.size()).toBeLessThanOrEqual(5);
  });
});
