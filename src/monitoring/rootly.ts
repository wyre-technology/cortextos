/**
 * Rootly alerting — pages on-call when a vendor MCP container goes unhealthy.
 *
 * The VendorMonitor calls this on two transitions: `firing` when a vendor
 * crosses the down threshold (3 consecutive failed probes), and `resolved`
 * when it recovers. The shared `dedup_key` lets Rootly pair the two so the
 * alert auto-closes on recovery rather than being hand-closed.
 *
 * Gated on ROOTLY_WEBHOOK_URL exactly as the Slack monitor alert is gated on
 * MONITOR_WEBHOOK_URL: when the URL is unset the send is a logged no-op, so a
 * dev / CI / not-yet-provisioned environment boots without paging. Throws on
 * an API-level failure — the caller (fire-and-forget in the monitor) logs it.
 */
import { config } from '../config.js';

const ROOTLY_TIMEOUT_MS = 5000;

/** Minimal logger shape — the monitor's logger satisfies this. */
interface AlertLogger {
  info: (obj: unknown, msg: string) => void;
}

export interface RootlyVendorAlert {
  /** The vendor whose container changed state. */
  vendorSlug: string;
  /** `firing` on the down transition, `resolved` on recovery. */
  status: 'firing' | 'resolved';
  /** Human-readable one-line summary for the Rootly alert title. */
  summary: string;
  /** Consecutive failed probes — included on `firing` for triage. */
  consecutiveFailures?: number;
  /** Last probe error — included on `firing` for triage. Internal page, so
   *  the raw monitor error is acceptable here (unlike the tenant endpoint). */
  lastError?: string | null;
}

/**
 * Emit one Rootly alert for a vendor health transition. No-op (with a log
 * line) when ROOTLY_WEBHOOK_URL is unset. Throws on an API-level failure.
 */
export async function sendRootlyAlert(
  log: AlertLogger,
  alert: RootlyVendorAlert,
): Promise<void> {
  if (!config.rootlyWebhookUrl) {
    log.info(
      { vendorSlug: alert.vendorSlug, status: alert.status },
      'Rootly not configured (ROOTLY_WEBHOOK_URL unset) — vendor page skipped',
    );
    return;
  }

  const res = await fetch(config.rootlyWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: alert.summary,
      status: alert.status,
      severity: 'high',
      // Distinguishes this producer from Azure Monitor on the shared source.
      source: 'conduit-vendor-monitor',
      // Stable per vendor so a firing and its resolved pair up — and a
      // re-fire of the same vendor does not stack a second open alert.
      dedup_key: `vendor-health:${alert.vendorSlug}`,
      details: {
        vendor: alert.vendorSlug,
        consecutiveFailures: alert.consecutiveFailures,
        lastError: alert.lastError ?? undefined,
      },
    }),
    signal: AbortSignal.timeout(ROOTLY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Rootly alert failed: ${res.status}`);
  }
}
