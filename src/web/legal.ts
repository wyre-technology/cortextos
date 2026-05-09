/**
 * Legal pages — Terms of Service and Privacy Policy
 *
 * Served as standalone pages (no auth required) with minimal styling.
 */

import type { FastifyInstance } from 'fastify';
import { PAGE_STYLES } from './styles.js';

const LEGAL_STYLES = `
  ${PAGE_STYLES}
  body { max-width: 740px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-family: var(--font-heading); font-size: 28px; margin: 0 0 8px; }
  h2 { font-family: var(--font-heading); font-size: 20px; margin: 32px 0 12px; color: var(--text-primary); }
  p, li { line-height: 1.7; color: var(--text-secondary); margin: 0 0 12px; }
  ul { padding-left: 20px; margin: 0 0 16px; }
  a { color: var(--accent-text); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .updated { font-size: 13px; color: var(--text-muted); margin-bottom: 24px; }
  .brand { font-family: var(--font-heading); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 32px; }
  .brand a { color: var(--text-muted); text-decoration: none; }
  .brand a:hover { color: var(--text-secondary); }
  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border-subtle); font-size: 13px; color: var(--text-muted); }
  .footer a { color: var(--accent-text); }
`;

function legalPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — WYRE Technology</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@400;500;600&family=Nunito+Sans:wght@300;400;600;700&display=swap" rel="stylesheet" />
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>${LEGAL_STYLES}</style>
</head>
<body>
  <div class="brand"><a href="/">WYRE Technology &middot; MCP Gateway</a></div>
  ${content}
  <div class="footer">
    <a href="/terms">Terms of Service</a> &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/">Home</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Terms of Service
// ---------------------------------------------------------------------------

