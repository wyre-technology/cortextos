import type { LogShippingService } from './log-shipping-service.js';
import type { LogShippingAdapter } from './adapters/types.js';
import { runAsSystem } from '../db/context.js';

const SOURCES = ['request_log', 'admin_audit_log'] as const;

export class LogShipper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private service: LogShippingService,
    private adapters: Map<string, LogShippingAdapter>,
    private logger: { warn: (obj: unknown, msg: string) => void },
  ) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    this.timer.unref(); // Don't hold the process open
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    // The shipper runs on a timer with no request context — it is a
    // system-path background job. runAsSystem establishes the system DB
    // context so getSql() inside the service resolves; the context
    // propagates into the shipDestination() calls below.
    await runAsSystem(async () => {
      const destinations = await this.service.listEnabled().catch((err) => {
        this.logger.warn({ err }, 'log-shipper: failed to list destinations');
        return [];
      });

      if (destinations.length === 0) return;

      await Promise.allSettled(
        destinations.map((dest) => this.shipDestination(dest.id, dest.orgId, dest.platform)),
      );
    });
  }

  private async shipDestination(
    destId: string,
    orgId: string,
    platform: string,
  ): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      this.logger.warn({ platform }, 'log-shipper: no adapter for platform');
      return;
    }

    // Fetch the full destination object (needed by adapter)
    const dest = await this.service.get(destId);
    if (!dest) return;

    await Promise.allSettled(
      SOURCES.map(async (source) => {
        try {
          const cursor = await this.service.getCursor(destId, source);
          const events =
            source === 'request_log'
              ? await this.service.fetchRequestLogBatch(orgId, cursor)
              : await this.service.fetchAdminAuditLogBatch(orgId, cursor);

          if (events.length === 0) return;

          await adapter.ship(events, dest);

          const latest = new Date(events[events.length - 1].createdAt);
          await this.service.advanceCursor(destId, source, latest);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err, destId, source }, 'log-shipper: ship failed');
          await this.service.recordError(destId, source, msg).catch(() => undefined);
        }
      }),
    );
  }
}
