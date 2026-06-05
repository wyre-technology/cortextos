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

/**
 * MR1 — invite-accepted-admin-notify (ruby MR1 launch-blocker 2026-06-05).
 *
 * Fires when an invitee accepts an outstanding org invitation. Notifies
 * the inviter (admin) that the invite landed — admin previously had no
 * signal of acceptance beyond manually re-checking the members list.
 *
 * Scribe Voice 4 admin-trusting-teammate register. COPY-PLACEHOLDER:
 * subject + body land in scribe's deliverable; this helper ships the
 * structural surface with default-graceful copy.
 */
export function sendInvitationAcceptedEmail(
  log: FastifyBaseLogger,
  opts: { to: string; orgName: string; inviteeEmail: string; inviteeName?: string },
): void {
  const inviteeLabel = opts.inviteeName?.trim() || 'A teammate';
  const html = layout(
    '<h2 style="margin:0 0 12px">Your invite was accepted</h2>' +
      `<p><strong>${esc(inviteeLabel)}</strong> (${esc(opts.inviteeEmail)}) accepted ` +
      `your invitation to <strong>${esc(opts.orgName)}</strong> on Conduit.</p>` +
      '<p>They now have access. You can manage roles and permissions from ' +
      'your team settings.</p>',
  );
  fireAndForget(log, 'invitation_accepted', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `${inviteeLabel} accepted your invite to ${opts.orgName}`,
      html,
    }),
  );
}

/**
 * MR2 — joined-org-welcome (ruby MR2 launch-blocker 2026-06-05).
 *
 * Welcomes the new member after they accept an invitation. Distinct
 * from the generic first-login welcome (which is org-agnostic) — this
 * one names the org they just joined and the role they hold.
 *
 * Scribe Voice 4 welcome-to-team register. COPY-PLACEHOLDER.
 */
export function sendJoinedOrgWelcomeEmail(
  log: FastifyBaseLogger,
  opts: { to: string; orgName: string; role: string; memberName?: string },
): void {
  const memberLabel = opts.memberName?.trim() || 'there';
  const html = layout(
    `<h2 style="margin:0 0 12px">Welcome to ${esc(opts.orgName)}</h2>` +
      `<p>Hi ${esc(memberLabel)} — you joined <strong>${esc(opts.orgName)}</strong> ` +
      `as a <strong>${esc(opts.role)}</strong>.</p>` +
      '<p>You can connect vendor accounts, access shared team credentials, ' +
      'and route MCP traffic through your team gateway from your Conduit ' +
      'dashboard.</p>',
  );
  fireAndForget(log, 'joined_org_welcome', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `Welcome to ${opts.orgName} on Conduit`,
      html,
    }),
  );
}

/**
 * SK1 — server-access-granted-member-notify (ruby SK1 launch-blocker
 * 2026-06-05). Notifies member that an admin granted them access to a
 * vendor — member previously discovered new access only by navigating
 * /settings (lower stakes than the revoke gap but consistency-application).
 *
 * Scribe Voice 4 capability-enabled register. COPY-PLACEHOLDER.
 */
export function sendServerAccessGrantedEmail(
  log: FastifyBaseLogger,
  opts: {
    to: string;
    orgName: string;
    vendorName: string;
    grantedByName?: string;
    memberName?: string;
  },
): void {
  const granterLabel = opts.grantedByName?.trim() || 'Your team admin';
  const memberLabel = opts.memberName?.trim() || 'there';
  const html = layout(
    `<h2 style="margin:0 0 12px">You have access to ${esc(opts.vendorName)}</h2>` +
      `<p>Hi ${esc(memberLabel)} — ${esc(granterLabel)} granted you access to ` +
      `<strong>${esc(opts.vendorName)}</strong> on <strong>${esc(opts.orgName)}</strong>.</p>` +
      '<p>You can now use this vendor in your MCP workflows. No further setup ' +
      'is needed — the team credential is shared with you.</p>',
  );
  fireAndForget(log, 'server_access_granted', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `Access to ${opts.vendorName} on ${opts.orgName}`,
      html,
    }),
  );
}

/**
 * SK2 — server-access-revoked-member-notify (ruby SK1 launch-blocker
 * 2026-06-05). Notifies member that an admin revoked their access to
 * a vendor — member previously discovered revocation only when their
 * AI agent started failing on next request (worst-discovery-moment for
 * capability-affecting consent event, per ruby's refined v4 clause).
 *
 * Scribe Voice 4 sad-but-respectful security-grade register.
 * COPY-PLACEHOLDER.
 */
export function sendServerAccessRevokedEmail(
  log: FastifyBaseLogger,
  opts: {
    to: string;
    orgName: string;
    vendorName: string;
    revokedByName?: string;
    memberName?: string;
  },
): void {
  const revokerLabel = opts.revokedByName?.trim() || 'Your team admin';
  const memberLabel = opts.memberName?.trim() || 'there';
  const html = layout(
    `<h2 style="margin:0 0 12px">Your access to ${esc(opts.vendorName)} was removed</h2>` +
      `<p>Hi ${esc(memberLabel)} — ${esc(revokerLabel)} removed your access to ` +
      `<strong>${esc(opts.vendorName)}</strong> on <strong>${esc(opts.orgName)}</strong>.</p>` +
      '<p>Your AI agents and integrations relying on this vendor will no longer ' +
      'be able to call it. If you believe this was a mistake, contact an admin ' +
      'of your organization. This is a security notice so the change is visible to you.</p>',
  );
  fireAndForget(log, 'server_access_revoked', opts.to, () =>
    sendTransactionalEmail(log, {
      to: opts.to,
      subject: `Your access to ${opts.vendorName} was removed`,
      html,
    }),
  );
}