const TERMS_CONTENT = `
<p class="updated">Last updated: April 9, 2026</p>
<h1>Terms of Service</h1>
<p>These terms govern your use of MCP Gateway, operated by WYRE Technology, LLC ("WYRE", "we", "us", "our"). By using MCP Gateway, you agree to these terms.</p>

<h2>1. What MCP Gateway Is</h2>
<p>MCP Gateway is a secure proxy service that connects AI assistants (such as Claude) to managed service provider (MSP) tools including ConnectWise, Autotask, Hudu, Datto RMM, and others via the Model Context Protocol (MCP). The gateway stores your vendor API credentials on your behalf and proxies API requests between your AI assistant and your connected tools.</p>

<h2>2. Acceptance of Terms</h2>
<p>By creating an account or using MCP Gateway, you agree to be bound by these Terms of Service. If you are using MCP Gateway on behalf of an organization, you represent that you have authority to bind that organization to these terms. If you do not agree, do not use the service.</p>

<h2>3. Account Registration and Security</h2>
<p>To use MCP Gateway, you must authenticate via Microsoft Entra ID or another supported identity provider. You are responsible for:</p>
<ul>
  <li>Maintaining the security of your account and authentication credentials</li>
  <li>All activity that occurs under your account</li>
  <li>Ensuring that the vendor API credentials you provide are authorized for use with the service</li>
  <li>Notifying us promptly at <a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a> if you believe your account has been compromised</li>
</ul>

<h2>4. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use MCP Gateway to access vendor APIs in a manner that violates those vendors' terms of service</li>
  <li>Attempt to gain unauthorized access to MCP Gateway systems, other users' accounts, or connected vendor systems</li>
  <li>Scrape, crawl, or extract data from MCP Gateway for purposes unrelated to your legitimate use</li>
  <li>Use the service to transmit malware, spam, or any harmful content</li>
  <li>Circumvent rate limits, authentication controls, or other protective measures</li>
  <li>Resell or redistribute access to MCP Gateway without our written permission</li>
  <li>Use the service in any way that violates applicable laws or regulations</li>
</ul>

<h2>5. Intellectual Property</h2>
<p><strong>Our platform:</strong> WYRE Technology owns all rights to the MCP Gateway platform, including its software, design, documentation, and branding. These terms do not grant you any rights to our intellectual property beyond the limited right to use the service.</p>
<p><strong>Your data:</strong> You retain all rights to your data, including the vendor API credentials you provide and the data that flows through the gateway. We claim no ownership over your data.</p>

<h2>6. Data Handling</h2>
<p>We take the security of your data seriously:</p>
<ul>
  <li>Vendor API credentials are encrypted at rest using AES-256 encryption</li>
  <li>All data in transit is protected with TLS</li>
  <li>API requests are proxied in real time and not permanently stored (request logs retained up to 90 days for audit)</li>
  <li>We do not access your vendor data except as necessary to operate the proxy service</li>
</ul>
<p>For full details, see our <a href="/privacy">Privacy Policy</a>.</p>

<h2>7. Service Availability</h2>
<p>We make reasonable efforts to keep MCP Gateway available and reliable. During this early access period, we do not offer a formal SLA. The service may experience downtime for maintenance, updates, or unforeseen issues.</p>
<p>We reserve the right to modify, suspend, or discontinue any part of the service. If we discontinue the service entirely, we will provide at least 30 days' notice and help you export or delete your stored credentials.</p>

<h2>8. Pricing and Billing</h2>
<p>MCP Gateway is currently free during early access. When paid plans are introduced, we will notify existing users at least 30 days in advance. You will not be charged without explicit consent.</p>

<h2>9. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, WYRE Technology shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of MCP Gateway.</p>
<p>Our total liability for any claim shall not exceed the amount you paid us in the twelve months preceding the claim, or $100, whichever is greater.</p>
<p>MCP Gateway proxies requests to third-party vendor APIs. We are not responsible for the availability, accuracy, or behavior of those third-party services.</p>

<h2>10. Indemnification</h2>
<p>You agree to indemnify and hold harmless WYRE Technology from any claims, damages, or expenses arising from your use of the service, your violation of these terms, or your violation of any third party's rights.</p>

<h2>11. Termination</h2>
<p><strong>By you:</strong> You may stop using MCP Gateway at any time. Request deletion of your account and data at <a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a>.</p>
<p><strong>By us:</strong> We may suspend or terminate your access if you violate these terms, if required by law, or if we discontinue the service. We will make reasonable efforts to notify you beforehand.</p>
<p><strong>Effect:</strong> Upon termination, your stored credentials will be deleted. You may request a data export before termination takes effect.</p>

<h2>12. Modification of Terms</h2>
<p>We may update these terms. When we make material changes, we will notify you at least 30 days in advance via email or a notice within the service.</p>

<h2>13. Governing Law</h2>
<p>These terms are governed by the laws of the State of Tennessee. Any disputes will be resolved in the state or federal courts located in Hamilton County, Tennessee.</p>

<h2>14. Contact</h2>
<p>WYRE Technology, LLC<br>Chattanooga, TN<br><a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a></p>
`;

// ---------------------------------------------------------------------------
// Privacy Policy
// ---------------------------------------------------------------------------

