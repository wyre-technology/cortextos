import type { VendorConfig, VendorField } from '../../credentials/vendor-config.js';
import { brand } from '../../brand/index.js';
import { THEME_VARS } from '../styles.js';

/**
 * Escapes a string for safe inclusion in HTML content.
 * Prevents XSS by encoding characters that have special meaning in HTML.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes a string for safe inclusion in an HTML attribute value.
 * Delegates to the same encoding as escapeHtml since both contexts
 * require the same character set to be neutralized.
 */
function escapeAttr(unsafe: string): string {
  return escapeHtml(unsafe);
}

/** Shared CSS used across all web pages. */
const BASE_STYLES = `
  ${THEME_VARS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-body);
    color: var(--text-primary);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 40px 32px;
    width: 100%;
    max-width: 480px;
  }
  .brand {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-bottom: 24px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    color: var(--text-heading);
    margin-bottom: 8px;
  }
  .subtitle {
    font-size: 14px;
    color: var(--text-secondary);
    margin-bottom: 28px;
  }
  .error-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 24px;
    font-size: 14px;
    color: var(--error-text);
  }
  label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-label);
    margin-bottom: 6px;
  }
  .field-group {
    margin-bottom: 20px;
  }
  input[type="text"],
  input[type="password"],
  select {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s ease;
    outline: none;
  }
  input[type="text"]:focus,
  input[type="password"]:focus,
  select:focus {
    border-color: var(--accent-light);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
  }
  input::placeholder { color: var(--text-muted); }
  select { cursor: pointer; appearance: none; }
  .required-mark { color: var(--error); margin-left: 2px; }
  .btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 12px 20px;
    background: var(--accent-light);
    color: var(--text-on-accent);
    font-size: 15px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s ease;
    margin-top: 8px;
  }
  .btn-primary:hover { background: var(--accent); }
  .btn-primary:active { background: var(--accent-hover); }
  .help-link {
    display: block;
    text-align: center;
    margin-top: 20px;
    font-size: 13px;
    color: var(--text-tertiary);
  }
  .help-link a {
    color: var(--accent-light);
    text-decoration: none;
  }
  .help-link a:hover { text-decoration: underline; }
  .theme-toggle-standalone {
    position: fixed;
    top: 16px;
    right: 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 6px;
    cursor: pointer;
    color: var(--text-tertiary);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .theme-toggle-standalone:hover { color: var(--text-primary); }
  .theme-toggle-standalone svg { width: 18px; height: 18px; }
`;

/**
 * Renders a single form field (input, password, or select) based on the vendor field definition.
 */
function renderField(field: VendorField): string {
  const id = escapeAttr(field.key);
  const requiredAttr = field.required ? ' required' : '';
  const requiredMark = field.required
    ? '<span class="required-mark">*</span>'
    : '';
  const placeholder = field.placeholder
    ? ` placeholder="${escapeAttr(field.placeholder)}"`
    : '';

  let input: string;

  if (field.options && field.options.length > 0) {
    const options = field.options
      .map((opt) => `<option value="${escapeAttr(opt)}">${escapeHtml(opt)}</option>`)
      .join('\n            ');
    input = `<select id="${id}" name="${id}"${requiredAttr}>
            <option value="">Select...</option>
            ${options}
          </select>`;
  } else if (field.secret) {
    input = `<input type="password" id="${id}" name="${id}" autocomplete="off"${placeholder}${requiredAttr} />`;
  } else {
    input = `<input type="text" id="${id}" name="${id}"${placeholder}${requiredAttr} />`;
  }

  return `
        <div class="field-group">
          <label for="${id}">${escapeHtml(field.label)}${requiredMark}</label>
          ${input}
        </div>`;
}

function buildBugReportUrl(vendorName: string, error: string): string {
  const title = `[Gateway] ${vendorName} credential validation failed`;
  const body = [
    '## Bug Report',
    '',
    `**Vendor:** ${vendorName}`,
    `**Error:** ${error}`,
    `**Timestamp:** ${new Date().toISOString()}`,
    '',
    '## Steps to Reproduce',
    `1. Go to /connect/${vendorName.toLowerCase().replace(/\s+/g, '-')}`,
    '2. Enter credentials and submit',
    '3. See error above',
    '',
    '## Additional Context',
    '<!-- Add any other context about the problem here -->',
  ].join('\n');

  const params = new URLSearchParams({
    title,
    body,
    labels: 'bug,gateway',
  });
  return `${brand.issuesUrl}?${params.toString()}`;
}

