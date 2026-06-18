import { PAGE_STYLES } from './styles.js';

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns `value` only if it is a plain hex color (`#rgb`/`#rrggbb`/
 * `#rrggbbaa`), else `fallback`. `escapeHtml` makes a value safe for an
 * HTML *attribute* but NOT for a CSS context — `;`, `{`, `(` etc. pass
 * through. Any value bound into a `style="..."` must go through this so
 * a future reseller-supplied color cannot inject CSS.
 */
export function safeCssColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : fallback;
}

/**
 * JSON-encode `value` for safe embedding INSIDE a `<script>` element.
 *
 * Warden HIGH-sev XSS finding on PR #447 (LAYER-C delete-button UI
 * fast-win, boss msg-1781749015009): `JSON.stringify` is correct JSON
 * but NOT a safe HTML-script-tag embedder. JSON contains no
 * `</script>` escape because there's no need inside pure JSON — but in
 * HTML the parser is in "script data" state and `</script>`
 * (case-insensitive) terminates the element BEFORE the JS parser sees
 * the string. A stored value like
 *   `Acme</script><img src=x onerror=…>`
 * therefore breaks out of the script element and executes arbitrary
 * markup in the viewing operator's session — classic stored XSS via
 * the server-side template seam.
 *
 * Defensive sweep: every `${JSON.stringify(...)}` inside a `<script>`
 * block must route through this helper. Even ids that look nanoid-
 * shaped today might tomorrow be fed user-supplied subdomains or
 * display names — by-construction is cheaper than per-site reasoning.
 *
 * Hardening applied:
 *   - Replace every `<` with its `\\u003c` Unicode escape. The JS
 *     parser still sees a normal string; the HTML parser never sees a
 *     tag. One transform closes the `</script>` vector AND defends
 *     against `<!--` HTML-comment ambiguities the same way.
 *   - Replace U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR)
 *     with their Unicode escapes. JSON treats them as ordinary
 *     characters; the JS parser treats them as line terminators that
 *     can break string literals (pre-ES2019 only, but defensive vs old
 *     embedded engines + JSON-vs-JS-literal divergence).
 *
 * Result is safe to embed inside
 * `<script>…var X = ${jsonForScriptEmbed(v)};…</script>`. The output
 * is valid JavaScript (and valid JSON — the escapes survive a
 * JSON.parse round-trip if a consumer ever needs that).
 */
export function jsonForScriptEmbed(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Returns `value` only if it parses as an `https:` URL, else `null`.
 * Blocks `javascript:`, `data:`, and other schemes from reaching an
 * `src`/`href` populated by reseller-supplied data.
 */
export function safeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function renderSuccessPage(vendor: { name: string; slug: string }): string {
  const name = escapeHtml(vendor.name);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected - ${name} - Wyre Technology</title>
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="brand">Wyre Technology</div>
    <div class="success-icon">&#10003;</div>
    <h1>Connected to ${name}</h1>
    <p class="subtitle">Your ${name} credentials have been securely stored. You can now close this window or manage your connections below.</p>
    <div class="back-link">
      <a href="/settings">Manage connections</a>
    </div>
  </div>
</body>
</html>`;
}
