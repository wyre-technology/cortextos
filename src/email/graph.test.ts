import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    graphTenantId: 'tenant-123',
    graphClientId: 'client-abc',
    graphClientSecret: 'secret-xyz',
    founderWelcomeFrom: 'aaron@wyre.ai',
  },
}));

import { sendEmailViaGraph, __resetGraphTokenCache } from './graph.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetGraphTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendEmailViaGraph', () => {
  it('fetches a token then POSTs sendMail with an HTML message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailViaGraph({
      to: 'owner@example.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const tokenUrl = fetchMock.mock.calls[0][0] as string;
    expect(tokenUrl).toContain('login.microsoftonline.com/tenant-123');

    const sendUrl = fetchMock.mock.calls[1][0] as string;
    expect(sendUrl).toBe(
      'https://graph.microsoft.com/v1.0/users/aaron%40wyre.ai/sendMail',
    );
    const sendInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(sendInit.headers).toMatchObject({ Authorization: 'Bearer tok-1' });
    const payload = JSON.parse(sendInit.body as string);
    expect(payload).toMatchObject({
      message: {
        subject: 'Welcome',
        body: { contentType: 'HTML', content: '<p>hi</p>' },
        toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
      },
      saveToSentItems: true,
    });
  });

  it('reuses the cached token across sends', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailViaGraph({ to: 'a@example.com', subject: 's', html: 'h' });
    await sendEmailViaGraph({ to: 'b@example.com', subject: 's', html: 'h' });

    // 1 token fetch + 2 sendMail calls — token is fetched only once.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when sendMail returns a non-2xx status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendEmailViaGraph({ to: 'a@example.com', subject: 's', html: 'h' }),
    ).rejects.toThrow(/sendMail failed: 400/);
  });

  it('throws when the token request fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendEmailViaGraph({ to: 'a@example.com', subject: 's', html: 'h' }),
    ).rejects.toThrow(/token request failed: 401/);
    // Only the token fetch was attempted — no sendMail call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
