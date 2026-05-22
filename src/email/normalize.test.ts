import { describe, it, expect } from 'vitest';
import { normalizeEmail } from './normalize.js';

describe('normalizeEmail — single source of truth for store + check paths', () => {
  it('lowercases the entire string (case-insensitive matching invariant)', () => {
    expect(normalizeEmail('Alice@Example.com')).toBe('alice@example.com');
    expect(normalizeEmail('ADMIN@CUSTOMER.IO')).toBe('admin@customer.io');
  });

  it('trims surrounding whitespace (handles wizard form input)', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
    expect(normalizeEmail('\tuser@example.com\n')).toBe('user@example.com');
  });

  it('combines trim and lowercase deterministically', () => {
    expect(normalizeEmail('  USER@EXAMPLE.COM  ')).toBe('user@example.com');
  });

  it('is idempotent — N applications equal one application', () => {
    const once = normalizeEmail('Admin@Example.Com');
    const twice = normalizeEmail(once);
    const thrice = normalizeEmail(twice);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it('preserves all non-whitespace, non-case-sensitive content', () => {
    // Local-part special chars + subdomains + plus-addressing are preserved.
    expect(normalizeEmail('User.Name+tag@Mail.Sub.Example.com'))
      .toBe('user.name+tag@mail.sub.example.com');
  });

  it('does NOT validate well-formedness — that is the caller responsibility', () => {
    // Input "not-an-email" is normalized verbatim without error. The
    // validate-email check lives at src/signup/routes.ts validateEmail
    // and at parseCreateCustomerBody's @ + length check, not here.
    expect(normalizeEmail('Not-An-Email')).toBe('not-an-email');
    expect(normalizeEmail('')).toBe('');
  });
});
