/**
 * Transactional email send paths — the categories the privacy policy
 * (src/web/legal.ts) commits to: invitations, welcome, security notices.
 *
 * Every function here is fire-and-forget: it catches and logs its own
 * failure and never throws to the caller. Email delivery must never block or
 * fail the HTTP request that triggered it (a login, an invite, a membership
 * change). When RESEND_API_KEY is unset the underlying client is a logged
 * no-op — see src/email/resend.ts.
 */
import type { FastifyBaseLogger } from 'fastify';
import { sendTransactionalEmail } from './resend.js';

/** Escape a value for safe interpolation into an HTML email body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shared minimal email layout. `bodyHtml` is trusted (built here, escaped). */
function layout(bodyHtml: string): string {
  return (
    '<!doctype html><html><body style="margin:0;padding:24px;' +
    'font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;' +
    'line-height:1.5">' +
    '<div style="max-width:520px;margin:0 auto">' +
    bodyHtml +
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0 16px">' +
    '<p style="color:#888;font-size:12px;margin:0">Conduit — the white-label ' +
    'MSP channel gateway. This is a transactional message about your account.</p>' +
    '</div></body></html>'
  );
}

/**
 * Run a send fire-and-forget: failure is logged, never thrown to the caller.
 *
 * Note: the never-throws guarantee covers the async send only. Each send
 * function does sync work (esc/layout/concat) BEFORE calling this; that work
 * cannot throw because the typed `string` inputs make esc/layout total — if a
 * future caller passes a non-string, restore that guarantee at the call site.
 */
function fireAndForget(
  log: FastifyBaseLogger,
  kind: string,
  to: string,
  send: () => Promise<void>,
): void {
  send().catch((err) => log.warn({ err, kind, to }, 'transactional email failed'));
}

/**
 * Welcome email — sent once, on a user's first login (new-user upsert).
 */
export function sendWelcomeEmail(
  log: FastifyBaseLogger,
  opts: { to: string; name?: string },
): void {
  const greeting = opts.name && !opts.name.includes('@') ? `, ${esc(opts.name)}` : '';
  const html = layout(
    `<h2 style="margin:0 0 12px">Welcome to Conduit${greeting}</h2>` +
      '<p>Your account is ready. Conduit connects your AI agents to the vendor ' +
      'MCP servers your team already relies on — with your credentials injected ' +
      'server-side, never exposed to the agent.</p>' +
      '<p>Sign in any time to connect a vendor or manage your organization.</p>',
  );
  fireAndForget(log, 'welcome', opts.to, () =>
    sendTransactionalEmail(log, { to: opts.to, subject: 'Welcome to Conduit', html }),
  );
}

/**
 * Invitation email — sent when an org admin creates an invitation addressed
 * to a specific email. The shareable copy-link flow is unaffected; this fires
 * only when the create-invitation request carried an invitee address.
 */
export function sendInvitationEmail(
  log: FastifyBaseLogger,
  opts: { to: string; orgName: string; inviteUrl: string; invitedByEmail?: string },
): void {
  const inviter = opts.invitedByEmail
    ? `${esc(opts.invitedByEmail)} invited you`
    : 'You have been invited';
  const html = layout(
    '<h2 style="margin:0 0 12px">You\'re invited to join ' +
      `${esc(opts.orgName)}</h2>` +
      `<p>${inviter} to join <strong>${esc(opts.orgName)}</strong> on Conduit.</p>` +
      `<p><a href="${esc(opts.inviteUrl)}" style="display:inline-block;` +
      'background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:6px;' +
      'text-decoration:none">Accept invitation</a></p>' +
      '<p style="color:#888;font-size:13px">Or paste this link into your browser:' +
      `<br>${esc(opts.inviteUrl)}</p>`,
  );
  fireAndForget(log, 'invitation', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `You're invited to join ${opts.orgName} on Conduit`,
      html,
    }),
  );
}

/**
 * Security notice — the user was removed from an organization.
 */
export function sendMemberRemovedEmail(
  log: FastifyBaseLogger,
  opts: { to: string; orgName: string },
): void {
  const html = layout(
    '<h2 style="margin:0 0 12px">You were removed from an organization</h2>' +
      `<p>Your access to <strong>${esc(opts.orgName)}</strong> on Conduit has ` +
      'been removed by an organization admin.</p>' +
      '<p>If you believe this was a mistake, contact an admin of that ' +
      'organization. You did not need to do anything — this is a security ' +
      'notice so the change is visible to you.</p>',
  );
  fireAndForget(log, 'member_removed', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `You were removed from ${opts.orgName}`,
      html,
    }),
  );
}

/**
 * Security notice — the user's role in an organization changed.
 */
export function sendRoleChangedEmail(
  log: FastifyBaseLogger,
  opts: { to: string; orgName: string; newRole: string },
): void {
  const html = layout(
    '<h2 style="margin:0 0 12px">Your role changed</h2>' +
      `<p>Your role in <strong>${esc(opts.orgName)}</strong> on Conduit was ` +
      `changed to <strong>${esc(opts.newRole)}</strong> by an organization ` +
      'admin.</p>' +
      '<p>If you believe this was a mistake, contact an admin of that ' +
      'organization. This is a security notice so the change is visible to you.</p>',
  );
  fireAndForget(log, 'role_changed', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `Your role in ${opts.orgName} changed`,
      html,
    }),
  );
}
