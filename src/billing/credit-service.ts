import { getSql, type Sql } from '../db/context.js';
import type { BillingGate } from './gate.js';

// ---------------------------------------------------------------------------
// CreditService — tracks and queries per-org credit consumption
// ---------------------------------------------------------------------------
//
// Credits represent successful vendor tool calls (tools/call returning 200
// from a real vendor container). They are NOT counted for: tools/list,
// failed calls, or _gateway/_unified internal operations.
//
// Schema lives in migrations/017_mcp_gateway_parity.sql:
//   credit_ledger  — one row per successful vendor tool call
//   credit_blocks  — purchased overage blocks (FIFO depletion)

export class CreditService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  constructor(
    private billingGate: BillingGate,
  ) {}

  // -------------------------------------------------------------------------
  // Usage recording
  // -------------------------------------------------------------------------

  /**
   * Record one credit used by an org member calling a vendor tool.
   * Fire-and-forget safe — callers should `.catch()` to avoid blocking.
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
   * Sum credits used by the org since the start of the current calendar month
   * (UTC midnight on the 1st).
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

  // -------------------------------------------------------------------------
  // Block balance
  // -------------------------------------------------------------------------

  /**
   * Sum remaining credits across all purchased overage blocks for this org.
   */
  async getBlockBalance(orgId: string): Promise<number> {
    const rows = await this.sql<{ total: string }[]>`
      SELECT COALESCE(SUM(remaining), 0)::text AS total
      FROM credit_blocks
      WHERE org_id = ${orgId}
        AND remaining > 0
    `;
    return parseInt(rows[0]?.total ?? '0', 10);
  }

  // -------------------------------------------------------------------------
  // Allocation + availability
  // -------------------------------------------------------------------------

  /**
   * Total credits available this month: plan allocation + purchased blocks.
   */
  async getTotalAvailable(orgId: string): Promise<number> {
    const [allocated, blocks] = await Promise.all([
      this.billingGate.getCreditAllocation(orgId),
      this.getBlockBalance(orgId),
    ]);
    return allocated + blocks;
  }

  /**
   * Whether the org has any credits left (plan or blocks).
   */
  async hasCreditsRemaining(orgId: string): Promise<boolean> {
    const [used, total] = await Promise.all([
      this.getUsageThisMonth(orgId),
      this.getTotalAvailable(orgId),
    ]);
    return used < total;
  }

  // -------------------------------------------------------------------------
  // Block addition (purchases)
  // -------------------------------------------------------------------------

  async addBlock(orgId: string, credits: number, stripePaymentIntentId: string | null): Promise<void> {
    // The unique index on stripe_payment_intent_id (migration 017) is PARTIAL
    // — `WHERE stripe_payment_intent_id IS NOT NULL`. Postgres only infers a
    // partial index as the ON CONFLICT arbiter when the statement REPEATS that
    // predicate; a bare `ON CONFLICT (col)` finds no matching non-partial
    // index and raises "no unique or exclusion constraint matching the ON
    // CONFLICT specification". Repeating the predicate is what makes this
    // INSERT genuinely idempotent — without it the first credit-pack purchase
    // throws rather than no-ops on a redelivered Stripe webhook.
    await this.sql`
      INSERT INTO credit_blocks (org_id, credits, remaining, stripe_payment_intent_id)
      VALUES (${orgId}, ${credits}, ${credits}, ${stripePaymentIntentId})
      ON CONFLICT (stripe_payment_intent_id)
        WHERE stripe_payment_intent_id IS NOT NULL
        DO NOTHING
    `;
  }

  /**
   * Grant comp credits to an org without going through Stripe. Provenance
   * (admin email + reason) is captured so audits can answer "who comped what
   * and why." The credits go into the same FIFO bucket as paid blocks.
   */
  async grantComp(
    orgId: string,
    credits: number,
    grantedBy: string,
    reason: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO credit_blocks (org_id, credits, remaining, granted_by, reason)
      VALUES (${orgId}, ${credits}, ${credits}, ${grantedBy}, ${reason})
    `;
  }

  // -------------------------------------------------------------------------
  // Block depletion (FIFO)
  // -------------------------------------------------------------------------

  /**
   * Deduct `amount` credits from the oldest non-empty block(s) for this org.
   * Stops when fully deducted or no blocks remain. Returns credits actually
   * deducted (may be less than `amount` if blocks run out).
   */
  async deductFromBlock(orgId: string, amount: number): Promise<number> {
    if (amount <= 0) return 0;
    return this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as Sql;
      const blocks = await sql<{ id: string; remaining: string }[]>`
        SELECT id, remaining::text
        FROM credit_blocks
        WHERE org_id = ${orgId} AND remaining > 0
        ORDER BY purchased_at ASC
        FOR UPDATE SKIP LOCKED
      `;
      let toDeduct = amount;
      let totalDeducted = 0;
      for (const block of blocks) {
        if (toDeduct <= 0) break;
        const avail = parseInt(block.remaining, 10);
        const take = Math.min(avail, toDeduct);
        await sql`UPDATE credit_blocks SET remaining = remaining - ${take} WHERE id = ${block.id}`;
        toDeduct -= take;
        totalDeducted += take;
      }
      return totalDeducted;
    });
  }

  // -------------------------------------------------------------------------
  // Period helpers (for the API response)
  // -------------------------------------------------------------------------

  getPeriodStart(): Date {
    return currentMonthStart();
  }

  getPeriodEnd(): Date {
    return currentMonthEnd();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function currentMonthEnd(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, -1));
}