/**
 * Generates a complete HTML page containing the credential entry form
 * for a specific vendor. The page uses inline styles and requires no
 * external assets.
 *
 * @param vendor   - The vendor configuration defining which fields to render.
 * @param oauthSession - Optional OAuth session ID to carry through the form submission.
 * @param error    - Optional error message to display above the form.
 * @param alreadyConnected - Whether the user already has credentials for this vendor.
 * @returns A self-contained HTML string.
 */
export function renderConnectPage(
  vendor: VendorConfig,
  oauthSession?: string,
  error?: string,
  alreadyConnected?: boolean,
): string {
  const fields = vendor.fields.map(renderField).join('');

  const connectedBanner = alreadyConnected
    ? `<div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:6px;padding:12px 16px;margin-bottom:24px;font-size:14px;color:var(--success-text);">Already connected. Submit the form below to update your credentials.</div>`
    : '';

  let errorBanner = '';
  if (error) {
    const reportUrl = escapeAttr(buildBugReportUrl(vendor.name, error));
    errorBanner = `<div class="error-banner">${escapeHtml(error)}<br><a href="${reportUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--error-text);font-size:12px;margin-top:4px;display:inline-block;">Report this issue</a></div>`;
  }

  const hiddenSession = oauthSession
    ? `<input type="hidden" name="oauth_session" value="${escapeAttr(oauthSession)}" />`
    : '';

  const buttonLabel = `${alreadyConnected ? 'Update' : 'Connect'} ${escapeHtml(vendor.name)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect ${escapeHtml(vendor.name)} - ${escapeHtml(brand.name)}</title>
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>${BASE_STYLES}
  .btn-primary:disabled { background: #1e3a5f; cursor: wait; }
  .card-header { display: flex; align-items: flex-start; justify-content: space-between; }
  .btn-close {
    background: none; border: none; color: var(--text-tertiary); font-size: 22px; cursor: pointer;
    padding: 0 0 0 12px; line-height: 1; transition: color 0.15s;
  }
  .btn-close:hover { color: var(--text-primary); }
  .btn-cancel {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 12px 20px; background: transparent; color: var(--text-secondary);
    font-size: 15px; font-weight: 500; font-family: inherit;
    border: 1px solid var(--border-primary); border-radius: 6px; cursor: pointer;
    transition: border-color 0.15s, color 0.15s; margin-top: 8px; text-decoration: none;
  }
  .btn-cancel:hover { border-color: var(--text-muted); color: var(--text-primary); }
  .form-actions { display: flex; gap: 10px; }
  .form-actions .btn-primary { flex: 1; }
  </style>
</head>
<body>
  <button class="theme-toggle-standalone" onclick="toggleTheme()" aria-label="Toggle theme">
    <svg id="themeIconSun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
    <svg id="themeIconMoon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
  </button>
  <div class="card">
    <div class="card-header">
      <div class="brand" style="margin-bottom:0">${escapeHtml(brand.name)}</div>
      <a href="/settings" class="btn-close" title="Back to settings" aria-label="Close">&times;</a>
    </div>
    <h1 style="margin-top:16px">Connect ${escapeHtml(vendor.name)}</h1>
    <p class="subtitle">Enter your ${escapeHtml(vendor.name)} credentials to get started.</p>
    ${connectedBanner}
    ${errorBanner}
    <form method="POST" action="/connect/${escapeAttr(vendor.slug)}" onsubmit="var b=this.querySelector('.btn-primary');b.disabled=true;b.textContent='Validating\u2026';">
      ${hiddenSession}
      ${fields}
      <div class="form-actions">
        <button type="submit" class="btn-primary">${buttonLabel}</button>
        <a href="/settings" class="btn-cancel">Cancel</a>
      </div>
    </form>
    <div class="help-link">
      Need help? <a href="${escapeAttr(vendor.docsUrl)}" target="_blank" rel="noopener noreferrer">View ${escapeHtml(vendor.name)} documentation</a>
    </div>
  </div>
  <script>
    function updateThemeUI() {
      var isLight = document.documentElement.classList.contains('light');
      document.getElementById('themeIconSun').style.display = isLight ? 'block' : 'none';
      document.getElementById('themeIconMoon').style.display = isLight ? 'none' : 'block';
    }
    function toggleTheme() {
      document.documentElement.classList.toggle('light');
      var isLight = document.documentElement.classList.contains('light');
      localStorage.setItem('gateway-theme', isLight ? 'light' : 'dark');
      updateThemeUI();
    }
    updateThemeUI();
  </script>
</body>
</html>`;
}
