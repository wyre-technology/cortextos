/**
 * ResellerPricingService — append-only supersession layer over
 * `reseller_pricing_config` (mig 025).
 *
 * Track C PR-A foundation. Two responsibilities:
 *   - setPricing: append a new row capturing a (reseller, subtenant, mode,
 *     value) tuple at the current timestamp. RLS + the structural-invariant
 *     trigger enforce all authority + topology checks; this service does
 *     not duplicate them at app layer.
 *   - getCurrentPricing: return the latest effective row for a given
 *     (reseller, subtenant) pair, or null if no config has ever been set.
 *
 * Append-only design (boss-greenlit 2026-05-15): every price change is a
 * new row. There is no update path at the service layer; the absence of
 * UPDATE/DELETE RLS policies on the table enforces this for non-bypass
 * roles. Audit-of-truth + the PR-C audit-table-as-view-over-supersession
 * both rest on this invariant.
 */

import type postgres from 'postgres';

export type PricingMode = 'percentage' | 'absolute_per_seat';

export interface ResellerPricingConfig {
  id: string;
  resellerOrgId: string;
  subtenantOrgId: string;
  mode: PricingMode;
  /** Basis points (5% = 500). Populated when mode='percentage'. */
  rateBasisPoints: number | null;
  /** Cents. Populated when mode='absolute_per_seat'. USD only in v1. */
  amountCents: number | null;
  currency: 'USD';
  effectiveAt: string;
  /**
   * The reseller-admin user_id who set this price. Reads via
   * `reseller_pricing_config_view` (mig 026) nullify this column for
   * non-reseller-admin callers (Aaron 2026-05-15 lock: subtenant cannot
   * see who set their price). Reseller-admin callers see the real value.
   */
  createdBy: string | null;
  createdAt: string;
}

export interface SetPricingPercentageInput {
  id: string;
  resellerOrgId: string;
  subtenantOrgId: string;
  mode: 'percentage';
  rateBasisPoints: number;
  createdBy: string;
}

export interface SetPricingAbsoluteInput {
  id: string;
  resellerOrgId: string;
  subtenantOrgId: string;
  mode: 'absolute_per_seat';
  amountCents: number;
  createdBy: string;
}

export type SetPricingInput = SetPricingPercentageInput | SetPricingAbsoluteInput;

interface PricingRow {
  id: string;
  reseller_org_id: string;
  subtenant_org_id: string;
  mode: string;
  rate_basis_points: number | null;
  amount_cents: number | null;
  currency: string;
  effective_at: Date | string;
  created_by: string | null;
  created_at: Date | string;
}

function isPricingMode(value: string): value is PricingMode {
  return value === 'percentage' || value === 'absolute_per_seat';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToConfig(row: PricingRow): ResellerPricingConfig {
  if (!isPricingMode(row.mode)) {
    throw new Error(`reseller_pricing_config row ${row.id} has unknown mode '${row.mode}'`);
  }
  if (row.currency !== 'USD') {
    throw new Error(`reseller_pricing_config row ${row.id} has unsupported currency '${row.currency}'`);
  }
  return {
    id: row.id,
    resellerOrgId: row.reseller_org_id,
    subtenantOrgId: row.subtenant_org_id,
    mode: row.mode,
    rateBasisPoints: row.rate_basis_points,
    amountCents: row.amount_cents,
    currency: row.currency,
    effectiveAt: toIso(row.effective_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

export class ResellerPricingService {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * Insert a new pricing-config row. RLS gates the INSERT by the caller's
   * reseller-admin authority over `subtenantOrgId`; the structural trigger
   * additionally rejects writes where `resellerOrgId` is not the
   * subtenant's ancestor or is not type='reseller'. Either check failing
   * raises through postgres-js as a query error.
   */
  async setPricing(input: SetPricingInput): Promise<ResellerPricingConfig> {
    const rateBp = input.mode === 'percentage' ? input.rateBasisPoints : null;
    const amountCents = input.mode === 'absolute_per_seat' ? input.amountCents : null;

    const [row] = await this.sql<PricingRow[]>`
      INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency,
        created_by
      ) VALUES (
        ${input.id}, ${input.resellerOrgId}, ${input.subtenantOrgId}, ${input.mode},
        ${rateBp}, ${amountCents}, 'USD',
        ${input.createdBy}
      )
      RETURNING id, reseller_org_id, subtenant_org_id, mode,
                rate_basis_points, amount_cents, currency,
                effective_at, created_by, created_at
    `;

    return rowToConfig(row);
  }

  /**
   * Return the latest effective config row for `(resellerOrgId,
   * subtenantOrgId)`, or null if none exists.
   *
   * Reads from `reseller_pricing_config_view` (mig 026), not the base
   * table. The view inherits the base SELECT policy's row-gating
   * (subtenant sees only their latest-effective row; reseller-admin
   * sees full history) AND applies CASE column-projection so subtenant
   * callers see `created_by = NULL`. Reading through the view lets the
   * service stay schema-shape-agnostic about which caller-class is
   * asking — the policy + view handle differentiation.
   *
   * Ordering on `effective_at DESC, created_at DESC` resolves the
   * supersession winner deterministically even on same-millisecond
   * inserts. For subtenant callers the NOT-EXISTS filter in the base
   * policy already collapses the result to a single row, so the
   * ORDER BY + LIMIT is load-bearing only for reseller-admin reads.
   */
  async getCurrentPricing(
    resellerOrgId: string,
    subtenantOrgId: string,
  ): Promise<ResellerPricingConfig | null> {
    const rows = await this.sql<PricingRow[]>`
      SELECT id, reseller_org_id, subtenant_org_id, mode,
             rate_basis_points, amount_cents, currency,
             effective_at, created_by, created_at
        FROM reseller_pricing_config_view
       WHERE reseller_org_id  = ${resellerOrgId}
         AND subtenant_org_id = ${subtenantOrgId}
       ORDER BY effective_at DESC, created_at DESC
       LIMIT 1
    `;

    return rows.length > 0 ? rowToConfig(rows[0]) : null;
  }
}
