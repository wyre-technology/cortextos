import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  sendWelcomeEmail,
  sendInvitationEmail,
  sendMemberRemovedEmail,
  sendRoleChangedEmail,
} from './transactional.js';
import { sendTransactionalEmail } from './resend.js';

vi.mock('./resend.js', () => ({ sendTransactionalEmail: vi.fn() }));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

/** The single email argument the four send paths handed to the Resend client. */
function sentEmail() {
  expect(sendTransactionalEmail).toHaveBeenCalledOnce();
  return vi.mocked(sendTransactionalEmail).mock.calls[0][1];
}

/** Let the fire-and-forget send() promise settle before assertions. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendTransactionalEmail).mockResolvedValue();
});

describe('sendWelcomeEmail', () => {
  it('addresses the recipient and greets by name', () => {
    sendWelcomeEmail(log, { to: 'new@example.com', name: 'Dana' });
    const email = sentEmail();
    expect(email.to).toBe('new@example.com');
    expect(email.subject).toBe('Welcome to Conduit');
    expect(email.html).toContain('Dana');
  });

  it('omits the greeting when the name looks like an email address', () => {
    sendWelcomeEmail(log, { to: 'new@example.com', name: 'new@example.com' });
    expect(sentEmail().html).not.toContain('new@example.com,');
  });
});

describe('sendInvitationEmail', () => {
  it('includes the org name and invite link', () => {
    sendInvitationEmail(log, {
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviteUrl: 'https://mcp.wyre.ai/invite/tok123',
      invitedByEmail: 'admin@example.com',
    });
    const email = sentEmail();
    expect(email.to).toBe('invitee@example.com');
    expect(email.html).toContain('Acme');
    expect(email.html).toContain('https://mcp.wyre.ai/invite/tok123');
    expect(email.html).toContain('admin@example.com');
  });

  it('HTML-escapes an org name so it cannot inject markup', () => {
    sendInvitationEmail(log, {
      to: 'invitee@example.com',
      orgName: '<script>x</script>',
      inviteUrl: 'https://mcp.wyre.ai/invite/tok',
    });
    const html = sentEmail().html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('sendMemberRemovedEmail', () => {
  it('names the org the user was removed from', () => {
    sendMemberRemovedEmail(log, { to: 'gone@example.com', orgName: 'Acme' });
    const email = sentEmail();
    expect(email.to).toBe('gone@example.com');
    expect(email.html).toContain('Acme');
  });
});

describe('sendRoleChangedEmail', () => {
  it('names the org and the new role', () => {
    sendRoleChangedEmail(log, {
      to: 'member@example.com',
      orgName: 'Acme',
      newRole: 'admin',
    });
    const email = sentEmail();
    expect(email.html).toContain('Acme');
    expect(email.html).toContain('admin');
  });
});

describe('fire-and-forget contract', () => {
  it('never throws to the caller when the underlying send rejects', async () => {
    vi.mocked(sendTransactionalEmail).mockRejectedValueOnce(new Error('Resend down'));
    expect(() =>
      sendWelcomeEmail(log, { to: 'new@example.com', name: 'Dana' }),
    ).not.toThrow();
    await flush();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
