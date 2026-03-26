import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects MASTER_KEY shorter than 64 hex chars', async () => {
    vi.stubEnv('MASTER_KEY', 'tooshort');
    vi.stubEnv('JWT_SECRET', 'a'.repeat(64));

    await expect(() => import('./config.js')).rejects.toThrow(
      'must be exactly 64 hex characters',
    );
  });

  it('rejects MASTER_KEY with non-hex characters', async () => {
    vi.stubEnv('MASTER_KEY', 'g'.repeat(64));
    vi.stubEnv('JWT_SECRET', 'a'.repeat(64));

    await expect(() => import('./config.js')).rejects.toThrow(
      'must be exactly 64 hex characters',
    );
  });

  it('accepts valid 64-char hex keys', async () => {
    vi.stubEnv('MASTER_KEY', 'abcdef0123456789'.repeat(4));
    vi.stubEnv('JWT_SECRET', '0123456789abcdef'.repeat(4));

    const { config } = await import('./config.js');
    expect(config.masterKey).toBe('abcdef0123456789'.repeat(4));
    expect(config.jwtSecret).toBe('0123456789abcdef'.repeat(4));
  });

  it('auto-generates keys and warns when not set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MASTER_KEY', '');
    vi.stubEnv('JWT_SECRET', '');

    const { config } = await import('./config.js');
    expect(config.masterKey).toMatch(/^[0-9a-f]{64}$/);
    expect(config.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
