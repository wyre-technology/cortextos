import { getSql, type Sql } from '../db/context.js';

// ---------------------------------------------------------------------------
// CreditService — per-org per-call USAGE-LOG recording + query.
// ---------------------------------------------------------------------------
//
// Flat-pricing (Aaron 2026-05-26) removed the CUSTOMER credit-BILLING layer
// (allocation, purchased blocks, balance, the customer credit display). What
// remains here is the raw usage-LOG: one credit_ledger row per successful
// vendor tool call. That log is the metering SUBSTRATE the reseller-channel
// wholesale invoicing (reseller-invoice-service CreditLedgerUsageSource) and
// the admin credit-burn dashboard read — so it stays. This is the same
// distinction as request_log: usage-recording is kept; the customer billing
// model on top of it is gone.
//
// credit_ledger: one row per successful vendor tool call (NOT counted for
// tools/list, failed calls, or _gateway/_unified internal operations).
// Schema in migrations/017_mcp_gateway_parity.sql. The credit_blocks table
// (customer overage purchases) is dropped by the flat-pricing migration.

export class CreditService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  // -------------------------------------------------------------------------
  // Usage recording
  // -------------------------------------------------------------------------

  /**
   * Record one usage-log row for an org member calling a vendor tool.
   * Fire-and-forget safe — callers should `.catch()` to avoid blocking.
   * The row feeds reseller-wholesale invoicing + admin usage analytics;
   * it no longer drives any customer-facing credit balance or gate.
   */
  async recordUsage(orgId: string, userId: string, vendorSlug: string): Promise<void> {
    await this.sql`
      INSERT INTO credit_ledger (org_id, user_id, vendor_slug)
      VALUES (${orgId}, ${userId}, ${vendorSlug})
    `;
  }

  // -------------------------------------------------------------------------
  // Usage queries
  // -------------------------------------------------------------------------

  /**
   * Sum usage-log rows for the org since the start of the current calendar
   * month (UTC midnight on the 1st). Read by reseller-wholesale invoicing
   * and admin analytics — not a customer credit balance.
   */
  async getUsageThisMonth(orgId: string): Promise<number> {
    const periodStart = currentMonthStart();
    const rows = await this.sql<{ total: string }[]>`
      SELECT COALESCE(SUM(credits_used), 0)::text AS total
      FROM credit_ledger
      WHERE org_id = ${orgId}
        AND recorded_at >= ${periodStart.toISOString()}
    `;
    return parseInt(rows[0]?.total ?? '0', 10);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
