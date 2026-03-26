import type { LogShippingAdapter, ShippableEvent, LogShippingDestination } from './types.js';

// Grafana Loki HTTP push adapter
// Docs: https://grafana.com/docs/loki/latest/api/#push-log-entries-to-loki
export class LokiAdapter implements LogShippingAdapter {
  readonly platform = 'loki' as const;

  async ship(events: ShippableEvent[], dest: LogShippingDestination): Promise<void> {
    if (events.length === 0) return;

    // Group events by source into separate streams
    const streamMap = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();

    for (const event of events) {
      const key = event.source;
      if (!streamMap.has(key)) {
        streamMap.set(key, {
          stream: {
            org_id: dest.orgId,
            source: event.source,
            platform: 'mcp-gateway',
          },
          values: [],
        });
      }
      // Nanosecond timestamp as string
      const tsNs = (BigInt(Date.parse(event.createdAt)) * 1_000_000n).toString();
      streamMap.get(key)!.values.push([tsNs, JSON.stringify(event.payload)]);
    }

    const body = JSON.stringify({ streams: Array.from(streamMap.values()) });
    const headers = buildAuthHeaders(dest.config);
    headers['Content-Type'] = 'application/json';

    const url = `${dest.endpointUrl.replace(/\/$/, '')}/loki/api/v1/push`;
    const res = await fetch(url, { method: 'POST', headers, body });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Loki push failed: ${res.status} ${text}`);
    }
  }

  async test(dest: LogShippingDestination): Promise<{ ok: true }> {
    await this.ship(
      [
        {
          id: 'test',
          createdAt: new Date().toISOString(),
          source: 'request_log',
          payload: { message: 'MCP Gateway log shipping test', org_id: dest.orgId },
        },
      ],
      dest,
    );
    return { ok: true };
  }
}

function buildAuthHeaders(cfg: Record<string, string>): Record<string, string> {
  if (cfg.username && cfg.token) {
    const creds = Buffer.from(`${cfg.username}:${cfg.token}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }
  if (cfg.token) {
    return { Authorization: `Bearer ${cfg.token}` };
  }
  return {};
}
