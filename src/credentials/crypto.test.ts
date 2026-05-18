/**
 * Tests for the AES-256-GCM credential encryption helpers.
 *
 * Security regression coverage for the `authTagLength: 16` pin on the
 * decipher. GCM auth tags are defined as truncations of the full 16-byte
 * tag, so a shortened tag of a valid payload still verifies unless the
 * decipher is pinned to a 16-byte tag length — without the pin a tampered
 * payload could downgrade the integrity guarantee from 128-bit to as low
 * as 32-bit. Two guards below: a behavioral one (valid on Node <=25, incl.
 * CI's Node 22) and a structural one (runtime-independent).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encrypt, decrypt, type EncryptedPayload } from './crypto.js';

describe('credentials/crypto', () => {
  const masterKey = randomBytes(32);
  const scopeId = 'tenant-42/datto-rmm';

  it('round-trips plaintext through encrypt/decrypt', () => {
    const secret = 'api-key-7f3c9e';
    const payload = encrypt(masterKey, scopeId, secret);
    expect(decrypt(masterKey, scopeId, payload)).toBe(secret);
  });

  it('always emits a full 16-byte auth tag', () => {
    const payload = encrypt(masterKey, scopeId, 'x');
    expect(Buffer.from(payload.authTag, 'base64')).toHaveLength(16);
  });

  it('rejects a truncated auth tag (GCM tag-length downgrade)', () => {
    const payload = encrypt(masterKey, scopeId, 'sensitive');
    // A GCM n-byte tag is the first n bytes of the full tag, so a truncated
    // tag verifies under a shorter authTagLength — the downgrade this guards.
    const truncated: EncryptedPayload = {
      ...payload,
      authTag: Buffer.from(payload.authTag, 'base64').subarray(0, 8).toString('base64'),
    };
    // Behavioral guard. Matching the specific message (not a bare .toThrow)
    // rejects a false-pass on an unrelated error. Scope, honestly stated:
    // on Node <=25 (incl. CI's Node 22) an UNpinned decipher accepts the
    // 8-byte tag and does not throw — so removing the pin fails this test.
    // On Node 26+ the runtime rejects short tags by default with the SAME
    // message, so this test alone can no longer tell pinned from unpinned.
    // The structural test below is the runtime-independent guard.
    expect(() => decrypt(masterKey, scopeId, truncated)).toThrow(
      /authentication tag length/i,
    );
  });

  it('pins the decipher auth-tag length in source (structural, runtime-independent)', () => {
    // Once the Node default converges with the pinned behavior (Node 26+),
    // no black-box decrypt()-throws test can distinguish a pinned decipher
    // from an unpinned one. This asserts the source itself still constructs
    // createDecipheriv with authTagLength: 16 — so the pin cannot be
    // silently removed regardless of Node version.
    const src = readFileSync(new URL('./crypto.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/createDecipheriv\([\s\S]*?authTagLength:\s*16/);
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encrypt(masterKey, scopeId, 'sensitive');
    const bytes = Buffer.from(payload.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered: EncryptedPayload = {
      ...payload,
      ciphertext: bytes.toString('base64'),
    };
    expect(() => decrypt(masterKey, scopeId, tampered)).toThrow();
  });

  it('rejects decryption under the wrong scope', () => {
    const payload = encrypt(masterKey, scopeId, 'sensitive');
    expect(() => decrypt(masterKey, 'tenant-99/other', payload)).toThrow();
  });
});
