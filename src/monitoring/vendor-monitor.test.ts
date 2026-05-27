import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VendorMonitor,
  deriveVendorHealth,
  summarizeProbeError,
  assembleOrgVendorHealth,
  DEGRADED_LATENCY_MS,
  type VendorStatus,
} from './vendor-monitor.js';

// Mock config before importing
vi.mock('../config.js', () => ({
  config: {
    monitorWebhookUrl: '',
    monitorIntervalMs: 60_000,
  },
}));

// Mock vendor-config to control which vendors are probed
vi.mock('../credentials/vendor-config.js', () => ({
  getVendorSlugs: () => ['test-vendor'],
  getVendor: (slug: string) =>
    slug === 'test-vendor'
      ? { name: 'Test', slug: 'test-vendor', containerUrl: 'http://test:8080' }
      : undefined,
}));

// Mock webhook
vi.mock('./webhook.js', () => ({
  sendWebhook: vi.fn(),
}));

// Mock Rootly paging
vi.mock('./rootly.js', () => ({
  sendRootlyAlert: vi.fn().mockResolvedValue(undefined),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function mockSuccessResponse(version = '1.0.0') {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      result: { serverInfo: { version } },
    }),
  } as Response);
}

function mockFailureResponse(status = 500) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status,
  } as Response);
}

function mockNetworkError() {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
}

