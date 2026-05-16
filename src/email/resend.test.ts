import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { sendTransactionalEmail } from './resend.js';
import { config } from '../config.js';

// Mutable config mock — tests flip `resendApiKey` to exercise the
// configured / not-configured branches.
vi.mock('../config.js', () => ({
  config: { resendApiKey: '', emailFrom: 'Conduit <test@conduit.wyre.ai>' },
}));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch');
  vi.clearAllMocks();
  config.resendApiKey = '';
});

describe('sendTransactionalEmail', () => {
  it('is a logged no-op when RESEND_API_KEY is unset', async () => {
    await sendTransactionalEmail(log, {
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('does nothing when the recipient address is empty', async () => {
    config.resendApiKey = 'a'.repeat(64);
    await sendTransactionalEmail(log, { to: '', subject: 'Hi', html: '<p>Hi</p>' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Resend API when configured', async () => {
    config.resendApiKey = 'a'.repeat(64);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await sendTransactionalEmail(log, {
      to: 'user@example.com',
      subject: 'Welcome',
      html: '<p>Welcome</p>',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${'a'.repeat(64)}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'Conduit <test@conduit.wyre.ai>',
      to: 'user@example.com',
      subject: 'Welcome',
      html: '<p>Welcome</p>',
    });
  });

  it('throws when the Resend API returns a non-OK status', async () => {
    config.resendApiKey = 'a'.repeat(64);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 422 } as Response);

    await expect(
      sendTransactionalEmail(log, { to: 'user@example.com', subject: 'X', html: 'x' }),
    ).rejects.toThrow('Resend send failed: 422');
  });
});
