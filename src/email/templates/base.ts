/**
 * Shared HTML wrapper with Wyre Technology branding.
 *
 * Fonts: Oswald (headings), Nunito Sans (body), IBM Plex Mono (links/code)
 * Colors: #00C9DB (cyan accent), #EDE947 (yellow accent), #1a1a1a (text), #ffffff (bg)
 * Layout: 620px max-width, 48px padding, 4px yellow border on header
 */

const FONT_IMPORTS = `
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Nunito+Sans:wght@400;600;700&family=Oswald:wght@400;500;600&display=swap" rel="stylesheet"/>
`;

function ctaButton(url: string, label: string): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 32px auto;">
      <tr>
        <td style="border-radius: 6px; background-color: #00C9DB;">
          <a href="${url}" target="_blank"
             style="display: inline-block; padding: 14px 32px; font-family: 'Oswald', sans-serif; font-size: 16px; font-weight: 600; color: #1a1a1a; text-decoration: none; text-transform: uppercase; letter-spacing: 0.04em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

export function wrapEmail(options: { preheader?: string; body: string }): string {
  const { preheader, body } = options;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>Wyre Technology</title>
  ${FONT_IMPORTS}
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    body { margin: 0; padding: 0; width: 100% !important; background-color: #f4f4f5; }
    img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5;">
  ${preheader ? `<div style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}

  <!-- Outer wrapper -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f5;">
    <tr>
      <td align="center" style="padding: 40px 16px;">

        <!-- Email container -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="620" style="max-width: 620px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">

          <!-- Header with yellow top border -->
          <tr>
            <td style="border-top: 4px solid #EDE947; padding: 32px 48px 24px 48px;">
              <p style="margin: 0; font-family: 'Oswald', sans-serif; font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #737373; font-variant: small-caps;">
                WYRE Technology &middot; MCP Gateway
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 0 48px 24px 48px; font-family: 'Nunito Sans', sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
              ${body}
            </td>
          </tr>

          <!-- Signature (above the footer border, inside the body's visual block) -->
          <tr>
            <td style="padding: 0 48px 32px 48px; font-family: 'Nunito Sans', sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a;">
              <p style="margin: 0;">Cheers,</p>
              <p style="margin: 2px 0 0 0;"><strong>Aaron Sachs</strong></p>
              <p style="margin: 0; font-size: 13px; color: #737373;">Engineering Lead &middot; WYRE Technology</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 48px; border-top: 1px solid #e5e5e5;">
              <p style="margin: 0 0 8px 0;">
                <a href="https://mcp.wyre.ai" style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #00C9DB; text-decoration: none;">
                  mcp.wyre.ai
                </a>
              </p>
              <p style="margin: 0; font-size: 11px; color: #a3a3a3;">
                <a href="https://mcp.wyre.ai/settings/profile?unsubscribe=true" style="color: #a3a3a3; text-decoration: underline;">Unsubscribe</a>
                &nbsp;&middot;&nbsp;
                <a href="https://mcp.wyre.ai/privacy" style="color: #a3a3a3; text-decoration: none;">Privacy Policy</a>
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Extract a first-name greeting from a free-form `name` field.
 *
 * Callers pass the recipient's full name as provided by the identity provider
 * (Auth0/Entra), which on most OAuth profiles is "First Last" — using it
 * verbatim in a greeting ("Hey Aaron Sachs!") reads stilted. This returns the
 * first whitespace-delimited token, or `undefined` if the input is missing or
 * empty after trimming. Templates pair the result with a "Hey there!" / "Hi
 * there," fallback so a missing name still produces a clean greeting.
 *
 * Examples:
 *   firstName('Aaron Sachs')      // 'Aaron'
 *   firstName('  Aaron  Sachs  ') // 'Aaron'
 *   firstName('Cher')             // 'Cher' (single-name still works)
 *   firstName(undefined)          // undefined
 *   firstName('')                 // undefined
 *   firstName('   ')              // undefined
 */
export function firstName(name?: string): string | undefined {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : undefined;
}

/**
 * HTML-escape a user-controlled string before interpolating into outbound
 * email HTML. Mitigates XSS in HTML email clients (some mail clients run
 * JS or render HTML attributes from interpolated values; defense-in-depth
 * against unknown rendering surfaces). Lifted from drip-founder-welcome.ts
 * to this canonical site so every template inherits the escape-by-construction
 * (warden Finding from PR #302 / WYREAI-95 — asymmetric-defense across N
 * templates → compose-at-root at the template substrate).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { ctaButton };
