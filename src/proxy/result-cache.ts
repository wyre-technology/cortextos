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

export type EntityType = 'tickets' | 'companies' | 'contacts' | 'resources' | 'picklists' | 'documents' | 'assets' | 'devices' | 'sites'
  // 'generic' = a classification-only entry (Phase-2 permission tiers) — carries isWrite/isAdmin
  // for the tier-check but is NOT cache-tuned (always ttlMs:0 / uncached). Vendors classified for
  // permissions but not cache-profiled use this.
  | 'generic';

export interface ToolConfig {
  /** Which entity type does this tool read or write. Drives cache scoping and invalidation. */
  entityType: EntityType;
  /** Cache TTL in ms for read tools. 0 = never cache. Ignored for writes. */
  ttlMs: number;
  /** If true, this tool mutates data — skip cache and increment the entity generation after the call. */
  isWrite: boolean;
  /**
   * If true, this tool affects ORG-LEVEL state (member/role management, billing-state
   * changes, vendor-config/settings mutations) and requires the `admin` permission tier.
   * Defaults to false (unmarked tools are read/write per `isWrite`). Drives the permission
   * tier model (src/auth/tier-check.ts); has no effect on caching.
   */
  isAdmin?: boolean;
}

/**
 * Per-vendor, per-tool cache configuration AND permission-tier classification.
 *
 * Vendors covered (29 total, ported verbatim from gateway 2026-06-18 per supersedes-discipline):
 *   alternative-payments, autotask, auvik, avanan, azure-mcp, blackpoint, cipp,
 *   connectwise-automate, connectwise-psa (conduit-only — gateway uses connectwise-manage),
 *   crewhu, datto-rmm, datto-saas-protection, domotz, halopsa, halopsa-official, hudu,
 *   huntress, itglue, kaseya-quote-manager, liongard, microsoft-graph, ninjaone, pax8,
 *   qbo, rocketcyber, rootly, sentinelone, syncro, threatlocker.
 *
 * **All 8 staging-deployed vendors** (autotask, cipp, datto-rmm, domotz, halopsa-official,
 * itglue, liongard, rootly per #366 baseline) are classified. The remaining 36 conduit
 * catalog vendors are deferred to Phase-1b (see DEFERRED-PHASE-1B note below).
 *
 * To add a new vendor: enumerate its tool names (from running container or source repo),
 * then apply the TTL tiers + isAdmin flagging:
 *   - Picklists / admin-configured schema → 24 hr TTL, isWrite: false
 *   - Stable reference data (companies, org hierarchy, devices) → 60 min TTL, isWrite: false
 *   - Actively-edited records (contacts, documents, assets) → 5-15 min TTL, isWrite: false
 *   - Live operational data (tickets, alerts) → 30 s TTL, isWrite: false
 *   - Write tools (create/update/delete/resolve) → isWrite: true, ttlMs irrelevant
 *   - Admin tools (member/role mgmt, vendor-config mutations) → isWrite: true, isAdmin: true
 *
 * Unlisted tools are passed through uncached AND have null tier-classification
 * (tier-check.ts FAIL-CLOSED deny per requiredTierForTool).
 *
 * DEFERRED-PHASE-1B: 36 conduit-catalog vendors not yet classified — these are NOT
 * deployed at staging (per #366 baseline 2026-06-09), so their absence doesn't break
 * launch. When a deferred vendor gets staging-deployed, add its classifications here
 * BEFORE shipping. Phase-2 runtime gate would FAIL-CLOSED-deny on any unclassified tool
 * via tier-check.ts requiredTierForTool returning null.
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

    // --- Phase-3 tranche-1 security-review classifications (analyst-adjudicated 2026-06-16; dormant) ---
    // Passthrough surfaces (arbitrary method/path/body, arbitrary tool dispatch, NL routing) -> ADMIN.
    autotask_raw_request:           { entityType: 'generic',   ttlMs: 0,                isWrite: true,  isAdmin: true },
    autotask_execute_tool:          { entityType: 'generic',   ttlMs: 0,                isWrite: true,  isAdmin: true },
    autotask_router:                { entityType: 'generic',   ttlMs: 0,                isWrite: true,  isAdmin: true },
    autotask_update_company_site_configuration: { entityType: 'generic', ttlMs: 0,     isWrite: true,  isAdmin: true }, // freeform body (additionalProperties:true)
    // Destructive single-resource deletes -> WRITE (bounded scalar-id, not admin).
    autotask_delete_quote_item:                   { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
    autotask_delete_service_call:                 { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
    autotask_delete_service_call_ticket:          { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
    autotask_delete_service_call_ticket_resource: { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
    autotask_delete_ticket_charge:                { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
    autotask_delete_ticket_checklist_item:        { entityType: 'generic', ttlMs: 0,   isWrite: true,  isAdmin: false },
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
    get_organization:               { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    get_configuration:              { entityType: 'companies',  ttlMs: 60 * 60_000,      isWrite: false },
    // Configuration writes

    // --- Documents (5 min TTL) ---
    // Docs are actively edited by technicians — 5 min balances freshness with cache benefit.
    get_document:                   { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    search_documents:               { entityType: 'documents',  ttlMs: 5 * 60_000,       isWrite: false },
    // Document writes
    create_document:                { entityType: 'documents',  ttlMs: 0,                isWrite: true  },

    // --- Passwords (10 min TTL) ---
    // Longer than docs — passwords are rotated infrequently, but sensitive enough
    // that we keep TTL modest to avoid serving stale credentials.
    // tranche-1 SR correction: show_password defaults true -> a read-tier caller gets the plaintext
    // credential. Credential-read = ADMIN. ttlMs:0 also stops caching the plaintext value (was 10 min).
    get_password:                   { entityType: 'documents',  ttlMs: 0,                isWrite: false, isAdmin: true },

    // --- Flexible assets (5 min TTL) ---
    // Flexible asset writes

    // --- Flexible asset types / picklists (24 hr TTL) ---
    // Schema definitions — only change when an IT Glue admin reconfigures them.
    list_flexible_asset_types:      { entityType: 'picklists',  ttlMs: 24 * 60 * 60_000, isWrite: false },

    // --- Phase-3 tranche-1 security-review classifications (analyst-adjudicated 2026-06-16; dormant) ---
    search_passwords:               { entityType: 'documents',  ttlMs: 0,                isWrite: false, isAdmin: true }, // credential search -> ADMIN
    delete_document_section:        { entityType: 'documents',  ttlMs: 0,                isWrite: true,  isAdmin: false }, // destructive single doc-section -> WRITE
    // PR-C1 re-key: dead/renamed keys removed; current pinned-schema tools classified (ttlMs:0, dormant).
    archive_document: { entityType: 'generic', ttlMs: 0, isWrite: true },
    create_document_section: { entityType: 'generic', ttlMs: 0, isWrite: true },
    itglue_health_check: { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_document_folders: { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_document_sections: { entityType: 'generic', ttlMs: 0, isWrite: false },
    publish_document: { entityType: 'generic', ttlMs: 0, isWrite: true }, // publishing mutates document state -> WRITE (cross-check catch)
    search_configurations: { entityType: 'generic', ttlMs: 0, isWrite: false },
    search_flexible_assets: { entityType: 'generic', ttlMs: 0, isWrite: false },
    search_organizations: { entityType: 'generic', ttlMs: 0, isWrite: false },
    unarchive_document: { entityType: 'generic', ttlMs: 0, isWrite: true },
    update_document_section: { entityType: 'generic', ttlMs: 0, isWrite: true },
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
    // PR-C1 re-key: block was DEAD (unprefixed keys matched no tool). Re-keyed to the #275 pinned
    // schema names + classified (verb-heuristic isWrite; tranche-1 candidate tiers verbatim). ttlMs:0 (dormant; no caching flip — PR-C2).
    halopsa_agents_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_agents_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_assets_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_assets_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_assets_list_types: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_assets_search: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_clients_create: { entityType: 'generic', ttlMs: 0, isWrite: true },
    halopsa_clients_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_clients_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_clients_search: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_invoices_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_invoices_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_navigate: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_status: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_teams_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_tickets_add_action: { entityType: 'generic', ttlMs: 0, isWrite: true },
    halopsa_tickets_create: { entityType: 'generic', ttlMs: 0, isWrite: true },
    halopsa_tickets_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_tickets_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    halopsa_tickets_update: { entityType: 'generic', ttlMs: 0, isWrite: true },
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
    // PR-C1 re-key: block was DEAD (unprefixed keys matched no tool). Re-keyed to the #275 pinned
    // schema names + classified (verb-heuristic isWrite; tranche-1 candidate tiers verbatim). ttlMs:0 (dormant; no caching flip — PR-C2).
    ninjaone_alerts_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_alerts_reset: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_alerts_reset_all: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_alerts_summary: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_devices_activities: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_devices_alerts: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_devices_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_devices_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_devices_reboot: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_devices_services: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_navigate: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_organizations_create: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_organizations_devices: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_organizations_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_organizations_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_organizations_locations: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_status: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_tickets_add_comment: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_tickets_boards_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_tickets_comments: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_tickets_create: { entityType: 'generic', ttlMs: 0, isWrite: true },
    ninjaone_tickets_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_tickets_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ninjaone_tickets_update: { entityType: 'generic', ttlMs: 0, isWrite: true },
  },

  // ---------------------------------------------------------------------------
  // ConnectWise PSA — PSA platform
  //
  // Same ticket volatility model as Autotask and HaloPSA: 30 s for live ticket data,
  // 60 min for stable company/contact records, 24 hr for admin-configured picklists.
  // ConnectWise PSA has per-member API rate limits; caching reduces pressure when
  // multiple technicians run agents concurrently against the same board.
  // ---------------------------------------------------------------------------

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
    // PR-C1 re-key: block was DEAD (unprefixed keys matched no tool). Re-keyed to the #275 pinned
    // schema names + classified (verb-heuristic isWrite; tranche-1 candidate tiers verbatim). ttlMs:0 (dormant; no caching flip — PR-C2).
    hudu_archive_article: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_archive_asset: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_archive_company: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_create_article: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_create_asset: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_create_asset_layout: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_create_asset_password: { entityType: 'generic', ttlMs: 0, isWrite: true, isAdmin: true },
    hudu_create_company: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_create_website: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_delete_article: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_delete_asset: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_delete_asset_password: { entityType: 'generic', ttlMs: 0, isWrite: true, isAdmin: true },
    hudu_delete_company: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_delete_website: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_get_article: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_get_asset: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_get_asset_layout: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_get_asset_password: { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    hudu_get_company: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_get_website: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_activity_logs: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_articles: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_asset_layouts: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_asset_passwords: { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    hudu_list_assets: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_companies: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_folders: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_magic_dash: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_procedures: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_relations: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_list_websites: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_test_connection: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hudu_unarchive_company: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_update_article: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_update_asset: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_update_asset_layout: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_update_asset_password: { entityType: 'generic', ttlMs: 0, isWrite: true, isAdmin: true },
    hudu_update_company: { entityType: 'generic', ttlMs: 0, isWrite: true },
    hudu_update_website: { entityType: 'generic', ttlMs: 0, isWrite: true },
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
    // PR-C1 re-key: block was DEAD (unprefixed keys matched no tool). Re-keyed to the #275 pinned
    // schema names + classified (verb-heuristic isWrite; tranche-1 candidate tiers verbatim). ttlMs:0 (dormant; no caching flip — PR-C2).
    datto_get_device: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_get_device_audit: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_get_site: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_list_alerts: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_list_devices: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_list_sites: { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_resolve_alert: { entityType: 'generic', ttlMs: 0, isWrite: true },
    datto_run_quickjob: { entityType: 'generic', ttlMs: 0, isWrite: true },
  },

  // ===========================================================================
  // Phase-2 permission-classification entries (Batches A/B/C consolidation).
  // entityType:'generic' + ttlMs:0 throughout — classification-only / uncached;
  // these carry isWrite/isAdmin for the (dormant, flag-off) tier-check ONLY.
  // Dev passthrough resolutions applied (verified vs MCP server source): sentinelone
  // powerquery/purple_ai + microsoft_graph_get = admin (unbounded); avanan hec_query_events
  // = read (bounded). Liongard's stale doubled-prefix names are intentionally OMITTED
  // pending a live-registry reconcile (forge harness). 21 vendors / 138 tools.
  // ===========================================================================

  cipp: {
    cipp_list_users:                       { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_conditional_access_policies: { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_list_tenants:                     { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_domain_health:               { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_licenses:                    { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_bpa:                         { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_standards:                   { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_mfa_users:                   { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_get_tenant_drift:                 { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_get_tenant_alignment:             { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_ping:                             { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_list_audit_logs:                  { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_list_groups:                      { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_bec_check:                        { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true }, // tranche-1 flag final (analyst): Read-roled, no tenant mutation (internal cache + async only) -> isWrite:false; admin tier stays (security-assessment data)
    cipp_list_gdap_roles:                  { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_get_version:                      { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_reset_password:                   { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_create_user:                      { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_list_csp_licenses:                { entityType: 'generic', ttlMs: 0, isWrite: false },
    cipp_run_standards_check:              { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_list_named_locations:             { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    // --- Phase-3 tranche-1 security-review classifications (analyst-adjudicated 2026-06-16; dormant) ---
    // User provisioning + access config + admin scheduling -> ADMIN.
    cipp_disable_user:                     { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_edit_user:                        { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_offboard_user:                    { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_reset_mfa:                        { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_delete_standard_template:         { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_add_scheduled_item:               { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    cipp_list_gdap_invites:                { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    cipp_list_mailbox_permissions:         { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
  },

  rootly: {
    update_alert:                  { entityType: 'generic', ttlMs: 0, isWrite: true  },
    list_alerts:                   { entityType: 'generic', ttlMs: 0, isWrite: false },
    createAlert:                   { entityType: 'generic', ttlMs: 0, isWrite: true  },
    get_server_version:            { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_endpoints:                { entityType: 'generic', ttlMs: 0, isWrite: false },
    create_alert_urgency:          { entityType: 'generic', ttlMs: 0, isWrite: true  },
    list_alert_routes:             { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_alerts_sources:           { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_workflows:                { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_alert_urgencies:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    list_user_notification_rules:  { entityType: 'generic', ttlMs: 0, isWrite: false },
    update_alerts_source:          { entityType: 'generic', ttlMs: 0, isWrite: true  },
    list_escalation_policies:      { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  huntress: {
    huntress_accounts_get:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_incidents_list:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_organizations_list:   { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_navigate:             { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_agents_list:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_status:               { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_signals_list:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_escalations_list:     { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_billing_reports_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    huntress_accounts_actor:       { entityType: 'generic', ttlMs: 0, isWrite: false }, // tranche-1 flag final (analyst): pure whoami identity-getter -> READ (matches accounts_get sibling)
    // --- Phase-3 tranche-1 security-review classifications (analyst-adjudicated 2026-06-16; dormant) ---
    // User provisioning + org-deletion -> ADMIN.
    huntress_users_create:         { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    huntress_users_delete:         { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    huntress_users_update:         { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
    huntress_organizations_delete: { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true },
  },

  sentinelone: {
    powerquery:             { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    list_alerts:            { entityType: 'generic', ttlMs: 0, isWrite: false },
    get_timestamp_range:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    purple_ai:              { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    get_alert:              { entityType: 'generic', ttlMs: 0, isWrite: false },
    search_inventory_items: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  liongard: {
    liongard_detections_list:          { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true }, // tranche-1 SR: unbounded filter-DSL (filters: array<object>) over detection data -> ADMIN
    liongard_environments_list:        { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_environments_count:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_agents_list:              { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inventory_devices:        { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true }, // tranche-1 SR: unbounded filter-DSL over device inventory -> ADMIN
    liongard_timeline_list:            { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_systems_list:             { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inventory_identities:     { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true }, // tranche-1 SR: unbounded filter-DSL over identity data (credential-adjacent) -> ADMIN
    liongard_metrics_list:             { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inspections_launchpoints: { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_environments_get:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inspections_inspectors:   { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_metrics_evaluate_systems: { entityType: 'generic', ttlMs: 0, isWrite: true  },
    liongard_navigate:                 { entityType: 'generic', ttlMs: 0, isWrite: false },
    // Phase-3 tranche-1 security-review addition (analyst-adjudicated 2026-06-16; dormant):
    liongard_agents_delete:            { entityType: 'generic', ttlMs: 0, isWrite: true,  isAdmin: true }, // destructive on agents = infra-admin
    // PR-C1 re-key: dead/renamed keys removed; current pinned-schema tools classified (ttlMs:0, dormant).
    liongard_detections_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_environments_create: { entityType: 'generic', ttlMs: 0, isWrite: true },
    liongard_environments_related: { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inspections_create_launchpoint: { entityType: 'generic', ttlMs: 0, isWrite: true },
    liongard_inspections_run: { entityType: 'generic', ttlMs: 0, isWrite: true },
    liongard_inventory_device_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_inventory_identity_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
    liongard_metrics_evaluate: { entityType: 'generic', ttlMs: 0, isWrite: true },
    liongard_systems_get: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  auvik: {
    auvik_devices_list:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_status:               { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_alerts_list:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_tenants_list:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_interfaces_list:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_tenants_detail:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_networks_list:        { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_entities_list_audits: { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_tenants_get:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_configurations_list:  { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_billing_client_usage: { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_entities_list_notes:  { entityType: 'generic', ttlMs: 0, isWrite: false },
    auvik_billing_device_usage: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  syncro: {
    syncro_navigate:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    syncro_assets_list:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    syncro_status:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    syncro_tickets_list:   { entityType: 'generic', ttlMs: 0, isWrite: false },
    syncro_customers_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    syncro_invoices_list:  { entityType: 'generic', ttlMs: 0, isWrite: false },
    // Phase-3 tranche-1 security-review addition (analyst-adjudicated 2026-06-16; dormant):
    syncro_tickets_add_comment: { entityType: 'generic', ttlMs: 0, isWrite: true, isAdmin: false }, // bounded ticket comment -> WRITE
  },

  rocketcyber: {
    rocketcyber_list_incidents:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_get_account:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_list_agents:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_get_event_summary: { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_list_events:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_test_connection:   { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_get_defender:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    rocketcyber_get_office:        { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  pax8: {
    'pax8-list-companies':      { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-list-subscriptions':  { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-get-product-by-uuid': { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-lookup-product':      { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-list-invoices':       { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-list-products':       { entityType: 'generic', ttlMs: 0, isWrite: false },
    'pax8-list-orders':         { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'connectwise-automate': {
    cwautomate_status:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    cwautomate_navigate:     { entityType: 'generic', ttlMs: 0, isWrite: false },
    cwautomate_clients_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    cwautomate_scripts_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'alternative-payments': {
    ap_list_customers:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    ap_get_customer:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    ap_navigate:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    ap_list_transactions: { entityType: 'generic', ttlMs: 0, isWrite: false },
    ap_list_invoices:     { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'azure-mcp': {
    subscription_list:   { entityType: 'generic', ttlMs: 0, isWrite: false },
    group_resource_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    group_list:          { entityType: 'generic', ttlMs: 0, isWrite: false },
    advisor:             { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  qbo: {
    qbo_status:                   { entityType: 'generic', ttlMs: 0, isWrite: false },
    qbo_customers_list:           { entityType: 'generic', ttlMs: 0, isWrite: false },
    qbo_reports_aged_receivables: { entityType: 'generic', ttlMs: 0, isWrite: false },
    qbo_invoices_list:            { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  domotz: {
    domotz_navigate:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    domotz_status:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    domotz_agents_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    domotz_agents_get:  { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  crewhu: {
    crewhu_surveys_list:       { entityType: 'generic', ttlMs: 0, isWrite: false },
    crewhu_users_list:         { entityType: 'generic', ttlMs: 0, isWrite: false },
    crewhu_surveys_detractors: { entityType: 'generic', ttlMs: 0, isWrite: false },
    crewhu_badges_list:        { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'datto-saas-protection': {
    datto_saas_list_clients:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_saas_list_domains:      { entityType: 'generic', ttlMs: 0, isWrite: false },
    datto_saas_get_license_usage: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'microsoft-graph': {
    microsoft_graph_get:             { entityType: 'generic', ttlMs: 0, isWrite: false, isAdmin: true },
    microsoft_graph_suggest_queries: { entityType: 'generic', ttlMs: 0, isWrite: false },
    microsoft_graph_list_properties: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  avanan: {
    hec_query_events:    { entityType: 'generic', ttlMs: 0, isWrite: false },
    hec_list_exceptions: { entityType: 'generic', ttlMs: 0, isWrite: false },
    hec_search_emails:   { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'halopsa-official': {
    search_tickets: { entityType: 'generic', ttlMs: 0, isWrite: false },
    get_one_ticket: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  'kaseya-quote-manager': {
    kqm_customer_list: { entityType: 'generic', ttlMs: 0, isWrite: false },
    kqm_navigate:      { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  blackpoint: {
    blackpoint_status: { entityType: 'generic', ttlMs: 0, isWrite: false },
  },

  // Phase-3 tranche-1 security-review classification (analyst-adjudicated 2026-06-16; dormant).
  // No prior threatlocker block existed — created here for the one classified tool.
  threatlocker: {
    threatlocker_approvals_get_permit_application: { entityType: 'generic', ttlMs: 0, isWrite: false }, // tranche-1 flag final (analyst): informational workflow getter, not security-config -> READ (downgraded from PR-A conservative-ADMIN)
  },

  // Conduit-only vendor (gateway uses connectwise-manage instead).
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
};

/**
 * Look up a tool's ToolConfig by (vendor, tool). Returns null when the vendor or tool
 * is not present in VENDOR_TOOL_CONFIG — callers MUST treat null as "unclassified"
 * (the tier-check layer maps that to FAIL-CLOSED deny per src/auth/tier-check.ts).
 */
export function vendorToolConfig(vendorSlug: string, toolName: string): ToolConfig | null {
  return VENDOR_TOOL_CONFIG[vendorSlug]?.[toolName] ?? null;
}

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
