/**
 * Gateway-level MCP tool result cache.
 *
 * Sits between the proxy router and the upstream vendor containers. For
 * read tools, it returns cached JSON-RPC responses to avoid hammering
 * vendor APIs (especially Autotask's 3-concurrent-thread limit).
 *
 * Key design decisions:
 *
 * 1. Tenant-scoped keys: org credentials scope to orgId; personal credentials
 *    scope to userId. Users within the same org share a cache because they hit
 *    the same vendor instance with the same API key.
 *
 * 2. Entity-type generations: each writable entity type (tickets, companies…)
 *    has a generation counter. Write tools increment the counter; read tool
 *    cache keys include the current generation. Old entries become unreachable
 *    and expire naturally — no expensive key scans needed.
 *
 * 3. In-flight deduplication: concurrent identical read requests share a single
 *    upstream fetch (same pattern as ToolCache).
 *
 * 4. Redis-ready interface: CacheStore is a simple get/set/incr/del interface.
 *    Swap InMemoryCacheStore for RedisCacheStore when horizontal scaling
 *    requires a shared cache.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Cache store interface — swap implementation for Redis without changing logic
// ---------------------------------------------------------------------------

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  incr(key: string): Promise<number>;
}

export class InMemoryCacheStore implements CacheStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  private counters = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Tool classification config
// ---------------------------------------------------------------------------

export type EntityType = 'tickets' | 'companies' | 'contacts' | 'resources' | 'picklists' | 'documents' | 'assets' | 'devices' | 'sites';

export interface ToolConfig {
  /** Which entity type does this tool read or write. Drives cache scoping and invalidation. */
  entityType: EntityType;
  /** Cache TTL in ms for read tools. 0 = never cache. Ignored for writes. */
  ttlMs: number;
  /** If true, this tool mutates data — skip cache and increment the entity generation after the call. */
  isWrite: boolean;
}

/**
 * Per-vendor, per-tool cache configuration.
 *
 * Vendors covered: autotask, itglue, halopsa, ninjaone, connectwise-psa, hudu, datto-rmm.
 * To add a new vendor: enumerate its tool names (from running container or source repo),
 * then apply the same TTL tiers:
 *   - Picklists / admin-configured schema → 24 hr
 *   - Stable reference data (companies, org hierarchy, devices) → 60 min
 *   - Actively-edited records (contacts, documents, assets) → 5-15 min
 *   - Live operational data (tickets, alerts) → 30 s
 *   - Write tools (create/update/delete/resolve) → isWrite: true, ttlMs irrelevant
 *
 * Unlisted tools are passed through uncached.
 */
