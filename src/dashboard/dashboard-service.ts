/**
 * Dashboard service — usage analytics queries over request_log.
 *
 * All data already exists in the request_log table; this service
 * provides typed query methods for the dashboard API and web UI.
 */

import { getSql, type Sql } from '../db/context.js';

export interface DateRange {
  start?: string; // ISO 8601
  end?: string;   // ISO 8601
}

export interface UsageSummary {
  totalCalls: number;
  uniqueUsers: number;
  avgResponseTimeMs: number;
  byVendor: Array<{ vendor: string; count: number }>;
  byUser: Array<{ userId: string; email: string | null; count: number }>;
  byDay: Array<{ date: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
}

export interface TokenSavings {
  totalMcpCalls: number;
  totalCliCalls: number;
  estimatedTokensSaved: number;
  estimatedCostSavedUsd: number;
}

export interface VendorBreakdown {
  vendor: string;
  totalCalls: number;
  uniqueUsers: number;
  avgResponseTimeMs: number;
  topTools: Array<{ tool: string; count: number }>;
}

export class DashboardService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  async getUsageSummary(orgId: string, range: DateRange = {}): Promise<UsageSummary> {
    const where = this.buildWhere(orgId, range);

    const [totals, byVendor, byUser, byDay, bySource] = await Promise.all([
      this.sql<{ total_calls: number; unique_users: number; avg_ms: number }[]>`
        SELECT
          COUNT(*)::int AS total_calls,
          COUNT(DISTINCT user_id)::int AS unique_users,
          COALESCE(AVG(response_time_ms), 0)::int AS avg_ms
        FROM request_log r ${where}
      `,
      this.sql<{ vendor: string; count: number }[]>`
        SELECT vendor_slug AS vendor, COUNT(*)::int AS count
        FROM request_log r ${where}
        GROUP BY vendor_slug ORDER BY count DESC LIMIT 20
      `,
      this.sql<{ user_id: string; email: string | null; count: number }[]>`
        SELECT r.user_id, u.email, COUNT(*)::int AS count
        FROM request_log r
        LEFT JOIN users u ON u.id = r.user_id
        ${where}
        GROUP BY r.user_id, u.email ORDER BY count DESC LIMIT 20
      `,
      this.sql<{ date: string; count: number }[]>`
        SELECT DATE(r.created_at) AS date, COUNT(*)::int AS count
        FROM request_log r ${where}
        GROUP BY DATE(r.created_at) ORDER BY date DESC LIMIT 30
      `,
      this.sql<{ source: string; count: number }[]>`
        SELECT COALESCE(source, 'mcp') AS source, COUNT(*)::int AS count
        FROM request_log r ${where}
        GROUP BY COALESCE(source, 'mcp')
      `,
    ]);

    return {
      totalCalls: totals[0]?.total_calls ?? 0,
      uniqueUsers: totals[0]?.unique_users ?? 0,
      avgResponseTimeMs: totals[0]?.avg_ms ?? 0,
      byVendor: byVendor.map((r) => ({ vendor: r.vendor, count: r.count })),
      byUser: byUser.map((r) => ({ userId: r.user_id, email: r.email, count: r.count })),
      byDay: byDay.map((r) => ({ date: String(r.date), count: r.count })),
      bySource: bySource.map((r) => ({ source: r.source, count: r.count })),
    };
  }

  async getTokenSavings(orgId: string, range: DateRange = {}): Promise<TokenSavings> {
    const where = this.buildWhere(orgId, range);

    const rows = await this.sql<{ source: string; count: number }[]>`
      SELECT COALESCE(source, 'mcp') AS source, COUNT(*)::int AS count
      FROM request_log r ${where}
      GROUP BY COALESCE(source, 'mcp')
    `;

    const mcpCalls = rows.find((r) => r.source === 'mcp')?.count ?? 0;
    const cliCalls = rows.find((r) => r.source === 'cli')?.count ?? 0;

    // Each CLI call saves ~2 MCP handshake requests (~800 tokens each at ~$3/MTok)
    const tokensSavedPerCliCall = 1600;
    const costPerMTok = 3.0;
    const estimatedTokensSaved = cliCalls * tokensSavedPerCliCall;
    const estimatedCostSavedUsd = (estimatedTokensSaved / 1_000_000) * costPerMTok;

    return {
      totalMcpCalls: mcpCalls,
      totalCliCalls: cliCalls,
      estimatedTokensSaved,
      estimatedCostSavedUsd: Math.round(estimatedCostSavedUsd * 100) / 100,
    };
  }

  async getVendorBreakdown(orgId: string, range: DateRange = {}): Promise<VendorBreakdown[]> {
    const where = this.buildWhere(orgId, range);

    const vendors = await this.sql<{
      vendor: string;
      total_calls: number;
      unique_users: number;
      avg_ms: number;
    }[]>`
      SELECT
        vendor_slug AS vendor,
        COUNT(*)::int AS total_calls,
        COUNT(DISTINCT user_id)::int AS unique_users,
        COALESCE(AVG(response_time_ms), 0)::int AS avg_ms
      FROM request_log r ${where}
      GROUP BY vendor_slug ORDER BY total_calls DESC
    `;

    const results: VendorBreakdown[] = [];
    for (const v of vendors) {
      const tools = await this.sql<{ tool: string; count: number }[]>`
        SELECT tool_name AS tool, COUNT(*)::int AS count
        FROM request_log r ${where} AND r.vendor_slug = ${v.vendor} AND r.tool_name IS NOT NULL
        GROUP BY tool_name ORDER BY count DESC LIMIT 5
      `;

      results.push({
        vendor: v.vendor,
        totalCalls: v.total_calls,
        uniqueUsers: v.unique_users,
        avgResponseTimeMs: v.avg_ms,
        topTools: tools.map((t) => ({ tool: t.tool, count: t.count })),
      });
    }

    return results;
  }

  private buildWhere(orgId: string, range: DateRange) {
    const conditions = [this.sql`(r.org_id = ${orgId} OR (r.org_id IS NULL AND r.user_id IN (
      SELECT user_id FROM org_members WHERE org_id = ${orgId}
    )))`];

    if (range.start) conditions.push(this.sql`r.created_at >= ${range.start}`);
    if (range.end) conditions.push(this.sql`r.created_at <= ${range.end}`);

    return this.sql`WHERE ${conditions.reduce((a, b) => this.sql`${a} AND ${b}`)}`;
  }
}
