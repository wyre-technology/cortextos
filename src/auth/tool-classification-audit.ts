/**
 * Tool-classification audit — the data behind the warning-only classification lint.
 *
 * Phase 1: structural integrity + coverage stats over VENDOR_TOOL_CONFIG, surfaced by
 * `scripts/lint-tool-classification.ts` (warning-only; never fails a build). As the fleet
 * adds the ~48 unclassified vendors in Phase 2, this catches malformed entries early
 * (bad entityType, non-boolean isWrite/isAdmin, negative ttl). Phase 2 upgrades the lint
 * to PR-blocking against the live-traffic tool enumeration; this module stays the core.
 */
import { VENDOR_TOOL_CONFIG, type ToolConfig, type EntityType } from '../proxy/result-cache.js';
import { tierForToolConfig, type PermissionTier } from './tier-check.js';

/** Runtime mirror of the EntityType union (types erase at runtime). */
const KNOWN_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'tickets', 'companies', 'contacts', 'resources', 'picklists', 'documents', 'assets', 'devices', 'sites', 'generic',
]);

export interface ClassificationStats {
  vendors: number;
  tools: number;
  read: number;
  write: number;
  admin: number;
}

export interface ClassificationAudit {
  stats: ClassificationStats;
  /** Structural problems with the static config. Phase 1 surfaces these as warnings. */
  warnings: string[];
}

/**
 * Audit a vendor-tool classification table for structural integrity and tier coverage.
 * Pure: no I/O, no global mutation. Defaults to the live VENDOR_TOOL_CONFIG.
 */
export function auditToolClassification(
  config: Record<string, Record<string, ToolConfig>> = VENDOR_TOOL_CONFIG,
): ClassificationAudit {
  const warnings: string[] = [];
  const stats: ClassificationStats = { vendors: 0, tools: 0, read: 0, write: 0, admin: 0 };

  for (const [vendor, tools] of Object.entries(config)) {
    stats.vendors += 1;
    for (const [toolName, entry] of Object.entries(tools)) {
      stats.tools += 1;
      const where = `${vendor}.${toolName}`;

      if (typeof entry.isWrite !== 'boolean') {
        warnings.push(`${where}: isWrite must be a boolean (got ${typeof entry.isWrite})`);
      }
      if (entry.isAdmin !== undefined && typeof entry.isAdmin !== 'boolean') {
        warnings.push(`${where}: isAdmin must be boolean or omitted (got ${typeof entry.isAdmin})`);
      }
      if (!KNOWN_ENTITY_TYPES.has(entry.entityType)) {
        warnings.push(`${where}: unknown entityType "${entry.entityType}"`);
      }
      if (typeof entry.ttlMs !== 'number' || !Number.isFinite(entry.ttlMs) || entry.ttlMs < 0) {
        warnings.push(`${where}: ttlMs must be a finite number >= 0 (got ${entry.ttlMs})`);
      }

      const tier: PermissionTier = tierForToolConfig(entry) ?? 'read';
      stats[tier] += 1;
    }
  }

  return { stats, warnings };
}
