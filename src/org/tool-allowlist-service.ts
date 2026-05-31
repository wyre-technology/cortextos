import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';

export class ToolAllowlistService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  async getToolAllowlist(
    orgId: string,
    vendorSlug: string,
    role: string,
  ): Promise<string[] | null> {
    const rows = await this.sql<{ tool_name: string }[]>`
      SELECT tool_name FROM org_tool_allowlist
      WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug} AND role = ${role}
      ORDER BY tool_name
    `;
    if (rows.length === 0) return null;
    return rows.map((r) => r.tool_name);
  }

  async setToolAllowlist(
    orgId: string,
    vendorSlug: string,
    role: string,
    toolNames: string[],
    grantedBy: string,
  ): Promise<void> {
    // Delete existing entries first
    await this.sql`
      DELETE FROM org_tool_allowlist
      WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug} AND role = ${role}
    `;
    // Insert new entries (WYREAI-62: granted_at = NOW() captures the audit
    // timestamp at write-time; getTeamToolAllowlistWithAudit reads it back).
    for (const toolName of toolNames) {
      const id = nanoid();
      await this.sql`
        INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, role, tool_name, granted_by, granted_at)
        VALUES (${id}, ${orgId}, ${vendorSlug}, ${role}, ${toolName}, ${grantedBy}, NOW())
      `;
    }
  }

  async clearToolAllowlist(
    orgId: string,
    vendorSlug: string,
    role: string,
  ): Promise<void> {
    await this.sql`
      DELETE FROM org_tool_allowlist
      WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug} AND role = ${role}
    `;
  }

  async getAllToolAllowlists(
    orgId: string,
    vendorSlug: string,
  ): Promise<{ admin: string[] | null; member: string[] | null }> {
    // Sequential, NOT Promise.all: getToolAllowlist issues a DB query, and on
    // a request-path call it runs on the request's single reserved-tx
    // connection. A Promise.all of two such method calls stalls that
    // connection (same hang class as the /v1/mcp tools/call bug). Sequential
    // awaits remove the concurrency.
    const admin = await this.getToolAllowlist(orgId, vendorSlug, 'admin');
    const member = await this.getToolAllowlist(orgId, vendorSlug, 'member');
    return { admin, member };
  }

  // -------------------------------------------------------------------------
  // Team-scoped allowlist (WYREAI-59, parity port of gateway #189).
  //
  // A team-scoped row carries team_id NOT NULL + role NULL — the shape
  // complement of the role-scoped rows above. The schema CHECK invariant
  // `(team_id IS NULL) <> (role IS NULL)` enforces that structurally, so
  // these methods set role to NULL explicitly while the role-scoped methods
  // leave team_id NULL (default). Both shapes share the table; the partial
  // UNIQUE indexes (uniq_org_tool_allowlist_role / _team) keep them apart.
  //
  // No effective-scope resolution here — these are pure data-access. The
  // team ∩ org intersection lives in src/org/effective-scope.ts (sibling
  // WYREAI-60) and the enforcement wiring in src/proxy/* (sibling WYREAI-61).
  // -------------------------------------------------------------------------

  async getTeamToolAllowlist(
    orgId: string,
    teamId: string,
    vendorSlug: string,
  ): Promise<string[] | null> {
    const rows = await this.sql<{ tool_name: string }[]>`
      SELECT tool_name FROM org_tool_allowlist
      WHERE org_id = ${orgId}
        AND vendor_slug = ${vendorSlug}
        AND team_id = ${teamId}
      ORDER BY tool_name
    `;
    if (rows.length === 0) return null;
    return rows.map((r) => r.tool_name);
  }

  async setTeamToolAllowlist(
    orgId: string,
    teamId: string,
    vendorSlug: string,
    toolNames: string[],
    grantedBy: string,
  ): Promise<void> {
    // Replace-set semantics, mirroring the role-scoped setToolAllowlist.
    await this.sql`
      DELETE FROM org_tool_allowlist
      WHERE org_id = ${orgId}
        AND vendor_slug = ${vendorSlug}
        AND team_id = ${teamId}
    `;
    for (const toolName of toolNames) {
      const id = nanoid();
      // role explicitly NULL — the CHECK invariant + the partial UNIQUE on
      // (org_id, vendor_slug, team_id, tool_name) WHERE role IS NULL keep
      // the row in the team shape. granted_at = NOW() captures the audit
      // timestamp (WYREAI-62, read back by getTeamToolAllowlistWithAudit).
      await this.sql`
        INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, team_id, role, tool_name, granted_by, granted_at)
        VALUES (${id}, ${orgId}, ${vendorSlug}, ${teamId}, ${null}, ${toolName}, ${grantedBy}, NOW())
      `;
    }
  }

  /**
   * WYREAI-62 (parity port of gateway #200 step-2): get the team allowlist
   * for (org, team, vendor) ALONG WITH the audit metadata — who granted (a
   * friendly label COALESCEd from users.display_name/name/email) and when
   * (granted_at). Returns null when no rows exist (caller renders the
   * "inherit org defaults" empty state).
   *
   * LEFT JOIN to users: a missing user row (deleted account, legacy data)
   * leaves grantedBy as the raw user_id rather than 500-ing.
   *
   * ORDER BY granted_at DESC NULLS LAST: today's setTeamToolAllowlist deletes-
   * then-inserts atomically so all rows in a (team, vendor) group share a
   * granted_at; but if that impl ever changes to incremental edits, this
   * ordering returns the MOST-RECENT grant first — defense-in-depth against
   * future row-drift (warden's gateway-#200 framing applied here too).
   *
   * Tools list returned in granted_at order; the caller can re-sort by name
   * if presentation requires.
   */
  async getTeamToolAllowlistWithAudit(
    orgId: string,
    teamId: string,
    vendorSlug: string,
  ): Promise<{
    tools: string[];
    grantedBy: string | null;
    grantedAt: string | null;
  } | null> {
    const rows = await this.sql<
      {
        tool_name: string;
        granted_by: string;
        granted_at: string | null;
        granted_by_label: string | null;
      }[]
    >`
      SELECT a.tool_name,
             a.granted_by,
             a.granted_at,
             COALESCE(u.display_name, u.name, u.email) AS granted_by_label
        FROM org_tool_allowlist a
        LEFT JOIN users u ON u.id = a.granted_by
       WHERE a.org_id = ${orgId}
         AND a.vendor_slug = ${vendorSlug}
         AND a.team_id = ${teamId}
       ORDER BY a.granted_at DESC NULLS LAST, a.tool_name ASC
    `;
    if (rows.length === 0) return null;
    // The replace-set semantics of setTeamToolAllowlist mean all rows share
    // (granted_by, granted_at); take the first (most-recent if drift) for the
    // audit surface, list every tool_name.
    const first = rows[0];
    return {
      tools: rows.map((r) => r.tool_name),
      grantedBy: first.granted_by_label ?? first.granted_by,
      grantedAt: first.granted_at,
    };
  }

  async clearTeamToolAllowlist(
    orgId: string,
    teamId: string,
    vendorSlug: string,
  ): Promise<void> {
    await this.sql`
      DELETE FROM org_tool_allowlist
      WHERE org_id = ${orgId}
        AND vendor_slug = ${vendorSlug}
        AND team_id = ${teamId}
    `;
  }
}
