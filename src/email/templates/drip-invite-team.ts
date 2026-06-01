import { wrapEmail, ctaButton, firstName, escapeHtml } from './base.js';

interface DripInviteTeamData {
  recipientName?: string;
}

export function dripInviteTeamSubject(): string {
  return 'MCP Gateway is better with your team';
}

export function dripInviteTeamHtml(data: DripInviteTeamData): string {
  const first = firstName(data.recipientName);
  const greeting = first ? `Hey ${escapeHtml(first)},` : 'Hey there,';

  const body = `
    <p style="margin: 0 0 16px 0;">${greeting}</p>
    <p style="margin: 0 0 16px 0;">
      Now that you&rsquo;ve had a couple days with the gateway, here&rsquo;s
      something that makes it way more useful: get the rest of your team on it.
    </p>
    <p style="margin: 0 0 16px 0;">
      Shared connections mean less credential juggling &mdash; your team uses the
      same vendor integrations without everyone needing their own API keys. And
      the audit log shows who did what, so you get accountability without
      micromanagement.
    </p>

    ${ctaButton('https://mcp.wyre.ai/settings/team/invitations', 'Invite Your Team')}

    <p style="margin: 0 0 16px 0;">
      Even one colleague is enough to see the difference. Give it a shot.
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
    preheader: 'Invite your team — shared connections, less credential juggling.',
    body,
  });
}
