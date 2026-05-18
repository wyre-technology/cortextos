/**
 * Standalone AES-256-GCM encryption helpers used across credential and OAuth
 * flow-state storage.
 *
 * The cipher, KDF, and parameter sizes are byte-for-byte identical to the
 * legacy private methods that lived on `CredentialService`. Anything that
 * touches at-rest encryption in the gateway should use these helpers so the
 * scope-binding contract (per-record salt + IV, scope-bound derived key) is
 * preserved.
 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
} from 'node:crypto';

/** Encrypted payload shape (all base64-encoded). */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
}

/**
 * Derive an AES-256 key from `masterKey || scopeId` via PBKDF2-SHA512.
 *
 * - 100,000 iterations
 * - 32-byte output key
 * - Caller supplies the per-record salt
 */
export function deriveKey(
  masterKey: Buffer,
  scopeId: string,
  salt: Buffer,
): Buffer {
  const keyMaterial = Buffer.concat([
    masterKey,
    Buffer.from(scopeId, 'utf8'),
  ]);
  return pbkdf2Sync(keyMaterial, salt, 100_000, 32, 'sha512');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * Generates a fresh 32-byte salt and 16-byte IV per call.
 */
export function encrypt(
  masterKey: Buffer,
  scopeId: string,
  plaintext: string,
): EncryptedPayload {
  const salt = randomBytes(32);
  const key = deriveKey(masterKey, scopeId, salt);
  const iv = randomBytes(16);

  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    salt: salt.toString('base64'),
  };
}

/**
 * Decrypt an `EncryptedPayload` produced by {@link encrypt}.
 *
 * Throws if the auth tag fails (tampered ciphertext) or the scope/key is
 * wrong. Callers that want a soft failure should wrap in try/catch.
 */
export function decrypt(
  masterKey: Buffer,
  scopeId: string,
  payload: EncryptedPayload,
): string {
  const salt = Buffer.from(payload.salt, 'base64');
  const key = deriveKey(masterKey, scopeId, salt);
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
