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

describe('azure-ad env fallback (legacy MICROSOFT_* naming)', () => {
  // Deployments that predate the AZURE_AD_* naming convention (notably the
  // staging Container App today) still set MICROSOFT_CLIENT_ID and
  // MICROSOFT_CLIENT_SECRET. The config layer accepts those as fallbacks
  // so the Microsoft sign-in flow remains live during the env-rename
  // migration. Drop these tests once all environments are migrated and
  // the fallback is removed from src/config.ts.

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    // Stable baseline so config can load.
    vi.stubEnv('MASTER_KEY', 'abcdef0123456789'.repeat(4));
    vi.stubEnv('JWT_SECRET', '0123456789abcdef'.repeat(4));
    // Clear auth env vars to undefined so ?? fallback semantics behave
    // the same way they do in production where the variable simply
    // isn't set. Empty-string would NOT trigger the fallback because
    // ?? only falls back on null/undefined.
    delete process.env.AZURE_AD_CLIENT_ID;
    delete process.env.AZURE_AD_CLIENT_SECRET;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.AUTH_PROVIDER;
  });

  it('prefers AZURE_AD_* when both naming styles are set', async () => {
    vi.stubEnv('AZURE_AD_CLIENT_ID', 'azure-id');
    vi.stubEnv('AZURE_AD_CLIENT_SECRET', 'azure-secret');
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'legacy-id');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'legacy-secret');

    const { config } = await import('./config.js');
    expect(config.azureClientId).toBe('azure-id');
    expect(config.azureClientSecret).toBe('azure-secret');
  });

  it('falls back to MICROSOFT_* when AZURE_AD_* is unset', async () => {
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'legacy-id');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'legacy-secret');

    const { config } = await import('./config.js');
    expect(config.azureClientId).toBe('legacy-id');
    expect(config.azureClientSecret).toBe('legacy-secret');
  });

  it('resolves to empty string when neither is set', async () => {
    const { config } = await import('./config.js');
    expect(config.azureClientId).toBe('');
    expect(config.azureClientSecret).toBe('');
  });

  it('defaults authProvider to "auto" (was "auth0") so present-credential providers register', async () => {
    const { config } = await import('./config.js');
    expect(config.authProvider).toBe('auto');
  });

  it('respects explicit AUTH_PROVIDER over the auto default', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'auth0');
    const { config } = await import('./config.js');
    expect(config.authProvider).toBe('auth0');
  });
});