const PRIVACY_CONTENT = `
<p class="updated">Last updated: April 9, 2026</p>
<h1>Privacy Policy</h1>
<p>This policy explains how WYRE Technology, LLC ("WYRE", "we", "us") collects, uses, and protects your information when you use MCP Gateway.</p>

<h2>1. Information We Collect</h2>
<p><strong>Account information:</strong> When you sign in via Microsoft Entra ID or Auth0, we receive your email address, display name, and organization identifier. We do not receive or store your Microsoft or identity provider password.</p>
<p><strong>Vendor API credentials:</strong> You provide API keys, tokens, or other credentials for the third-party tools you connect. These are encrypted at rest with AES-256 and stored in our database.</p>
<p><strong>Usage data:</strong> We log which tools are called, timestamps, and response metadata for audit and debugging. Request logs are retained for up to 90 days. We do not log the full content of API responses from your vendor tools.</p>
<p><strong>Organization data:</strong> If you create or join a team, we store the organization name, membership list, role assignments, and team structure.</p>

<h2>2. How We Use Your Information</h2>
<ul>
  <li><strong>Authentication:</strong> Verify your identity and manage access</li>
  <li><strong>Proxying:</strong> Inject your vendor credentials into API requests on your behalf</li>
  <li><strong>Audit logging:</strong> Provide your organization with a record of tool usage</li>
  <li><strong>Billing:</strong> Process payments when paid plans are introduced (via Stripe)</li>
  <li><strong>Communication:</strong> Send transactional emails (invitations, welcome, security notices) via Resend</li>
  <li><strong>Improvement:</strong> Understand usage patterns to improve the service (aggregated, not individual)</li>
</ul>

<h2>3. Data Storage and Security</h2>
<ul>
  <li>Hosted on Microsoft Azure (East US 2 region)</li>
  <li>Vendor credentials encrypted at rest with AES-256 using a hardware-secured master key</li>
  <li>All connections encrypted in transit with TLS 1.2+</li>
  <li>Database access restricted to the gateway application via network-level controls</li>
  <li>No vendor data is cached or stored beyond the duration of a proxied request</li>
</ul>

<h2>4. Third-Party Services</h2>
<p>We use the following third-party services:</p>
<ul>
  <li><strong>Microsoft Entra ID / Auth0:</strong> User authentication</li>
  <li><strong>Stripe:</strong> Payment processing (when paid plans are active)</li>
  <li><strong>Resend:</strong> Transactional email delivery</li>
  <li><strong>Azure Container Apps:</strong> Application hosting</li>
  <li><strong>Azure Database for PostgreSQL:</strong> Data storage</li>
</ul>
<p>Each of these services has its own privacy policy. We only share the minimum information necessary for each service to function.</p>

<h2>5. Data Retention</h2>
<ul>
  <li><strong>Vendor credentials:</strong> Stored until you delete them or your account is terminated</li>
  <li><strong>Audit logs:</strong> Retained for 90 days, then automatically deleted</li>
  <li><strong>Request logs:</strong> Retained for 90 days, then automatically deleted</li>
  <li><strong>Account information:</strong> Retained while your account is active; deleted upon request</li>
</ul>

<h2>6. Your Rights</h2>
<p>You can:</p>
<ul>
  <li><strong>Access</strong> your stored data via the gateway dashboard and API</li>
  <li><strong>Correct</strong> your information by updating your profile or credentials</li>
  <li><strong>Delete</strong> your vendor credentials, organization, or entire account at any time</li>
  <li><strong>Export</strong> your data via the gateway API</li>
</ul>
<p>To exercise any of these rights, use the gateway dashboard or contact <a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a>.</p>

<h2>7. Cookies and Local Storage</h2>
<p>MCP Gateway uses:</p>
<ul>
  <li><strong>Session cookie</strong> (<code>gateway_session</code>): Signed, HTTP-only cookie for authentication. Expires when you close your browser or log out.</li>
  <li><strong>Theme preference</strong> (<code>gateway-theme</code>): Stored in localStorage to remember your light/dark mode choice. Not transmitted to our servers.</li>
</ul>
<p>We do not use tracking cookies, analytics pixels, or third-party advertising cookies.</p>

<h2>8. Children's Privacy</h2>
<p>MCP Gateway is not directed at children under 13. We do not knowingly collect information from children. If you believe a child has provided us with personal information, contact us at <a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a>.</p>

<h2>9. International Data Transfers</h2>
<p>MCP Gateway is hosted in the United States. If you access the service from outside the US, your information will be transferred to and processed in the US. By using the service, you consent to this transfer.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this privacy policy from time to time. When we make material changes, we will notify you via email or a notice within the service. The "Last updated" date at the top reflects the most recent revision.</p>

<h2>11. Contact</h2>
<p>WYRE Technology, LLC<br>Chattanooga, TN<br><a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a></p>
`;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function legalRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/terms', async (_request, reply) => {
      return reply.type('text/html').send(legalPage('Terms of Service', TERMS_CONTENT));
    });

    app.get('/privacy', async (_request, reply) => {
      return reply.type('text/html').send(legalPage('Privacy Policy', PRIVACY_CONTENT));
    });
  };
}
