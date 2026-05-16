import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendRootlyAlert } from './rootly.js';
import { config } from '../config.js';

// Mutable config mock — tests flip rootlyWebhookUrl to exercise the
// configured / not-configured branches.
vi.mock('../config.js', () => ({
  config: { rootlyWebhookUrl: '' },
}));

const log = { info: vi.fn() };

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch');
  vi.clearAllMocks();
  config.rootlyWebhookUrl = '';
});

describe('sendRootlyAlert', () => {
  it('is a logged no-op when ROOTLY_WEBHOOK_URL is unset', async () => {
    await sendRootlyAlert(log, {
      vendorSlug: 'datto-rmm',
      status: 'firing',
      summary: 'down',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('POSTs a generic-webhook payload when configured', async () => {
    config.rootlyWebhookUrl = 'https://rootly.test/webhooks/abc';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await sendRootlyAlert(log, {
      vendorSlug: 'datto-rmm',
      status: 'firing',
      summary: 'Vendor MCP container DOWN: datto-rmm',
      consecutiveFailures: 3,
      lastError: 'HTTP 503',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://rootly.test/webhooks/abc');
    const body = JSON.parse(init?.body as string);
    expect(body.status).toBe('firing');
    expect(body.severity).toBe('high');
    expect(body.source).toBe('conduit-vendor-monitor');
    // dedup_key is stable per vendor so firing/resolved pair up.
    expect(body.dedup_key).toBe('vendor-health:datto-rmm');
    expect(body.details).toEqual({
      vendor: 'datto-rmm',
      consecutiveFailures: 3,
      lastError: 'HTTP 503',
    });
  });

  it('uses the same dedup_key for the resolved event so Rootly auto-closes', async () => {
    config.rootlyWebhookUrl = 'https://rootly.test/webhooks/abc';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await sendRootlyAlert(log, {
      vendorSlug: 'datto-rmm',
      status: 'resolved',
      summary: 'recovered',
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.status).toBe('resolved');
    expect(body.dedup_key).toBe('vendor-health:datto-rmm');
  });

  it('throws when the Rootly webhook returns a non-OK status', async () => {
    config.rootlyWebhookUrl = 'https://rootly.test/webhooks/abc';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    await expect(
      sendRootlyAlert(log, { vendorSlug: 'x', status: 'firing', summary: 's' }),
    ).rejects.toThrow('Rootly alert failed: 500');
  });
});
