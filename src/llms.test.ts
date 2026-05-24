import { describe, it, expect } from 'vitest';
import { LLMS_TXT } from './llms.js';

describe('LLMS_TXT — curated docs-content artifact', () => {
  it('emits the llmstxt.org shape: H1 + blockquote summary + ## sections', () => {
    expect(LLMS_TXT.startsWith('# Conduit\n')).toBe(true);
    expect(LLMS_TXT).toMatch(/\n> Conduit is a white-label MCP gateway/);
    expect(LLMS_TXT).toContain('\n## Start here\n');
    expect(LLMS_TXT).toContain('\n## Reference\n');
  });

  it('uses absolute docs links under the prod host', () => {
    expect(LLMS_TXT).toContain('(https://conduit.wyre.ai/docs/): ');
    expect(LLMS_TXT).toContain(
      '(https://conduit.wyre.ai/docs/getting-started/): ',
    );
  });

  it('never lists an internal/ page (excluded from this discovery channel)', () => {
    expect(LLMS_TXT).not.toContain('/internal/');
    expect(LLMS_TXT.toLowerCase()).not.toContain('agents-impl');
  });

  it('does not advertise the onprem overview page (404 in main — removed pre-serve)', () => {
    // advertised-resource-must-exist: the onprem section entry is the
    // quickstart (which resolves), not /guides/onprem/ (no page in main).
    expect(LLMS_TXT).not.toMatch(/\(https:\/\/conduit\.wyre\.ai\/docs\/guides\/onprem\/\)/);
    expect(LLMS_TXT).toContain('(https://conduit.wyre.ai/docs/guides/onprem/quickstart/): ');
  });

  it('every docs link ends with a trailing slash (directory-format, matches the served URLs)', () => {
    const links = [...LLMS_TXT.matchAll(/\(https:\/\/conduit\.wyre\.ai(\/docs[^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(links.length).toBeGreaterThan(20);
    for (const path of links) {
      expect(path.endsWith('/')).toBe(true);
    }
  });
});
