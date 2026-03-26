import type { LogShippingAdapter, ShippableEvent, LogShippingDestination } from './types.js';

// CrowdStrike Falcon LogScale (formerly Humio) structured ingest adapter
// Docs: https://library.humio.com/falcon-logscale/api-ingest.html#api-ingest-structured-data
export class LogScaleAdapter implements LogShippingAdapter {
  readonly platform = 'logscale' as const;

  async ship(events: ShippableEvent[], dest: LogShippingDestination): Promise<void> {
    if (events.length === 0) return;

    // Group events by source
    const sourceMap = new Map<string, { timestamp: string; attributes: Record<string, unknown> }[]>();

    for (const event of events) {
      if (!sourceMap.has(event.source)) {
        sourceMap.set(event.source, []);
      }
      sourceMap.get(event.source)!.push({
        timestamp: event.createdAt,
        attributes: { org_id: dest.orgId, ...event.payload },
      });
    }

    const body = Array.from(sourceMap.entries()).map(([source, evts]) => ({
      tags: { host: 'mcp-gateway', source },
      events: evts,
    }));

    let url = `${dest.endpointUrl.replace(/\/$/, '')}/api/v1/ingest/humio-structured`;
    if (dest.config.repository) {
      url = `${dest.endpointUrl.replace(/\/$/, '')}/${dest.config.repository}/api/v1/ingest/humio-structured`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dest.config.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LogScale push failed: ${res.status} ${text}`);
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
