import { wrapEmail, ctaButton, firstName, escapeHtml } from './base.js';

interface DripAccessControlsData {
  recipientName?: string;
}

export function dripAccessControlsSubject(): string {
  return 'Lock it down — set up access controls';
}

export function dripAccessControlsHtml(data: DripAccessControlsData): string {
  const first = firstName(data.recipientName);
  const greeting = first ? `Hey ${escapeHtml(first)},` : 'Hey there,';

  const body = `
    <p style="margin: 0 0 16px 0;">${greeting}</p>
    <p style="margin: 0 0 16px 0;">
      Your team&rsquo;s growing &mdash; now&rsquo;s a good time to set up tool
      access controls. Decide who can use which vendors, so your helpdesk folks
      aren&rsquo;t poking around in billing tools and your engineers have exactly
      what they need.
    </p>
    <p style="margin: 0 0 16px 0;">
      The teams feature lets you group people by role &mdash; helpdesk,
      engineering, management, whatever makes sense for your org. Each team gets
      its own set of allowed tools.
    </p>
    <p style="margin: 0 0 16px 0;">
      Takes about 2 minutes, saves a lot of headaches later.
    </p>

    ${ctaButton('https://mcp.wyre.ai/settings/team/tool-access', 'Set Up Access Controls')}

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
    preheader: 'Set up access controls — decide who can use which tools.',
    body,
  });
}
