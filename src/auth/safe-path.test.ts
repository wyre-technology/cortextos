import { describe, it, expect } from 'vitest';
import { isSafePath } from './safe-path.js';

describe('isSafePath', () => {
  it('accepts simple absolute paths', () => {
    expect(isSafePath('/')).toBe(true);
    expect(isSafePath('/settings')).toBe(true);
    expect(isSafePath('/org/billing')).toBe(true);
    expect(isSafePath('/settings?upgraded=true')).toBe(true);
    expect(isSafePath('/connect/datto-rmm?return=1')).toBe(true);
  });

  it('rejects non-strings and empty', () => {
    expect(isSafePath('')).toBe(false);
    expect(isSafePath(null)).toBe(false);
    expect(isSafePath(undefined)).toBe(false);
    expect(isSafePath(42)).toBe(false);
    expect(isSafePath({})).toBe(false);
  });

  it('rejects paths that do not start with /', () => {
    expect(isSafePath('settings')).toBe(false);
    expect(isSafePath('https://evil.com')).toBe(false);
    expect(isSafePath('javascript:alert(1)')).toBe(false);
    expect(isSafePath('about:blank')).toBe(false);
  });

  it('rejects protocol-relative URLs', () => {
    expect(isSafePath('//evil.com')).toBe(false);
    expect(isSafePath('//evil.com/path')).toBe(false);
  });

  it('rejects backslash-protocol-relative variants (browser quirk)', () => {
    expect(isSafePath('/\\evil.com')).toBe(false);
    expect(isSafePath('/\\\\evil.com')).toBe(false);
  });

  it('rejects CR/LF (header injection)', () => {
    expect(isSafePath('/foo\r\nLocation: https://evil.com')).toBe(false);
    expect(isSafePath('/foo\nbar')).toBe(false);
    expect(isSafePath('/foo\rbar')).toBe(false);
  });

  it('rejects NUL and tab', () => {
    expect(isSafePath('/foo\x00bar')).toBe(false);
    expect(isSafePath('/foo\tbar')).toBe(false);
  });

  it('serves as a TS type guard', () => {
    const value: unknown = '/settings';
    if (isSafePath(value)) {
      // After the guard, value is narrowed to string. This compiles.
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
