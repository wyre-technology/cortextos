import type { LogShippingAdapter, ShippableEvent, LogShippingDestination } from './types.js';

// Graylog GELF HTTP adapter
// Docs: https://go2docs.graylog.org/current/getting_in_log_data/gelf.html
export class GraylogAdapter implements LogShippingAdapter {
  readonly platform = 'graylog' as const;

  async ship(events: ShippableEvent[], dest: LogShippingDestination): Promise<void> {
    const url = `${dest.endpointUrl.replace(/\/$/, '')}/gelf`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (dest.config.token) {
      headers['Authorization'] = `Bearer ${dest.config.token}`;
    }

    // Sequential POSTs — one GELF message per event
    for (const event of events) {
      const gelf: Record<string, unknown> = {
        version: '1.1',
        host: 'mcp-gateway',
        short_message: `${event.source} event`,
        timestamp: Date.parse(event.createdAt) / 1000,
        level: 6, // informational
        _org_id: dest.orgId,
        _source: event.source,
      };
      // Flatten payload as GELF additional fields (_prefixed)
      for (const [k, v] of Object.entries(event.payload)) {
        gelf[`_${k}`] = v;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(gelf),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Graylog push failed: ${res.status} ${text}`);
      }
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
