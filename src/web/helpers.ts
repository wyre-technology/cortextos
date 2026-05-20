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
