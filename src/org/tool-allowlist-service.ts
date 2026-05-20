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
}
