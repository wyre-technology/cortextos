import { wrapEmail, firstName, escapeHtml } from './base.js';

interface DripFeedbackData {
  recipientName?: string;
}

export function dripFeedbackSubject(): string {
  return "How's the first week going?";
}

export function dripFeedbackHtml(data: DripFeedbackData): string {
  const first = firstName(data.recipientName);
  const greeting = first ? `Hey ${escapeHtml(first)},` : 'Hey there,';

  const body = `
    <p style="margin: 0 0 16px 0;">${greeting}</p>
    <p style="margin: 0 0 16px 0;">
      You&rsquo;ve had the gateway for about a week now, and I genuinely want to
      hear how it&rsquo;s going. No survey link, no form &mdash; just three quick
      questions:
    </p>
    <ol style="margin: 0 0 20px 0; padding-left: 20px; font-family: 'Nunito Sans', sans-serif; font-size: 15px; line-height: 1.8; color: #1a1a1a;">
      <li>What&rsquo;s the first thing you used the gateway for?</li>
      <li>Anything that felt harder than it should be?</li>
      <li>What would make you recommend this to another MSP?</li>
    </ol>
    <p style="margin: 0 0 16px 0;">
      Every reply goes straight to my inbox. No support ticket, no form &mdash;
      just hit reply. I read every single one.
    </p>
    <p style="margin: 0 0 16px 0;">
      We&rsquo;re building this alongside MSPs like you, and your feedback
      directly shapes what we work on next.
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
    preheader: "One week in — I'd love to hear how it's going.",
    body,
  });
}