describe('VendorMonitor', () => {
  let monitor: VendorMonitor;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch');
    monitor = new VendorMonitor(mockLogger);
    vi.clearAllMocks();
    // afterEach's restoreAllMocks() strips the factory vi.fn()'s
    // implementation — re-establish it so sendRootlyAlert resolves a promise
    // (the monitor does sendRootlyAlert(...).catch(...)).
    const { sendRootlyAlert } = await import('./rootly.js');
    vi.mocked(sendRootlyAlert).mockResolvedValue(undefined);
  });

  afterEach(() => {
    monitor.stop();
    vi.restoreAllMocks();
  });

  it('probes vendors and records UP status with version', async () => {
    mockSuccessResponse('2.1.0');

    await monitor.probeAll();

    const status = monitor.getStatus();
    expect(status['test-vendor']).toBeDefined();
    expect(status['test-vendor'].status).toBe('up');
    expect(status['test-vendor'].version).toBe('2.1.0');
    expect(status['test-vendor'].consecutiveFailures).toBe(0);
  });

  it('sends correct MCP initialize request', async () => {
    mockSuccessResponse();
    await monitor.probeAll();

    expect(fetch).toHaveBeenCalledWith(
      'http://test:8080/mcp',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"method":"initialize"'),
      }),
    );
  });

  it('tracks consecutive failures but stays unknown before threshold', async () => {
    mockFailureResponse(500);
    await monitor.probeAll();

    const status = monitor.getStatus();
    expect(status['test-vendor'].consecutiveFailures).toBe(1);
    expect(status['test-vendor'].status).toBe('unknown');
    expect(status['test-vendor'].lastError).toBe('HTTP 500');
  });

  it('marks vendor as DOWN after 3 consecutive failures', async () => {
    for (let i = 0; i < 3; i++) {
      mockNetworkError();
      await monitor.probeAll();
    }

    const status = monitor.getStatus();
    expect(status['test-vendor'].status).toBe('down');
    expect(status['test-vendor'].consecutiveFailures).toBe(3);
  });

  it('records REACHABLE (not down) when the auth-gated probe returns 401', async () => {
    mockFailureResponse(401);
    await monitor.probeAll();

    const status = monitor.getStatus();
    expect(status['test-vendor'].status).toBe('reachable');
    expect(status['test-vendor'].consecutiveFailures).toBe(0);
    expect(status['test-vendor'].lastError).toBeNull();
  });

  it('a 403 auth-gated probe is also reachable; repeated 401s never go down', async () => {
    mockFailureResponse(403);
    await monitor.probeAll();
    expect(monitor.getStatus()['test-vendor'].status).toBe('reachable');

    // The container keeps answering 401 to the credless probe — it must stay
    // reachable, never crossing the down threshold (it is alive, not failing).
    for (let i = 0; i < 3; i++) {
      mockFailureResponse(401);
      await monitor.probeAll();
    }
    expect(monitor.getStatus()['test-vendor'].status).toBe('reachable');
    expect(monitor.getStatus()['test-vendor'].consecutiveFailures).toBe(0);
  });

  it('keeps 5xx and network errors on the down path (not reachable)', async () => {
    for (let i = 0; i < 3; i++) {
      mockFailureResponse(500);
      await monitor.probeAll();
    }
    expect(monitor.getStatus()['test-vendor'].status).toBe('down');
  });

  it('sends DOWN webhook only at threshold (not before, not after)', async () => {
    const { sendWebhook } = await import('./webhook.js');
    const { config } = await import('../config.js');
    (config as Record<string, unknown>).monitorWebhookUrl = 'https://hooks.test/alert';

    // Failures 1 and 2: no webhook
    mockNetworkError();
    await monitor.probeAll();
    expect(sendWebhook).not.toHaveBeenCalled();

    mockNetworkError();
    await monitor.probeAll();
    expect(sendWebhook).not.toHaveBeenCalled();

    // Failure 3: DOWN webhook fires
    mockNetworkError();
    await monitor.probeAll();
    expect(sendWebhook).toHaveBeenCalledWith(
      'https://hooks.test/alert',
      expect.objectContaining({ text: expect.stringContaining('DOWN') }),
    );

    vi.mocked(sendWebhook).mockClear();

    // Failure 4: no additional webhook
    mockNetworkError();
    await monitor.probeAll();
    expect(sendWebhook).not.toHaveBeenCalled();

    (config as Record<string, unknown>).monitorWebhookUrl = '';
  });

  it('sends RECOVERED webhook on first success after DOWN', async () => {
    const { sendWebhook } = await import('./webhook.js');
    const { config } = await import('../config.js');
    (config as Record<string, unknown>).monitorWebhookUrl = 'https://hooks.test/alert';

    // Drive to DOWN
    for (let i = 0; i < 3; i++) {
      mockNetworkError();
      await monitor.probeAll();
    }
    vi.mocked(sendWebhook).mockClear();

    // Recover
    mockSuccessResponse('1.2.3');
    await monitor.probeAll();

    expect(sendWebhook).toHaveBeenCalledWith(
      'https://hooks.test/alert',
      expect.objectContaining({ text: expect.stringContaining('RECOVERED') }),
    );
    expect(monitor.getStatus()['test-vendor'].status).toBe('up');
    expect(monitor.getStatus()['test-vendor'].consecutiveFailures).toBe(0);

    (config as Record<string, unknown>).monitorWebhookUrl = '';
  });

  it('pages Rootly firing only at the down threshold (not before, not after)', async () => {
    const { sendRootlyAlert } = await import('./rootly.js');

    // Failures 1 and 2: no page
    mockNetworkError();
    await monitor.probeAll();
    mockNetworkError();
    await monitor.probeAll();
    expect(sendRootlyAlert).not.toHaveBeenCalled();

    // Failure 3: firing page
    mockNetworkError();
    await monitor.probeAll();
    expect(sendRootlyAlert).toHaveBeenCalledOnce();
    expect(vi.mocked(sendRootlyAlert).mock.calls[0][1]).toMatchObject({
      vendorSlug: 'test-vendor',
      status: 'firing',
      consecutiveFailures: 3,
    });

    vi.mocked(sendRootlyAlert).mockClear();

    // Failure 4: no additional page — once per episode
    mockNetworkError();
    await monitor.probeAll();
    expect(sendRootlyAlert).not.toHaveBeenCalled();
  });

  it('pages Rootly resolved on the recovery transition', async () => {
    const { sendRootlyAlert } = await import('./rootly.js');

    // Drive to DOWN
    for (let i = 0; i < 3; i++) {
      mockNetworkError();
      await monitor.probeAll();
    }
    vi.mocked(sendRootlyAlert).mockClear();

    // Recover
    mockSuccessResponse('1.2.3');
    await monitor.probeAll();

    expect(sendRootlyAlert).toHaveBeenCalledOnce();
    expect(vi.mocked(sendRootlyAlert).mock.calls[0][1]).toMatchObject({
      vendorSlug: 'test-vendor',
      status: 'resolved',
    });
  });

  it('resets consecutive failures on success', async () => {
    mockFailureResponse();
    await monitor.probeAll();
    expect(monitor.getStatus()['test-vendor'].consecutiveFailures).toBe(1);

    mockSuccessResponse();
    await monitor.probeAll();
    expect(monitor.getStatus()['test-vendor'].consecutiveFailures).toBe(0);
  });

  it('does not send webhooks when MONITOR_WEBHOOK_URL is empty', async () => {
    const { sendWebhook } = await import('./webhook.js');

    for (let i = 0; i < 3; i++) {
      mockNetworkError();
      await monitor.probeAll();
    }

    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('getStatus returns empty object before first probe', () => {
    expect(monitor.getStatus()).toEqual({});
  });

  it('handles non-JSON response body gracefully (still counts as up)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response);

    await monitor.probeAll();
    expect(monitor.getStatus()['test-vendor'].status).toBe('up');
    expect(monitor.getStatus()['test-vendor'].version).toBeNull();
  });
});

