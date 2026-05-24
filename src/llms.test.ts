import { describe, it, expect } from 'vitest';
import { buildLlmsTxt } from './llms.js';

describe('buildLlmsTxt', () => {
  it('emits the llmstxt.org shape: H1 + blockquote summary + ## Docs section', () => {
    const txt = buildLlmsTxt('https://conduit.wyre.ai');
    expect(txt.startsWith('# Conduit\n')).toBe(true);
    expect(txt).toMatch(/\n> Conduit is the white-label MSP channel gateway/);
    expect(txt).toContain('\n## Docs\n');
  });

  it('uses absolute links under the docs base', () => {
    const txt = buildLlmsTxt('https://conduit.wyre.ai');
    expect(txt).toContain('- [Overview](https://conduit.wyre.ai/docs/): ');
    expect(txt).toContain(
      '- [Getting Started](https://conduit.wyre.ai/docs/getting-started/): ',
    );
  });

  it('strips a trailing slash from the base before composing links', () => {
    const txt = buildLlmsTxt('https://conduit.wyre.ai/');
    expect(txt).toContain('(https://conduit.wyre.ai/docs/)');
    expect(txt).not.toContain('//docs');
  });

  it('never lists an internal/ page (excluded from this discovery channel)', () => {
    const txt = buildLlmsTxt('https://conduit.wyre.ai');
    expect(txt).not.toContain('/internal/');
    expect(txt.toLowerCase()).not.toContain('agents-impl');
  });
});
