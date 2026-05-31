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
    // Insert new entries
    for (const toolName of toolNames) {
      const id = nanoid();
      await this.sql`
        INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, role, tool_name, granted_by)
        VALUES (${id}, ${orgId}, ${vendorSlug}, ${role}, ${toolName}, ${grantedBy})
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
      // the row in the team shape.
      await this.sql`
        INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, team_id, role, tool_name, granted_by)
        VALUES (${id}, ${orgId}, ${vendorSlug}, ${teamId}, ${null}, ${toolName}, ${grantedBy})
      `;
    }
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
