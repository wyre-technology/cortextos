import { getVendorSlugs, getVendor } from '../credentials/vendor-config.js';
import { config } from '../config.js';
import { sendWebhook } from './webhook.js';
import { sendRootlyAlert, type RootlyVendorAlert } from './rootly.js';

export interface VendorStatus {
  slug: string;
  status: 'up' | 'down' | 'unknown';
  version: string | null;
  responseMs: number;
  lastChecked: Date;
  lastStateChange: Date;
  consecutiveFailures: number;
  lastError: string | null;
}

const FAILURE_THRESHOLD = 3;

/**
 * Latency above which an otherwise-up vendor is reported `degraded` rather
 * than `healthy`. Tunable; the probe itself times out at 10s.
 */
export const DEGRADED_LATENCY_MS = 2000;

/** Tenant-facing 4-state health derived from the raw monitor status. */
export type VendorHealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * Map a raw monitor {@link VendorStatus} to the tenant-facing 4-state model.
 *
 *   down     — the monitor has declared the vendor down (>= 3 failures)
 *   degraded — responding, but slow (latency over threshold) OR carrying
 *              1-2 consecutive failures (below the hard down threshold)
 *   healthy  — up, fast, no recent failures
 *   unknown  — not yet probed
 */
export function deriveVendorHealth(
  s: Pick<VendorStatus, 'status' | 'consecutiveFailures' | 'responseMs'>,
): VendorHealthState {
  if (s.status === 'down') return 'down';
  if (s.status === 'unknown') return 'unknown';
  if (s.consecutiveFailures > 0 || s.responseMs > DEGRADED_LATENCY_MS) return 'degraded';
  return 'healthy';
}

/**
 * Bound a raw monitor `lastError` to a controlled, tenant-safe string.
 *
 * The monitor's `lastError` is either `HTTP <status>` (from a non-OK probe
 * response) or a raw exception message from the probe's catch block — which
 * can carry arbitrary internal detail. This function is default-deny: it
 * allowlists the `HTTP NNN` shape and collapses it to a status class; every
 * other shape maps to a single generic string. An unanticipated error shape
 * therefore cannot leak to a tenant.
 */
export function summarizeProbeError(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^HTTP (\d)\d{2}$/.exec(raw);
  if (m) return `HTTP ${m[1]}xx`;
  return 'connection failed';
}

export class VendorMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state = new Map<string, VendorStatus>();

  constructor(
    private logger: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
  ) {}

  start(intervalMs = config.monitorIntervalMs): void {
    // Run first probe immediately, then on interval
    void this.probeAll();
    this.timer = setInterval(() => {
      void this.probeAll();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): Record<string, Omit<VendorStatus, 'slug'>> {
    const result: Record<string, Omit<VendorStatus, 'slug'>> = {};
    for (const [slug, s] of this.state) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { slug: _slug, ...rest } = s;
      result[slug] = rest;
    }
    return result;
  }

  async probeAll(): Promise<void> {
    const slugs = getVendorSlugs();
    await Promise.allSettled(slugs.map((slug) => this.probeVendor(slug)));
  }

  private async probeVendor(slug: string): Promise<void> {
    const vendor = getVendor(slug);
    if (!vendor) return;

    const mcpPath = vendor.mcpPath ?? '/mcp';
    const url = `${vendor.containerUrl.replace(/\/+$/, '')}${mcpPath}`;

    const now = new Date();
    const prev = this.state.get(slug);
    const start = Date.now();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway-monitor', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const elapsed = Date.now() - start;

      if (!res.ok) {
        this.recordFailure(slug, `HTTP ${res.status}`, elapsed, now, prev);
        return;
      }

      // Parse version from response
      let version: string | null = null;
      try {
        const body = await res.json() as { result?: { serverInfo?: { version?: string } } };
        version = body?.result?.serverInfo?.version ?? null;
      } catch {
        // Non-JSON or SSE response — still counts as up if HTTP 200
      }

      const wasDown = prev?.status === 'down';
      const stateChange = wasDown || !prev ? now : prev.lastStateChange;

      this.state.set(slug, {
        slug,
        status: 'up',
        version,
        responseMs: elapsed,
        lastChecked: now,
        lastStateChange: stateChange,
        consecutiveFailures: 0,
        lastError: null,
      });

      if (wasDown) {
        const downDuration = formatDuration(now.getTime() - prev.lastStateChange.getTime());
        const versionStr = version ? ` (v${version})` : '';
        this.logger.info({ slug, version }, `vendor-monitor: ${slug} recovered`);
        void this.alert(`🟢 Vendor RECOVERED: ${slug} — back up after ${downDuration}${versionStr}`);
        this.pageRootly({
          vendorSlug: slug,
          status: 'resolved',
          summary: `Vendor MCP container recovered: ${slug} — back up after ${downDuration}`,
        });
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(slug, msg, elapsed, now, prev);
    }
  }

  private recordFailure(
    slug: string,
    error: string,
    responseMs: number,
    now: Date,
    prev: VendorStatus | undefined,
  ): void {
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const justCrossedThreshold = failures === FAILURE_THRESHOLD;

    this.state.set(slug, {
      slug,
      status: failures >= FAILURE_THRESHOLD ? 'down' : (prev?.status ?? 'unknown'),
      version: prev?.version ?? null,
      responseMs,
      lastChecked: now,
      lastStateChange: justCrossedThreshold ? now : (prev?.lastStateChange ?? now),
      consecutiveFailures: failures,
      lastError: error,
    });

    if (justCrossedThreshold) {
      this.logger.warn({ slug, error, failures }, `vendor-monitor: ${slug} is DOWN`);
      void this.alert(`🔴 Vendor DOWN: ${slug} — ${error} after ${FAILURE_THRESHOLD} consecutive failures`);
      this.pageRootly({
        vendorSlug: slug,
        status: 'firing',
        summary: `Vendor MCP container DOWN: ${slug} — ${FAILURE_THRESHOLD} consecutive failed probes`,
        consecutiveFailures: failures,
        lastError: error,
      });
    }
  }

  /**
   * Page Rootly for a vendor health transition — fire-and-forget. A failed
   * page is logged and never thrown: paging must not disrupt the probe loop.
   * Fires only on the down / recovered transitions (once per episode), so it
   * does not stack alerts while a vendor stays down.
   */
  private pageRootly(alert: RootlyVendorAlert): void {
    sendRootlyAlert(this.logger, alert).catch((err) =>
      this.logger.warn({ err, slug: alert.vendorSlug }, 'vendor-monitor: Rootly page failed'),
    );
  }

  private async alert(text: string): Promise<void> {
    const webhookUrl = config.monitorWebhookUrl;
    if (!webhookUrl) return;
    try {
      await sendWebhook(webhookUrl, { text });
    } catch (err) {
      this.logger.warn({ err }, 'vendor-monitor: webhook send failed');
    }
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
