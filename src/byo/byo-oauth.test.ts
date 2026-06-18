import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../credentials/safe-fetch.js', () => ({
  validateVendorBaseUrl: vi.fn().mockResolvedValue(undefined),
}));

import {
  discoverByoAuthServer,
  buildByoAuthorizeUrl,
  exchangeByoCode,
  type ByoAuthServerMetadata,
} from './byo-oauth.js';
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';

const AS = 'https://auth.byo.example.com';
const ASM_FULL = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  scopes_supported: ['read', 'write'],
  code_challenge_methods_supported: ['S256'],
};

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/** fetch stub routed by URL: PRM, AS metadata, token endpoint. */
function discoveryFetch(asm: Record<string, unknown> = ASM_FULL) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return jsonRes({ resource: 'https://byo.example.com', authorization_servers: [AS] });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return jsonRes(asm);
    }
    if (url === `${AS}/token`) {
      return jsonRes({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    }
    return jsonRes({}, false, 404);
  });
}

const META: ByoAuthServerMetadata = {
  issuer: AS,
  authorizationEndpoint: `${AS}/authorize`,
  tokenEndpoint: `${AS}/token`,
  scopesSupported: ['read'],
  codeChallengeMethodsSupported: ['S256'],
};

describe('byo-oauth', () => {
  beforeEach(() => {
    vi.mocked(validateVendorBaseUrl).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('discoverByoAuthServer (RFC 9728 → 8414)', () => {
    it('discovers the AS and returns its endpoints', async () => {
      vi.stubGlobal('fetch', discoveryFetch());
      const meta = await discoverByoAuthServer('https://byo.example.com/mcp');
      expect(meta).toMatchObject({
        issuer: AS,
        authorizationEndpoint: `${AS}/authorize`,
        tokenEndpoint: `${AS}/token`,
        registrationEndpoint: `${AS}/register`,
        scopesSupported: ['read', 'write'],
      });
    });

    it('REFUSES an AS with no issuer (RFC 9207 mandate — #437)', async () => {
      const { issuer: _omit, ...noIssuer } = ASM_FULL;
      vi.stubGlobal('fetch', discoveryFetch(noIssuer));
      await expect(discoverByoAuthServer('https://byo.example.com/mcp')).rejects.toThrow(/issuer/i);
    });

    it('throws when the resource advertises no authorization_servers', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ resource: 'https://byo.example.com', authorization_servers: [] })));
      await expect(discoverByoAuthServer('https://byo.example.com/mcp')).rejects.toThrow(/no authorization_servers/);
    });

    it('SSRF-rejects the resource URL before any fetch', async () => {
      vi.mocked(validateVendorBaseUrl).mockRejectedValueOnce(new Error('rejected: non-public host'));
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      await expect(discoverByoAuthServer('http://169.254.169.254/mcp')).rejects.toThrow(/rejected/);
      expect(f).not.toHaveBeenCalled();
    });
  });

  describe('buildByoAuthorizeUrl', () => {
    it('builds a PKCE S256 authorize URL against the discovered endpoint', () => {
      const url = new URL(
        buildByoAuthorizeUrl(META, {
          clientId: 'cid', redirectUri: 'https://gw/cb', state: 'st', codeVerifier: 'v'.repeat(64), scopes: ['read', 'write'],
        }),
      );
      expect(`${url.origin}${url.pathname}`).toBe(`${AS}/authorize`);
      expect(url.searchParams.get('client_id')).toBe('cid');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('scope')).toBe('read write');
      expect(url.searchParams.get('state')).toBe('st');
    });
  });

  describe('exchangeByoCode', () => {
    it('exchanges a code for tokens when iss matches the discovered issuer', async () => {
      vi.stubGlobal('fetch', discoveryFetch());
      const tokens = await exchangeByoCode(META, {
        code: 'c', codeVerifier: 'v', clientId: 'cid', redirectUri: 'https://gw/cb', iss: AS,
      });
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.refreshToken).toBe('rt-1');
    });

    it('rejects a mismatched callback iss (RFC 9207) before the token fetch', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      await expect(
        exchangeByoCode(META, { code: 'c', codeVerifier: 'v', clientId: 'cid', redirectUri: 'https://gw/cb', iss: 'https://evil.example.com' }),
      ).rejects.toThrow(/issuer check failed/);
      expect(f).not.toHaveBeenCalled();
    });

    it('rejects a missing callback iss (fail-closed, no skip)', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      await expect(
        exchangeByoCode(META, { code: 'c', codeVerifier: 'v', clientId: 'cid', redirectUri: 'https://gw/cb', iss: undefined }),
      ).rejects.toThrow(/issuer check failed/);
      expect(f).not.toHaveBeenCalled();
    });
  });
});