describe('deriveVendorHealth', () => {
  it('maps a fast, failure-free up vendor to healthy', () => {
    expect(deriveVendorHealth({ status: 'up', consecutiveFailures: 0, responseMs: 100 }))
      .toBe('healthy');
  });

  it('maps down to down regardless of latency', () => {
    expect(deriveVendorHealth({ status: 'down', consecutiveFailures: 5, responseMs: 50 }))
      .toBe('down');
  });

  it('maps a reachable (auth-gated) vendor to reachable, not healthy or down', () => {
    expect(deriveVendorHealth({ status: 'reachable', consecutiveFailures: 0, responseMs: 120 }))
      .toBe('reachable');
  });

  it('maps an unprobed vendor to unknown', () => {
    expect(deriveVendorHealth({ status: 'unknown', consecutiveFailures: 0, responseMs: 0 }))
      .toBe('unknown');
  });

  it('maps up-but-slow (latency over threshold) to degraded', () => {
    expect(deriveVendorHealth({
      status: 'up',
      consecutiveFailures: 0,
      responseMs: DEGRADED_LATENCY_MS + 1,
    })).toBe('degraded');
  });

  it('maps up-with-1-2-failures (below the down threshold) to degraded', () => {
    expect(deriveVendorHealth({ status: 'up', consecutiveFailures: 2, responseMs: 100 }))
      .toBe('degraded');
  });
});

describe('summarizeProbeError', () => {
  it('returns null for a null input', () => {
    expect(summarizeProbeError(null)).toBeNull();
  });

  it('collapses an HTTP status to its class', () => {
    expect(summarizeProbeError('HTTP 503')).toBe('HTTP 5xx');
    expect(summarizeProbeError('HTTP 404')).toBe('HTTP 4xx');
  });

  it('maps any non-HTTP error shape to the generic string (default-deny)', () => {
    expect(summarizeProbeError('connect ECONNREFUSED 10.0.3.7:8080')).toBe('connection failed');
    expect(summarizeProbeError('The operation timed out')).toBe('connection failed');
    expect(summarizeProbeError('getaddrinfo ENOTFOUND datto-rmm-mcp')).toBe('connection failed');
  });

  it('does not pass through a string that merely contains "HTTP NNN"', () => {
    // The allowlist is anchored — a crafted message embedding the pattern
    // must not slip past as if it were a clean status.
    expect(summarizeProbeError('Error: HTTP 500 from http://internal-host:8080'))
      .toBe('connection failed');
  });
});

describe('assembleOrgVendorHealth', () => {
  type CacheEntry = Omit<VendorStatus, 'slug'>;
  const entry = (over: Partial<CacheEntry>): CacheEntry => ({
    status: 'up',
    version: '1.0.0',
    responseMs: 100,
    lastChecked: new Date('2026-05-16T12:00:00Z'),
    lastStateChange: new Date('2026-05-16T11:00:00Z'),
    consecutiveFailures: 0,
    lastError: null,
    ...over,
  });

  it('returns one entry per requested slug, in order', () => {
    const out = assembleOrgVendorHealth(['datto-rmm'], { 'datto-rmm': entry({}) });
    expect(out).toHaveLength(1);
    expect(out[0].vendorSlug).toBe('datto-rmm');
    expect(out[0].displayName).toBeTruthy(); // getVendor(slug)?.name ?? slug
    expect(out[0].status).toBe('healthy');
  });

  it('org-scopes: a global-cache vendor NOT in the slug list is never returned', () => {
    const cache = {
      'datto-rmm': entry({}),
      'some-other-org-vendor': entry({ status: 'down', consecutiveFailures: 5 }),
    };
    const out = assembleOrgVendorHealth(['datto-rmm'], cache);
    expect(out.map((v) => v.vendorSlug)).toEqual(['datto-rmm']);
  });

  it('maps a slug with no cache entry to unknown + null lastChecked', () => {
    const out = assembleOrgVendorHealth(['datto-rmm'], {});
    expect(out[0].status).toBe('unknown');
    expect(out[0].lastChecked).toBeNull();
    expect(out[0].errorDetail).toBeNull();
  });

  it('populates errorDetail only for degraded/down, bounded', () => {
    const cache = {
      'datto-rmm': entry({ status: 'down', consecutiveFailures: 4, lastError: 'HTTP 503' }),
    };
    const out = assembleOrgVendorHealth(['datto-rmm'], cache);
    expect(out[0].status).toBe('down');
    expect(out[0].errorDetail).toBe('HTTP 5xx');
  });

  it('leaves errorDetail null for a healthy vendor even if lastError lingers', () => {
    const cache = {
      'datto-rmm': entry({ status: 'up', consecutiveFailures: 0, lastError: 'HTTP 500' }),
    };
    const out = assembleOrgVendorHealth(['datto-rmm'], cache);
    expect(out[0].status).toBe('healthy');
    expect(out[0].errorDetail).toBeNull();
  });

  it('falls back to the slug as displayName for an unknown vendor', () => {
    const out = assembleOrgVendorHealth(['not-a-real-vendor'], {});
    expect(out[0].displayName).toBe('not-a-real-vendor');
  });
});
