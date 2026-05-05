import { describe, it, expect } from 'vitest';
import { generateScimToken, hashScimToken } from '../connections-service.js';

describe('SCIM token discipline', () => {
  it('generates 43-char base64url tokens (32 random bytes, no padding)', () => {
    const token = generateScimToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateScimToken));
    expect(tokens.size).toBe(100);
  });

  it('hashes deterministically with sha256 hex', () => {
    expect(hashScimToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes the same token to the same value across calls', () => {
    const token = generateScimToken();
    expect(hashScimToken(token)).toBe(hashScimToken(token));
  });
});
