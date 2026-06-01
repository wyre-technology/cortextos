import { wyreSignatureHtml } from './signature.js';
import { firstName, escapeHtml } from './base.js';

export interface DripFounderWelcomeData {
  recipientName?: string;
  company?: string;
}

const CALENDLY_URL = 'https://calendly.com/aaronsachs-wyre/1-1-w-aaron';
const DISCORD_URL = 'https://discord.gg/cCPtPaFw8e';

// escapeHtml lifted from this file to base.ts so all 5 drip templates
// inherit escape-by-construction (warden Finding on PR #302 / WYREAI-95 —
// asymmetric-defense across N templates → compose-at-root at the template
// substrate). The base.ts version is a strict superset (also escapes " and ').

// The subject is delivered as Graph's plain-text `subject` field — it is not
// rendered as HTML, so the first name is intentionally not escaped here (the
// HTML body, by contrast, does escape it).
export function dripFounderWelcomeSubject(data: DripFounderWelcomeData): string {
  const first = firstName(data.recipientName);
  return first
    ? `Welcome to WYRE Gateway, ${first}`
    : 'Welcome to WYRE Gateway';
}

export function dripFounderWelcomeHtml(data: DripFounderWelcomeData): string {
  const first = firstName(data.recipientName);
  const greeting = first
    ? `Hi ${escapeHtml(first)},`
    : 'Hi there,';
  const company = escapeHtml(data.company ?? 'your team');
  const p = 'margin:0 0 14px 0;';

  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;' +
    'color:#333333;line-height:1.5;">' +
    `<p style="${p}">${greeting}</p>` +
    `<p style="${p}">Aaron here &mdash; WYRE's Engineering Lead and creator of ` +
    `the WYRE MCP Gateway. Saw ${company} come through and I wanted to say ` +
    'thanks for signing up.</p>' +
    `<p style="${p}">Quick check-in: how's the setup going? Anything not ` +
    'working the way you expected, or any vendor you wish we had? I read every ' +
    'reply.</p>' +
    `<p style="${p}">Also, we run a small Discord for MSPs on the gateway ` +
    '&mdash; handy for "I broke a vendor connection, anyone seen this?" and ' +
    'direct access to me + the team for roadmap input. You\'re welcome in: ' +
    `<a href="${DISCORD_URL}">${DISCORD_URL}</a></p>` +
    `<p style="${p}">If a quick 15 would help, you can ` +
    `<a href="${CALENDLY_URL}">grab a time on my calendar</a> directly ` +
    '&mdash; or just reply with a couple of options.</p>' +
    `<p style="${p}">Best,</p>` +
    wyreSignatureHtml +
    '</div>'
  );
}
