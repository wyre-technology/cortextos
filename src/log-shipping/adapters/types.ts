// ---------------------------------------------------------------------------
// Shared types for log shipping adapters
// ---------------------------------------------------------------------------

export type Platform = 'loki' | 'graylog' | 'logscale';
export type LogSource = 'request_log' | 'admin_audit_log';

export interface ShippableEvent {
  id: string;
  createdAt: string; // ISO timestamp
  source: LogSource;
  payload: Record<string, unknown>;
}

export interface LogShippingDestination {
  id: string;
  orgId: string;
  label: string;
  platform: Platform;
  endpointUrl: string;
  config: Record<string, string>; // credentials: token, username, etc.
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LogShippingAdapter {
  readonly platform: Platform;
  ship(events: ShippableEvent[], dest: LogShippingDestination): Promise<void>;
  test(dest: LogShippingDestination): Promise<{ ok: true }>; // throws on failure
}
