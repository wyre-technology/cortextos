import { wrapEmail, ctaButton, firstName, escapeHtml } from './base.js';

interface DripConnectToolsData {
  recipientName?: string;
}

export function dripConnectToolsSubject(): string {
  return 'Quick question — did you get your first tool connected?';
}

export function dripConnectToolsHtml(data: DripConnectToolsData): string {
  const first = firstName(data.recipientName);
  const greeting = first ? `Hey ${escapeHtml(first)},` : 'Hey there,';

  const body = `
    <p style="margin: 0 0 16px 0;">${greeting}</p>
    <p style="margin: 0 0 16px 0;">
      Just checking in &mdash; now that you&rsquo;re set up on the gateway, I wanted
      to make sure you got at least one tool connected. That first connection
      is the moment it goes from &ldquo;interesting&rdquo; to &ldquo;useful.&rdquo;
    </p>
    <p style="margin: 0 0 12px 0;">
      The three most popular starting points:
    </p>
    <ul style="margin: 0 0 16px 0; padding-left: 20px; font-family: 'Nunito Sans', sans-serif; font-size: 15px; line-height: 1.8; color: #1a1a1a;">
      <li><strong>Autotask</strong> &mdash; tickets, time entries, and service desk ops</li>
      <li><strong>ConnectWise Manage</strong> &mdash; the same, if CW is your PSA</li>
      <li><strong>IT Glue</strong> &mdash; documentation, configs, and passwords</li>
    </ul>
    <p style="margin: 0 0 16px 0;">
      Pick one, drop in your API key, and you&rsquo;ll have tools available in
      Claude within a minute.
    </p>

    ${ctaButton('https://mcp.wyre.ai/settings', 'Connect a Tool')}

    <p style="margin: 0 0 16px 0;">
      If you&rsquo;re stuck on anything, just reply to this email or come find us
      on Discord &mdash; happy to help.
    </p>
    <p style="margin: 0 0 8px 0;">
      Join the MSP community on Discord &mdash; share tips, get help, and connect with other MSPs using AI:
    </p>
    <p style="margin: 0;">
      <a href="https://discord.gg/cCPtPaFw8e" style="font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #00C9DB; text-decoration: none;">
        discord.gg/cCPtPaFw8e
      </a>
    </p>
  `;

  return wrapEmail({
    preheader: 'Connect your first tool — Autotask, ConnectWise, or IT Glue.',
    body,
  });
}
