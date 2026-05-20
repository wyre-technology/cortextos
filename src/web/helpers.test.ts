import { describe, it, expect } from 'vitest';
import { escapeHtml, safeCssColor, safeHttpsUrl } from './helpers.js';

describe('escapeHtml', () => {
  it('neutralizes HTML metacharacters', () => {
    expect(escapeHtml('<script>"x"&\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#039;');
  });
});

describe('safeCssColor', () => {
  it('passes plain hex colors through', () => {
    expect(safeCssColor('#0a0', 'var(--accent)')).toBe('#0a0');
    expect(safeCssColor('#00C9DB', 'var(--accent)')).toBe('#00C9DB');
    expect(safeCssColor('#11223344', 'var(--accent)')).toBe('#11223344');
    expect(safeCssColor('  #fff  ', 'var(--accent)')).toBe('#fff');
  });
  it('rejects CSS-injection payloads, falling back', () => {
    // escapeHtml would let all of these through into a style="" context.
    for (const bad of [
      'red',
      'red;background:url(https://evil/x)',
      '#fff} body{display:none',
      '#fff;}',
      'rgb(0,0,0)',
      'var(--x)',
      '#xyz',
      '',
    ]) {
      expect(safeCssColor(bad, 'var(--accent)')).toBe('var(--accent)');
    }
  });
  it('falls back on null / undefined', () => {
    expect(safeCssColor(null, 'var(--accent)')).toBe('var(--accent)');
    expect(safeCssColor(undefined, 'var(--accent)')).toBe('var(--accent)');
  });
});

describe('safeHttpsUrl', () => {
  it('passes https URLs through', () => {
    expect(safeHttpsUrl('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
  });
  it('rejects non-https schemes', () => {
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(safeHttpsUrl('http://example.com/x.png')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
    expect(safeHttpsUrl('')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
  });
});
