import { describe, it, expect } from 'vitest';
import { escapeHtml, jsonForScriptEmbed, safeCssColor, safeHttpsUrl } from './helpers.js';

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

describe('jsonForScriptEmbed', () => {
  // Warden HIGH-sev XSS regression artifact (PR #447, boss msg-1781749015009).
  // JSON.stringify alone is unsafe in <script>-embed context — </script> in a
  // user-controlled value breaks out of the script element and executes
  // arbitrary HTML. This helper hardens against that vector.

  it('escapes </script> inside a string so the HTML parser never sees a tag', () => {
    const malicious = 'foo</script><img src=x onerror=alert(1)>';
    const out = jsonForScriptEmbed(malicious);
    // The actual closing tag sequence MUST NOT appear in the output.
    expect(out).not.toContain('</script>');
    // Only `<` needs escaping: once the HTML parser can't see the
    // opening `<` of `</script>`, the trailing `>` is harmless — the
    // parser stays in script-data state through it. So the escaped
    // form is `</script>` (left bracket escaped, right bracket
    // unchanged) — that's enough to neutralize the vector.
    expect(out).toContain('\\u003c/script>');
    expect(out).toContain('\\u003cimg src=x onerror=alert(1)>');
  });

  it('escapes ALL `<` occurrences, including <!-- HTML-comment ambiguity', () => {
    const out = jsonForScriptEmbed('<!-- <body> <X>');
    expect(out).not.toContain('<');
    // Three `<` in the input → three `<` in the output.
    expect((out.match(/\\u003c/g) ?? []).length).toBe(3);
  });

  it('preserves a benign string and produces valid JSON', () => {
    const out = jsonForScriptEmbed('Acme Corp');
    expect(out).toBe('"Acme Corp"');
    expect(JSON.parse(out)).toBe('Acme Corp');
  });

  it('escapes U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR', () => {
    // These are valid JSON but JS line terminators that can break a string
    // literal inside <script>. JSON.parse round-trips them unchanged.
    const sample = 'a b c';
    const out = jsonForScriptEmbed(sample);
    expect(out).not.toContain(' ');
    expect(out).not.toContain(' ');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    // The original string round-trips through JSON.parse correctly.
    expect(JSON.parse(out)).toBe(sample);
  });

  it('the embedded value round-trips through JSON.parse to the original string', () => {
    // JSON.parse handles \uXXXX escapes identically to the JS string-
    // literal parser, so JSON.parse(out) === what a runtime <script>
    // assignment would see. That gives us the JS-parse equivalence
    // guarantee with zero dynamic-code-execution machinery in the
    // test corpus (no Function-constructor pattern for copy-paste to
    // turn into a real vulnerability later).
    const malicious = 'foo</script><img src=x>';
    expect(JSON.parse(jsonForScriptEmbed(malicious))).toBe(malicious);
  });

  it('handles non-string values cleanly (numbers, booleans, objects, null)', () => {
    expect(jsonForScriptEmbed(42)).toBe('42');
    expect(jsonForScriptEmbed(true)).toBe('true');
    expect(jsonForScriptEmbed(null)).toBe('null');
    // Only `<` is escaped; `>` passes through unchanged (harmless once
    // the parser can't see a tag-open).
    expect(jsonForScriptEmbed({ a: '<x>' })).toBe('{"a":"\\u003cx>"}');
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
