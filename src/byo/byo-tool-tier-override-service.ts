/**
 * BYOMCP per-tool tier overrides (WYREAI-191).
 *
 * Owner-scoped storage for MANUAL permission-tier pins that win over the 190
 * auto-classification. A pin says "for MY server S, tool T is tier X" regardless
 * of what classifyByoTool inferred. Absence of a pin = use the auto tier.
 *
 * RLS owner-only via `conduit.current_user_id` (migration 057), same as
 * byo_mcp_servers. Every method runs on the request-path connection, so a user
 * can only ever read/set/clear their OWN pins — the DB is the belt, the
 * `WHERE user_id = ${userId}` clauses the suspenders.
 */
import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';
import type { PermissionTier } from '../auth/tier-check.js';

interface OverrideRow {
  tool_name: string;
  tier: PermissionTier;
}

export class ByoToolTierOverrideService {
  private get sql(): Sql {
    return getSql();
  }

  /**
   * All tier pins for one BYO server, as a `toolName → tier` map. Empty map when
   * the owner has pinned nothing (or the server isn't theirs — RLS returns no
   * rows).
   */
  async getOverrides(userId: string, byoServerId: string): Promise<Map<string, PermissionTier>> {
    const rows = await this.sql<OverrideRow[]>`
      SELECT tool_name, tier
      FROM byo_tool_tier_overrides
      WHERE user_id = ${userId} AND byo_server_id = ${byoServerId}
    `;
    return new Map(rows.map((r) => [r.tool_name, r.tier]));
  }

  /**
   * Pin (upsert) a tool's tier. The `tier` is constrained to the PermissionTier
   * domain by the column CHECK; this method takes the typed union so a bad value
   * can't be constructed at the call site either.
   */
  async setOverride(
    userId: string,
    byoServerId: string,
    toolName: string,
    tier: PermissionTier,
  ): Promise<void> {
    const id = nanoid();
    await this.sql`
      INSERT INTO byo_tool_tier_overrides (id, user_id, byo_server_id, tool_name, tier, updated_at)
      VALUES (${id}, ${userId}, ${byoServerId}, ${toolName}, ${tier}, NOW())
      ON CONFLICT (user_id, byo_server_id, tool_name) DO UPDATE SET
        tier       = EXCLUDED.tier,
        updated_at = NOW()
    `;
  }

  /**
   * Clear a tool's pin (revert to the auto-classification). Returns true if a
   * pin was removed. The DELETE is owner-scoped + relies on the migration-057
   * DELETE policy.
   */
  async clearOverride(userId: string, byoServerId: string, toolName: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM byo_tool_tier_overrides
      WHERE user_id = ${userId} AND byo_server_id = ${byoServerId} AND tool_name = ${toolName}
    `;
    return result.count > 0;
  }
}
