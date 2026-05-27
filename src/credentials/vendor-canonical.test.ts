import { describe, it, expect } from 'vitest';
import { canonicalVendorBehavior } from './vendor-canonical.js';
import type { VendorConfig } from './vendor-config.js';

/**
 * GOLDEN-VECTOR pin for the vendor-registry cross-repo parity gate (Phase 1).
 *
 * canonicalVendorBehavior() DEFINES "equal" for the cross-repo assert
 * (conduit-table vs gateway-table). The gateway repo ships the IDENTICAL
 * canonicalizer; this golden vector pins each repo's copy to a frozen output so
 * the two copies cannot silently diverge (a divergent canonicalizer would
 * silently compare differently-canonicalized forms — masking or false-flagging
 * real drift). The cross-repo CI step ADDITIONALLY asserts the two repos'
 * GOLDEN_INPUT/GOLDEN_OUTPUT are byte-identical, so transitively both
 * canonicalizers provably emit the same output for the same input.
 *
 * !!! KEEP GOLDEN_INPUT + GOLDEN_OUTPUT BYTE-IDENTICAL TO THE GATEWAY REPO's COPY. !!!
 * If you change the canonicalizer, this test reds; update the golden DELIBERATELY
 * (and mirror the change + golden in the gateway repo) — never to silence CI.
 */
const GOLDEN_INPUT: VendorConfig = {
  name: 'Golden Vendor (cosmetic — dropped from behavioral canonical)',
  slug: 'golden-vendor',
  category: 'rmm',
  containerUrl: 'http://golden-vendor-mcp:8080', // KEPT — the proxy target is behavioral
  fields: [
    // intentionally out of sorted order to prove fieldNames is sorted
    { key: 'region', label: 'Region (cosmetic)', required: false },
    { key: 'apiKey', label: 'API Key (cosmetic)', required: true, secret: true },
  ],
  // intentionally out of sorted key order to prove headerMapping keys are sorted
  headerMapping: { region: 'X-Golden-Region', apiKey: 'X-Golden-Key' },
  docsUrl: 'https://example.com/docs', // dropped (cosmetic)
  preview: false,
  mcpPath: '/mcp',
};

const GOLDEN_OUTPUT =
  '{"category":"rmm","containerUrl":"http://golden-vendor-mcp:8080","fieldNames":["apiKey","region"],"headerMapping":{"apiKey":"X-Golden-Key","region":"X-Golden-Region"},"mcpPath":"/mcp","oauth":null,"slug":"golden-vendor"}';

describe('canonicalVendorBehavior — golden-vector pin (must match the gateway repo byte-for-byte)', () => {
  it('emits the frozen canonical output for the golden input', () => {
    expect(canonicalVendorBehavior(GOLDEN_INPUT)).toBe(GOLDEN_OUTPUT);
  });

  it('drops cosmetic fields (name, labels, docsUrl) but KEEPS behavioral containerUrl', () => {
    const out = canonicalVendorBehavior(GOLDEN_INPUT);
    expect(out).not.toContain('Golden Vendor');
    expect(out).not.toContain('docs');
    expect(out).not.toContain('cosmetic');
    // containerUrl is the proxy target — behaviour-determining, so INCLUDED.
    expect(out).toContain('http://golden-vendor-mcp:8080');
  });

  it('is order-insensitive on headerMapping keys and field order (sorted)', () => {
    const reordered: VendorConfig = {
      ...GOLDEN_INPUT,
      fields: [...GOLDEN_INPUT.fields].reverse(),
      headerMapping: { apiKey: 'X-Golden-Key', region: 'X-Golden-Region' },
    };
    expect(canonicalVendorBehavior(reordered)).toBe(canonicalVendorBehavior(GOLDEN_INPUT));
  });

  it('includes oauth shape when present (behavior-determining)', () => {
    const oauthVendor: VendorConfig = {
      ...GOLDEN_INPUT,
      slug: 'golden-oauth',
      oauthConfig: {
        authorizeUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'admin'],
        clientIdEnv: 'X_CLIENT_ID',
        clientSecretEnv: 'X_CLIENT_SECRET',
      },
    };
    const out = canonicalVendorBehavior(oauthVendor);
    expect(out).toContain('authorizeUrl');
    expect(out).toContain('"scopes":["admin","read"]'); // sorted
    expect(out).not.toContain('X_CLIENT_SECRET'); // env-keyed secret not in output
  });
});