export const VENDOR_TOOL_CONFIG: Record<string, Record<string, ToolConfig>> = {
  autotask: {
    // --- Tickets (30 s TTL) ---
    // Short TTL covers agentic loop deduplication without staling live queues.
    // All ticket writes increment the generation counter so any subsequent read
    // sees fresh data even within the 30 s window.
    autotask_search_tickets:        { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_get_ticket_details:    { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_search_ticket_notes:   { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_get_ticket_note:       { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_search_ticket_attachments: { entityType: 'tickets', ttlMs: 30_000,         isWrite: false },
    autotask_get_ticket_attachment: { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_search_tasks:          { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    // Ticket writes
    autotask_create_ticket:         { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },
    autotask_create_ticket_note:    { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },
    autotask_create_time_entry:     { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },
    autotask_create_task:           { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },

    // --- Companies (60 min TTL) ---
    autotask_search_companies:      { entityType: 'companies', ttlMs: 60 * 60_000,      isWrite: false },
    autotask_search_company_notes:  { entityType: 'companies', ttlMs: 60 * 60_000,      isWrite: false },
    autotask_get_company_note:      { entityType: 'companies', ttlMs: 60 * 60_000,      isWrite: false },
    autotask_search_contracts:      { entityType: 'companies', ttlMs: 60 * 60_000,      isWrite: false },
    autotask_search_configuration_items: { entityType: 'companies', ttlMs: 60 * 60_000, isWrite: false },
    // Company writes
    autotask_create_company:        { entityType: 'companies', ttlMs: 0,                isWrite: true  },
    autotask_create_company_note:   { entityType: 'companies', ttlMs: 0,                isWrite: true  },

    // --- Contacts (15 min TTL) ---
    autotask_search_contacts:       { entityType: 'contacts',  ttlMs: 10 * 60_000,      isWrite: false },
    // Contact writes
    autotask_create_contact:        { entityType: 'contacts',  ttlMs: 0,                isWrite: true  },

    // --- Resources / technicians (60 min TTL) ---
    autotask_search_resources:      { entityType: 'resources', ttlMs: 60 * 60_000,      isWrite: false },

    // --- Picklists / field definitions (24 hr TTL) ---
    // These only change when an admin reconfigures Autotask — treat as near-static.
    autotask_get_field_info:        { entityType: 'picklists', ttlMs: 24 * 60 * 60_000, isWrite: false },
    autotask_list_queues:           { entityType: 'picklists', ttlMs: 24 * 60 * 60_000, isWrite: false },
    autotask_list_ticket_statuses:  { entityType: 'picklists', ttlMs: 24 * 60 * 60_000, isWrite: false },
    autotask_list_ticket_priorities:{ entityType: 'picklists', ttlMs: 24 * 60 * 60_000, isWrite: false },

    // --- Projects (30 s TTL — same volatility as tickets) ---
    autotask_search_projects:       { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_search_project_notes:  { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_get_project_note:      { entityType: 'tickets',   ttlMs: 30_000,           isWrite: false },
    autotask_create_project:        { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },
    autotask_create_project_note:   { entityType: 'tickets',   ttlMs: 0,                isWrite: true  },

    // --- Financial / billing (15 min TTL) ---
    // Billing records are written by Autotask internally (not by agents), so
    // writes here are rare. 15 min is conservative — dial up if LLM latency
    // is noticeable, dial down if billing discrepancies are reported.
    autotask_search_billing_items:  { entityType: 'companies', ttlMs: 10 * 60_000,      isWrite: false },
    autotask_search_billing_item_approval_levels: { entityType: 'companies', ttlMs: 10 * 60_000, isWrite: false },
    autotask_get_billing_item:      { entityType: 'companies', ttlMs: 10 * 60_000,      isWrite: false },
    autotask_search_invoices:       { entityType: 'companies', ttlMs: 10 * 60_000,      isWrite: false },
    autotask_search_quotes:         { entityType: 'companies', ttlMs: 10 * 60_000,      isWrite: false },
    autotask_get_quote:             { entityType: 'companies', ttlMs: 10 * 60_000,      isWrite: false },
    autotask_create_quote:          { entityType: 'companies', ttlMs: 0,                isWrite: true  },

    // --- Expense reports (15 min TTL) ---
    autotask_search_expense_reports:{ entityType: 'contacts',  ttlMs: 10 * 60_000,      isWrite: false },
    autotask_get_expense_report:    { entityType: 'contacts',  ttlMs: 10 * 60_000,      isWrite: false },
    autotask_create_expense_report: { entityType: 'contacts',  ttlMs: 0,                isWrite: true  },
  },

  // ---------------------------------------------------------------------------
  // IT Glue — documentation platform
  //
  // Organizations and configurations are stable reference data (60 min).
  // Documents/passwords change when technicians update them during jobs;
  // 5 min is short enough to pick up recent edits without hammering the API.
  // Flexible asset types are admin-configured schema — treat as near-static (24 hr).
  // IT Glue enforces a 10,000 req/hr per API key limit; caching reduces churn
  // significantly for agentic loops that re-read the same org or asset multiple times.
  // ---------------------------------------------------------------------------
  itglue: {
    // --- Organizations (60 min TTL) ---
    list_organizations:             { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_organization:               { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    list_configurations:            { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_configuration:              { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    // Configuration writes
    create_configuration:           { entityType: 'companies',  ttlMs: 0,                isWrite: true  },

    // --- Documents (5 min TTL) ---
    // Docs are actively edited by technicians — 5 min balances freshness with cache benefit.
    list_documents:                 { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    get_document:                   { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    search_documents:               { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    // Document writes
    create_document:                { entityType: 'documents',  ttlMs: 0,                isWrite: true  },
    update_document:                { entityType: 'documents',  ttlMs: 0,                isWrite: true  },

    // --- Passwords (10 min TTL) ---
    // Longer than docs — passwords are rotated infrequently, but sensitive enough
    // that we keep TTL modest to avoid serving stale credentials.
    list_passwords:                 { entityType: 'documents',  ttlMs: 10 * 60_000,      isWrite: false },
    get_password:                   { entityType: 'documents',  ttlMs: 10 * 60_000,      isWrite: false },

    // --- Flexible assets (5 min TTL) ---
    list_flexible_assets:           { entityType: 'assets',     ttlMs: 5 * 60_000,       isWrite: false },
    get_flexible_asset:             { entityType: 'assets',     ttlMs: 5 * 60_000,       isWrite: false },
    // Flexible asset writes
    create_flexible_asset:          { entityType: 'assets',     ttlMs: 0,                isWrite: true  },
    update_flexible_asset:          { entityType: 'assets',     ttlMs: 0,                isWrite: true  },

    // --- Flexible asset types / picklists (24 hr TTL) ---
    // Schema definitions — only change when an IT Glue admin reconfigures them.
    list_flexible_asset_types:      { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
  },

  // ---------------------------------------------------------------------------
  // HaloPSA — PSA / ITSM platform
  //
  // Tickets are the primary volatile entity — 30 s TTL covers agentic loop
  // deduplication without staling live queues (same reasoning as Autotask).
  // Clients, technicians and teams are stable reference data (60 min).
  // Ticket types, statuses and priorities are admin-set picklists (24 hr).
  // ---------------------------------------------------------------------------
  halopsa: {
    // --- Tickets (30 s TTL) ---
    list_tickets:                   { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    get_ticket:                     { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    // Ticket writes
    create_ticket:                  { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },
    update_ticket:                  { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },
    add_ticket_note:                { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },

    // --- Clients / companies (60 min TTL) ---
    list_clients:                   { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_client:                     { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },

    // --- Resources / technicians / teams (60 min TTL) ---
    list_technicians:               { entityType: 'resources',  ttlMs: 60 * 60_000,      isWrite: false },
    list_teams:                     { entityType: 'resources',  ttlMs: 60 * 60_000,      isWrite: false },

    // --- Picklists (24 hr TTL) ---
    // Ticket types, statuses, and priorities only change with admin configuration.
    list_ticket_types:              { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
    list_statuses:                  { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
    list_priorities:                { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
  },

  // ---------------------------------------------------------------------------
  // NinjaOne (NinjaRMM) — RMM platform
  //
  // Alerts are the highest-frequency read during agentic troubleshooting sessions;
  // 30 s covers dedup without masking new alerts. Organizations and devices change
  // infrequently once provisioned (60 min). Policies are admin-managed (60 min —
  // could be 24 hr, but agents may act on policy details so keep fresher).
  // ---------------------------------------------------------------------------
  ninjaone: {
    // --- Alerts (30 s TTL — live operational data) ---
    list_alerts:                    { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    get_alerts:                     { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    // Alert writes (resolve/dismiss)
    reset_alert:                    { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },

    // --- Organizations (60 min TTL) ---
    list_organizations:             { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_organization:               { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },

    // --- Devices (60 min TTL) ---
    // Device inventory is stable; status/health is tracked via alerts (above).
    list_devices:                   { entityType: 'devices',    ttlMs: 60 * 60_000,      isWrite: false },
    get_device:                     { entityType: 'devices',    ttlMs: 60 * 60_000,      isWrite: false },
    get_device_details:             { entityType: 'devices',    ttlMs: 60 * 60_000,      isWrite: false },
    // Device writes
    update_device:                  { entityType: 'devices',    ttlMs: 0,                isWrite: true  },

    // --- Policies (60 min TTL) ---
    list_policies:                  { entityType: 'picklists',  ttlMs: 60 * 60_000,      isWrite: false },
  },

  // ---------------------------------------------------------------------------
  // ConnectWise PSA — PSA platform
  //
  // Same ticket volatility model as Autotask and HaloPSA: 30 s for live ticket data,
  // 60 min for stable company/contact records, 24 hr for admin-configured picklists.
  // ConnectWise PSA has per-member API rate limits; caching reduces pressure when
  // multiple technicians run agents concurrently against the same board.
  // ---------------------------------------------------------------------------
  'connectwise-psa': {
    // --- Tickets / service items (30 s TTL) ---
    list_tickets:                   { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    get_ticket:                     { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    // Ticket writes
    create_ticket:                  { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },
    update_ticket:                  { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },
    add_ticket_note:                { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },

    // --- Companies (60 min TTL) ---
    list_companies:                 { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_company:                    { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },

    // --- Contacts (10 min TTL) ---
    // Contacts update more often than companies (new hires, role changes).
    list_contacts:                  { entityType: 'contacts',   ttlMs: 10 * 60_000,      isWrite: false },
    get_contact:                    { entityType: 'contacts',   ttlMs: 10 * 60_000,      isWrite: false },

    // --- Picklists (24 hr TTL) ---
    // Board/status/priority configs are admin-managed, near-static.
    list_statuses:                  { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
    list_priorities:                { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
    list_service_boards:            { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
  },

  // ---------------------------------------------------------------------------
  // Hudu — IT documentation platform
  //
  // Companies are stable reference data (60 min). Assets and articles change as
  // technicians update documentation during or after jobs (15 min — slightly
  // longer than IT Glue docs because Hudu usage patterns skew toward structured
  // asset records that are updated less frequently than ad-hoc documents).
  // Asset layouts are schema definitions managed by admins (24 hr).
  // ---------------------------------------------------------------------------
  hudu: {
    // --- Companies (60 min TTL) ---
    list_companies:                 { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_company:                    { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },

    // --- Assets (15 min TTL) ---
    list_assets:                    { entityType: 'assets',     ttlMs: 15 * 60_000,      isWrite: false },
    get_asset:                      { entityType: 'assets',     ttlMs: 15 * 60_000,      isWrite: false },
    // Asset writes
    create_asset:                   { entityType: 'assets',     ttlMs: 0,                isWrite: true  },

    // --- Articles / knowledge base (5 min TTL) ---
    // Articles can be edited in-session by agents; 5 min ensures edits are visible
    // on the next read without bypassing the cache benefit entirely.
    search_articles:                { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    list_articles:                  { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    get_article:                    { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    // Article writes
    create_article:                 { entityType: 'documents',  ttlMs: 0,                isWrite: true  },
    update_article:                 { entityType: 'documents',  ttlMs: 0,                isWrite: true  },

    // --- Asset layouts (24 hr TTL) ---
    // Schema definitions — only change when a Hudu admin reconfigures them.
    list_asset_layouts:             { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },
  },

  // ---------------------------------------------------------------------------
  // Datto RMM — RMM platform
  //
  // Sites and devices are provisioned inventory — stable reference data (60 min).
  // Alerts are live operational data identical in volatility to NinjaOne alerts (30 s).
  // Datto RMM has conservative API rate limits per site; caching alert reads during
  // agentic triage sessions prevents repeated identical lookups from burning the budget.
  // ---------------------------------------------------------------------------
  'datto-rmm': {
    // --- Alerts (30 s TTL — live operational data) ---
    list_alerts:                    { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    get_alerts:                     { entityType: 'tickets',    ttlMs: 30_000,           isWrite: false },
    // Alert writes (resolve)
    resolve_alert:                  { entityType: 'tickets',    ttlMs: 0,                isWrite: true  },

    // --- Sites (60 min TTL) ---
    list_sites:                     { entityType: 'sites',      ttlMs: 60 * 60_000,      isWrite: false },
    get_site:                       { entityType: 'sites',      ttlMs: 60 * 60_000,      isWrite: false },

    // --- Devices (60 min TTL) ---
    // Device inventory changes when agents are installed/removed, not minute-to-minute.
    list_devices:                   { entityType: 'devices',    ttlMs: 60 * 60_000,      isWrite: false },
    get_device:                     { entityType: 'devices',    ttlMs: 60 * 60_000,      isWrite: false },
  },
};

// ---------------------------------------------------------------------------
// ResultCache
// ---------------------------------------------------------------------------

export class ResultCache {
  private store: CacheStore;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(store: CacheStore = new InMemoryCacheStore()) {
    this.store = store;
  }

  /**
   * Look up a cached tool result. Returns null if uncacheable, expired, or not yet cached.
   */
  async get(
    scope: string,
    vendorSlug: string,
    toolName: string,
    params: unknown,
  ): Promise<unknown | null> {
    const toolConfig = this.getToolConfig(vendorSlug, toolName);
    if (!toolConfig || toolConfig.isWrite || toolConfig.ttlMs === 0) return null;

    const key = await this.buildKey(scope, vendorSlug, toolConfig.entityType, toolName, params);
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Cache a tool result. No-ops if the tool is uncacheable.
   */
  async set(
    scope: string,
    vendorSlug: string,
    toolName: string,
    params: unknown,
    value: unknown,
  ): Promise<void> {
    const toolConfig = this.getToolConfig(vendorSlug, toolName);
    if (!toolConfig || toolConfig.isWrite || toolConfig.ttlMs === 0) return;

    const key = await this.buildKey(scope, vendorSlug, toolConfig.entityType, toolName, params);
    await this.store.set(key, JSON.stringify(value), toolConfig.ttlMs);
  }

  /**
   * Deduplicate concurrent identical reads: all callers await the same upstream fetch.
   */
  async getOrFetch(
    scope: string,
    vendorSlug: string,
    toolName: string,
    params: unknown,
    fetcher: () => Promise<unknown>,
  ): Promise<{ value: unknown; fromCache: boolean }> {
    // Check cache first
    const cached = await this.get(scope, vendorSlug, toolName, params);
    if (cached !== null) return { value: cached, fromCache: true };

    // Deduplicate in-flight fetches for the same key
    const infightKey = `${scope}:${vendorSlug}:${toolName}:${hashParams(params)}`;
    const existing = this.inflight.get(infightKey);
    if (existing) {
      const value = await existing;
      return { value, fromCache: false };
    }

    const promise = fetcher();
    this.inflight.set(infightKey, promise);
    try {
      const value = await promise;
      await this.set(scope, vendorSlug, toolName, params, value);
      return { value, fromCache: false };
    } finally {
      this.inflight.delete(infightKey);
    }
  }

  /**
   * Increment the generation counter for a vendor's entity type, making all
   * existing cached reads for that entity unreachable. Call this after any
   * successful write tool call.
   */
  async invalidate(scope: string, vendorSlug: string, toolName: string): Promise<void> {
    const toolConfig = this.getToolConfig(vendorSlug, toolName);
    if (!toolConfig || !toolConfig.isWrite) return;

    const genKey = this.genKey(scope, vendorSlug, toolConfig.entityType);
    await this.store.incr(genKey);
  }

  private getToolConfig(vendorSlug: string, toolName: string): ToolConfig | null {
    return VENDOR_TOOL_CONFIG[vendorSlug]?.[toolName] ?? null;
  }

  private async buildKey(
    scope: string,
    vendorSlug: string,
    entityType: EntityType,
    toolName: string,
    params: unknown,
  ): Promise<string> {
    const genKey = this.genKey(scope, vendorSlug, entityType);
    const gen = (await this.store.get(genKey)) ?? '0';
    return `mcp:v1:${scope}:${vendorSlug}:${entityType}:v${gen}:${toolName}:${hashParams(params)}`;
  }

  private genKey(scope: string, vendorSlug: string, entityType: EntityType): string {
    return `mcp:v1:${scope}:${vendorSlug}:${entityType}:gen`;
  }
}

function hashParams(params: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(params ?? null))
    .digest('hex')
    .slice(0, 12);
}
