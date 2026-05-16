/**
 * ResellerInvoiceService — markup-application + draft invoice generation
 * for Track C reseller-channel-billing (Aaron 2026-05-15: wholesale-
 * collection model).
 *
 * Wholesale model: WYRE invoices the MSP for SUM(base_rate_cents) — what
 * WYRE actually charges. markup_applied_cents + final_rate_cents stay
 * stored on line_items as MSP-reference / audit-trail-as-explicit-pointer
 * so the MSP can prove what they billed off-platform without reconstruction.
 *
 * Surface-2 produces DRAFT invoices only. Surface-3 will finalize via the
 * Stripe Invoices API and transition status from 'draft' → 'open'.
 *
 * Discipline:
 *   - DP-K gate at entry (canAccessPaidFeatures) — MSP must be on Pro
 *     plan; otherwise NOT_ELIGIBLE.
 *   - Fail-fast on missing reseller_pricing_config — silent under-billing
 *     is the worst-class failure-mode (Walter Q2). Validation happens
 *     BEFORE BEGIN so partial-invoice state is structurally impossible.
 *   - Skip-zero-usage (DP-J): subtenants with zero usage in the period
 *     produce no line item.
 *   - Single rounding-point (Walter Area 3): compute-final-then-derive
 *     markup_applied = final - base. Avoids dual-rounding-error class.
 *   - Transaction wraps only DB writes (Walter Q1). Usage reads + pricing
 *     lookups happen outside BEGIN so external/expensive operations don't
 *     extend lock duration.
 *   - Idempotency via UNIQUE(msp_org_id, period_start) at schema layer —
 *     a duplicate-period call throws on the header INSERT; the transaction
 *     rolls back cleanly. Caller decides whether to void-and-recreate.
 */

import { getSql, type Sql } from '../db/context.js';
import type { ResellerPricingService, ResellerPricingConfig } from './reseller-pricing-service.js';
import type { BillingGate } from './gate.js';
import type { OrgService } from '../org/org-service.js';

export type ResellerInvoiceStatus =
  | 'draft'
  | 'open'
  | 'paid'
  | 'past_due'
  | 'uncollectible'
  | 'void';

export interface ResellerInvoice {
  id: string;
  mspOrgId: string;
  periodStart: string;
  periodEnd: string;
  status: ResellerInvoiceStatus;
  amountCents: number;
  currency: 'USD';
  stripeInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResellerInvoiceLineItem {
  id: string;
  invoiceId: string;
  subtenantOrgId: string;
  usageUnits: number;
  baseRateCents: number;
  markupAppliedCents: number;
  finalRateCents: number;
  sourceSubscriptionId: string | null;
  appliedPricingConfigId: string | null;
  createdAt: string;
}

export interface GenerateInvoiceInput {
  /** Caller-supplied id (services do not auto-generate UUIDs here). */
  id: string;
  /** Caller-supplied id stem for line items; service appends `-{n}`. */
  lineItemIdPrefix: string;
  mspOrgId: string;
  periodStart: Date;
  periodEnd: Date;
}

export type ResellerInvoiceErrorCode =
  | 'NOT_ELIGIBLE'
  | 'PRICING_NOT_CONFIGURED'
  | 'INVALID_PERIOD'
  | 'INVALID_STATE'
  | 'STRIPE_API_ERROR'
  | 'DB_ERROR'
  | 'MSP_MISSING_EMAIL';

export class ResellerInvoiceError extends Error {
  readonly code: ResellerInvoiceErrorCode;
  readonly meta: Record<string, unknown>;
  constructor(code: ResellerInvoiceErrorCode, message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ResellerInvoiceError';
    this.code = code;
    this.meta = meta;
  }
}

/**
 * Hook for fetching a subtenant's usage_units in the given period. Default
 * implementation reads SUM(credits_used) from credit_ledger; injectable so
 * tests can stub deterministic usage without seeding ledger rows.
 */
export interface UsageSource {
  fetchUsageUnits(subtenantOrgId: string, periodStart: Date, periodEnd: Date): Promise<number>;
}

/**
 * Default UsageSource: SUM(credit_ledger.credits_used) per subtenant per
 * period. Point-in-time snapshot, intentionally NOT transactionally
 * consistent with invoice write — the read happens outside BEGIN so it
 * doesn't extend lock duration over the credit_ledger table.
 */
export class CreditLedgerUsageSource implements UsageSource {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  async fetchUsageUnits(
    subtenantOrgId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const [row] = await this.sql<{ total: number | null }[]>`
      SELECT COALESCE(SUM(credits_used), 0)::INT AS total
        FROM credit_ledger
       WHERE org_id = ${subtenantOrgId}
         AND recorded_at >= ${periodStart}
         AND recorded_at <  ${periodEnd}
    `;
    return row?.total ?? 0;
  }
}

/**
 * Hook for resolving a subtenant's WYRE base-rate-per-usage-unit in cents.
 * v1 wholesale model: the base rate is the per-credit charge WYRE would
 * invoice the MSP for. Pulled from app config or a small lookup table.
 * Injectable so tests can drive arithmetic deterministically and the
 * source can later swap to a Stripe-mirroring strategy without service
 * changes.
 */
export interface BaseRateSource {
  fetchBaseRatePerUnitCents(subtenantOrgId: string): Promise<number>;
}

/**
 * Hook for resolving an MSP's billing contact (Stripe Customer email +
 * display name). Injectable so tests don't need a real org-owner lookup.
 * The default implementation reads the org owner's email from the users
 * table joined through organizations.owner_id.
 */
export interface MspContactSource {
  fetchMspContact(mspOrgId: string): Promise<{ email: string; name: string } | null>;
}

/**
 * Thin abstraction over the Stripe Invoices API. The service depends on
 * this interface rather than the Stripe SDK directly so that:
 *   - surface-3 tests mock it without network or Stripe-test-mode keys
 *   - the real adapter (a Stripe SDK wrapper) lands as a separate
 *     construction unit and can be swapped without service changes
 *
 * Every create-style call takes an idempotencyKey — deterministic,
 * derived from our domain identifiers (idempotency-key-from-domain-
 * identifier). Stripe replays the prior response for a repeated key,
 * which is what makes the (a)-implicit-marker orphan-recovery in
 * finalizeInvoice retry-safe.
 */
export interface StripeInvoiceClient {
  /** Ensure a Stripe Customer exists for the MSP; returns the customer id. */
  ensureCustomer(
    input: { mspOrgId: string; email: string; name: string },
    idempotencyKey: string,
  ): Promise<{ customerId: string }>;

  /** Create a draft Stripe Invoice for the customer; returns the invoice id. */
  createInvoice(
    input: { customerId: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ stripeInvoiceId: string }>;

  /** Attach a single-amount line item to a draft Stripe Invoice. */
  addInvoiceItem(
    input: {
      customerId: string;
      stripeInvoiceId: string;
      amountCents: number;
      currency: string;
      description: string;
    },
    idempotencyKey: string,
  ): Promise<void>;

  /** Finalize a draft invoice; Stripe transitions it to 'open' + auto-charges. */
  finalizeInvoice(stripeInvoiceId: string): Promise<{ status: string }>;

  /** Retrieve an existing Stripe Invoice (orphan-recovery path). */
  retrieveInvoice(stripeInvoiceId: string): Promise<{ status: string } | null>;

  /** Void a finalized invoice (Stripe-side). */
  voidInvoice(stripeInvoiceId: string): Promise<void>;

  /** Delete a still-draft invoice (rollback path; fails on non-draft). */
  deleteDraftInvoice(stripeInvoiceId: string): Promise<void>;
}

interface InvoiceRow {
  id: string;
  msp_org_id: string;
  period_start: Date | string;
  period_end: Date | string;
  status: string;
  amount_cents: number;
  currency: string;
  stripe_invoice_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LineItemRow {
  id: string;
  invoice_id: string;
  subtenant_org_id: string;
  usage_units: number;
  base_rate_cents: number;
  markup_applied_cents: number;
  final_rate_cents: number;
  source_subscription_id: string | null;
  applied_pricing_config_id: string | null;
  created_at: Date | string;
}

const INVOICE_STATUSES: readonly ResellerInvoiceStatus[] = [
  'draft', 'open', 'paid', 'past_due', 'uncollectible', 'void',
];

function isInvoiceStatus(value: string): value is ResellerInvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToInvoice(row: InvoiceRow): ResellerInvoice {
  if (!isInvoiceStatus(row.status)) {
    throw new Error(`reseller_invoices row ${row.id} has unknown status '${row.status}'`);
  }
  if (row.currency !== 'USD') {
    throw new Error(`reseller_invoices row ${row.id} has unsupported currency '${row.currency}'`);
  }
  return {
    id: row.id,
    mspOrgId: row.msp_org_id,
    periodStart: toIso(row.period_start),
    periodEnd: toIso(row.period_end),
    status: row.status,
    amountCents: row.amount_cents,
    currency: row.currency,
    stripeInvoiceId: row.stripe_invoice_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToLineItem(row: LineItemRow): ResellerInvoiceLineItem {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    subtenantOrgId: row.subtenant_org_id,
    usageUnits: row.usage_units,
    baseRateCents: row.base_rate_cents,
    markupAppliedCents: row.markup_applied_cents,
    finalRateCents: row.final_rate_cents,
    sourceSubscriptionId: row.source_subscription_id,
    appliedPricingConfigId: row.applied_pricing_config_id,
    createdAt: toIso(row.created_at),
  };
}

interface PlannedLineItem {
  id: string;
  subtenantOrgId: string;
  usageUnits: number;
  baseRateCents: number;
  markupAppliedCents: number;
  finalRateCents: number;
  sourceSubscriptionId: string | null;
  appliedPricingConfigId: string;
}

/**
 * Half-to-even (banker's) rounding for non-negative cents amounts.
 *
 * IEEE 754 / GAAP-conservative default for financial rounding. Eliminates
 * the systematic-bias attack-surface of half-away-from-zero (JavaScript
 * Math.round semantics for positives) where every exact-tie consistently
 * rounds in WYRE's favor — at scale that compounds to real money plus a
 * fairness-perception attack-surface.
 *
 * Aaron-locked 2026-05-15. Walter pair-review YELLOW Area 3.
 *
 * Domain assumption: inputs are >= 0. Negative-rounding semantics are
 * deliberately undefined here — the line-item arithmetic CHECK constraint
 * (final, base, markup all >= 0) means we never see negatives at this
 * call site, and overcommitting to a negative-rounding shape now would
 * lock a choice we don't need to make.
 *
 * Tie-detection precondition: callers must pass exactly-representable
 * IEEE 754 values for ties to be detected reliably. applyMarkup's
 * percentage compute satisfies this — `(baseCents * (10000 + bp)) /
 * 10000` is an integer divided by 10000 (an exact power-of-10 multiple),
 * which produces an exactly-representable double for tie cases like
 * `4.5` or `10.5`. Future callers that pre-sum floats (e.g. `0.1 + 0.2`
 * = `0.30000000000000004`) will miss the tie and round per the
 * non-tie branch. Document the source-shape if adding a new callsite.
 */
export function roundHalfToEven(value: number): number {
  if (value < 0) {
    throw new Error(`roundHalfToEven: negative input ${value} is out of domain`);
  }
  const floorValue = Math.floor(value);
  const remainder = value - floorValue;
  if (remainder < 0.5) return floorValue;
  if (remainder > 0.5) return floorValue + 1;
  // Exact tie: round to nearest even integer.
  return floorValue % 2 === 0 ? floorValue : floorValue + 1;
}

/**
 * Apply a pricing config to a base amount. Single rounding-point: compute
 * final first, derive markup = final - base. Avoids dual-rounding-error
 * class where (markup-then-add) and (add-then-derive-markup) can yield
 * different final values that break the CHECK final = base + markup.
 *
 * Rounding strategy: half-to-even (banker) via roundHalfToEven. See its
 * docblock for the fairness rationale.
 */
export function applyMarkup(
  baseCents: number,
  config: ResellerPricingConfig,
): { finalCents: number; markupCents: number } {
  if (config.mode === 'percentage') {
    if (config.rateBasisPoints === null) {
      throw new Error(`pricing config ${config.id} is percentage mode but rate_basis_points is null`);
    }
    const finalCents = roundHalfToEven((baseCents * (10000 + config.rateBasisPoints)) / 10000);
    return { finalCents, markupCents: finalCents - baseCents };
  }

  if (config.amountCents === null) {
    throw new Error(`pricing config ${config.id} is absolute_per_seat mode but amount_cents is null`);
  }
  const finalCents = baseCents + config.amountCents;
  return { finalCents, markupCents: finalCents - baseCents };
}

export class ResellerInvoiceService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  constructor(
    private readonly pricingService: ResellerPricingService,
    private readonly billingGate: BillingGate,
    private readonly orgService: OrgService,
    private readonly usageSource: UsageSource,
    private readonly baseRateSource: BaseRateSource,
    private readonly stripeClient: StripeInvoiceClient,
    private readonly mspContactSource: MspContactSource,
  ) {}

  /**
   * Generate a draft invoice for an MSP for the given billing period.
   *
   * Wholesale model: header.amount_cents = SUM(base_rate_cents) on line
   * items. markup_applied + final_rate stay on line items as MSP-reference
   * data; they do not flow into the WYRE→MSP charge.
   *
   * Flow:
   *   1. DP-K gate (canAccessPaidFeatures).
   *   2. Period validation.
   *   3. Subtenant enumeration (orgService.getCustomersOfReseller).
   *   4. Per-subtenant: fetch usage + pricing-config + base-rate; compute
   *      line-item shape. SKIP zero-usage (DP-J). FAIL-FAST on missing
   *      pricing-config (Walter Q2). All reads outside BEGIN.
   *   5. Transaction:
   *      a. INSERT reseller_invoices header (status='draft', amount_cents=0)
   *      b. INSERT all line_items (single batched insert)
   *      c. UPDATE header.amount_cents = SUM(base_rate_cents)
   *   6. Return invoice + line items.
   */
  async generateInvoice(input: GenerateInvoiceInput): Promise<{
    invoice: ResellerInvoice;
    lineItems: ResellerInvoiceLineItem[];
  }> {
    if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
      throw new ResellerInvoiceError(
        'INVALID_PERIOD',
        'periodEnd must be after periodStart',
        { periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() },
      );
    }

    if (!(await this.billingGate.canAccessPaidFeatures(input.mspOrgId))) {
      throw new ResellerInvoiceError(
        'NOT_ELIGIBLE',
        'MSP must be on a Pro plan to use reseller-channel-billing',
        { mspOrgId: input.mspOrgId },
      );
    }

    const subtenants = await this.orgService.getCustomersOfReseller(input.mspOrgId);

    // Plan the full line-item set BEFORE opening the transaction. Validation
    // failures here mean nothing has been written yet — partial-invoice is
    // structurally impossible.
    const planned: PlannedLineItem[] = [];
    let nextIdx = 1;

    for (const subtenant of subtenants) {
      const usageUnits = await this.usageSource.fetchUsageUnits(
        subtenant.id,
        input.periodStart,
        input.periodEnd,
      );
      if (usageUnits <= 0) continue; // DP-J skip-zero-usage

      const pricing = await this.pricingService.getCurrentPricing(input.mspOrgId, subtenant.id);
      if (!pricing) {
        throw new ResellerInvoiceError(
          'PRICING_NOT_CONFIGURED',
          `subtenant ${subtenant.id} has no reseller_pricing_config for MSP ${input.mspOrgId}; aborting invoice`,
          { mspOrgId: input.mspOrgId, subtenantOrgId: subtenant.id },
        );
      }

      const perUnitCents = await this.baseRateSource.fetchBaseRatePerUnitCents(subtenant.id);
      const baseRateCents = perUnitCents * usageUnits;
      const { finalCents, markupCents } = applyMarkup(baseRateCents, pricing);

      planned.push({
        id: `${input.lineItemIdPrefix}-${nextIdx++}`,
        subtenantOrgId: subtenant.id,
        usageUnits,
        baseRateCents,
        markupAppliedCents: markupCents,
        finalRateCents: finalCents,
        sourceSubscriptionId: null,
        appliedPricingConfigId: pricing.id,
      });
    }

    // Wholesale: WYRE collects base_rate, not final_rate. markup stays
    // stored on line items as MSP-reference / audit-trail-as-explicit-pointer.
    const wholesaleTotalCents = planned.reduce((acc, li) => acc + li.baseRateCents, 0);

    const { invoice, lineItems } = await this.sql.begin(async (tx) => {
      const [headerRow] = await tx<InvoiceRow[]>`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end, status, amount_cents)
        VALUES (${input.id}, ${input.mspOrgId}, ${input.periodStart}, ${input.periodEnd}, 'draft', 0)
        RETURNING id, msp_org_id, period_start, period_end, status,
                  amount_cents, currency, stripe_invoice_id, created_at, updated_at
      `;

      const insertedLineItems: LineItemRow[] = [];
      for (const li of planned) {
        const [row] = await tx<LineItemRow[]>`
          INSERT INTO reseller_invoice_line_items (
            id, invoice_id, subtenant_org_id, usage_units,
            base_rate_cents, markup_applied_cents, final_rate_cents,
            source_subscription_id, applied_pricing_config_id
          ) VALUES (
            ${li.id}, ${headerRow.id}, ${li.subtenantOrgId}, ${li.usageUnits},
            ${li.baseRateCents}, ${li.markupAppliedCents}, ${li.finalRateCents},
            ${li.sourceSubscriptionId}, ${li.appliedPricingConfigId}
          )
          RETURNING id, invoice_id, subtenant_org_id, usage_units,
                    base_rate_cents, markup_applied_cents, final_rate_cents,
                    source_subscription_id, applied_pricing_config_id, created_at
        `;
        insertedLineItems.push(row);
      }

      const [updatedHeader] = await tx<InvoiceRow[]>`
        UPDATE reseller_invoices
           SET amount_cents = ${wholesaleTotalCents}
         WHERE id = ${headerRow.id}
        RETURNING id, msp_org_id, period_start, period_end, status,
                  amount_cents, currency, stripe_invoice_id, created_at, updated_at
      `;

      return { invoice: updatedHeader, lineItems: insertedLineItems };
    });

    return {
      invoice: rowToInvoice(invoice),
      lineItems: lineItems.map(rowToLineItem),
    };
  }

  async getInvoice(invoiceId: string): Promise<ResellerInvoice | null> {
    const rows = await this.sql<InvoiceRow[]>`
      SELECT id, msp_org_id, period_start, period_end, status,
             amount_cents, currency, stripe_invoice_id, created_at, updated_at
        FROM reseller_invoices
       WHERE id = ${invoiceId}
    `;
    return rows.length > 0 ? rowToInvoice(rows[0]) : null;
  }

  async listInvoicesForMsp(mspOrgId: string): Promise<ResellerInvoice[]> {
    const rows = await this.sql<InvoiceRow[]>`
      SELECT id, msp_org_id, period_start, period_end, status,
             amount_cents, currency, stripe_invoice_id, created_at, updated_at
        FROM reseller_invoices
       WHERE msp_org_id = ${mspOrgId}
       ORDER BY period_start DESC
    `;
    return rows.map(rowToInvoice);
  }

  async getLineItems(invoiceId: string): Promise<ResellerInvoiceLineItem[]> {
    const rows = await this.sql<LineItemRow[]>`
      SELECT id, invoice_id, subtenant_org_id, usage_units,
             base_rate_cents, markup_applied_cents, final_rate_cents,
             source_subscription_id, applied_pricing_config_id, created_at
        FROM reseller_invoice_line_items
       WHERE invoice_id = ${invoiceId}
       ORDER BY created_at
    `;
    return rows.map(rowToLineItem);
  }

  /**
   * Finalize a draft invoice through the Stripe Invoices API and
   * transition it draft → open.
   *
   * Retry-safe via a GENUINE outbox pattern (the reseller_invoices row
   * IS the outbox entry). The outbox marker — stripe_invoice_id written
   * to the DB while status is still 'draft' — is written MID-FLIGHT,
   * immediately after Stripe createInvoice returns. Without that
   * mid-flight write the marker state is never produced by the
   * write-path and the recovery branch is unreachable in production
   * (Walter PR-B surface-3 AREA 5).
   *
   * State machine on (status, stripe_invoice_id):
   *   - status='open'                       → already finalized, no-op
   *   - status='draft', stripe_invoice_id   → outbox marker present; a
   *     prior attempt got past createInvoice. Recover by inspecting the
   *     remote Stripe status:
   *       remote open|paid  → DB catch-up (markInvoiceOpen)
   *       remote draft      → resume add-items + finalize (idempotency-
   *                           keyed re-adds are safe; covers a mid-loop
   *                           addInvoiceItem crash)
   *       remote void|uncoll→ INVALID_STATE (terminal remote; do not
   *                           reopen)
   *       remote missing    → stale id; clear marker, fall to fresh
   *   - status='draft', no stripe_invoice_id → fresh: ensure Customer →
   *     createInvoice → WRITE MARKER → add items → finalize.
   *
   * Every Stripe create-call carries a deterministic idempotency-key, so
   * the gap between createInvoice-succeeded and marker-written is itself
   * recoverable: a retry's fresh path re-calls createInvoice with the
   * same key, Stripe replays the original invoice, the marker write is
   * retried. No deleteDraftInvoice rollback — the outbox marker makes
   * every failure recoverable-by-retry; deleting the orphan would throw
   * away a resumable invoice (the marker and a delete-rollback are
   * contradictory dispositions of the same Stripe object).
   */
  async finalizeInvoice(invoiceId: string): Promise<ResellerInvoice> {
    const existing = await this.getInvoice(invoiceId);
    if (!existing) {
      throw new ResellerInvoiceError(
        'INVALID_STATE',
        `invoice ${invoiceId} does not exist`,
        { invoiceId },
      );
    }

    // Idempotent no-op: already finalized.
    if (existing.status === 'open') return existing;

    if (existing.status !== 'draft') {
      throw new ResellerInvoiceError(
        'INVALID_STATE',
        `invoice ${invoiceId} is '${existing.status}'; only 'draft' invoices can be finalized`,
        { invoiceId, status: existing.status },
      );
    }

    // Outbox-recovery branch: a marker is present. Inspect remote status.
    let stripeInvoiceId: string | null = existing.stripeInvoiceId;
    if (stripeInvoiceId) {
      const remote = await this.stripeClient.retrieveInvoice(stripeInvoiceId);
      if (!remote) {
        // Stale marker — the Stripe invoice no longer resolves. Clear it
        // and fall through to the fresh path.
        await this.sql`
          UPDATE reseller_invoices SET stripe_invoice_id = NULL WHERE id = ${invoiceId}
        `;
        stripeInvoiceId = null;
      } else if (remote.status === 'open' || remote.status === 'paid') {
        // Stripe already finalized — a prior attempt's DB UPDATE didn't
        // land. Catch the DB up; nothing else to do.
        return this.markInvoiceOpen(invoiceId, stripeInvoiceId);
      } else if (remote.status === 'void' || remote.status === 'uncollectible') {
        throw new ResellerInvoiceError(
          'INVALID_STATE',
          `invoice ${invoiceId}'s Stripe invoice is '${remote.status}'; cannot finalize a terminal remote`,
          { invoiceId, remoteStatus: remote.status },
        );
      }
      // remote.status === 'draft' → stripeInvoiceId stays set; fall
      // through to resume the add-items + finalize sequence.
    }

    const contact = await this.mspContactSource.fetchMspContact(existing.mspOrgId);
    if (!contact?.email) {
      throw new ResellerInvoiceError(
        'MSP_MISSING_EMAIL',
        `MSP ${existing.mspOrgId} has no billing-contact email; cannot create a Stripe Customer`,
        { mspOrgId: existing.mspOrgId },
      );
    }

    const lineItems = await this.getLineItems(invoiceId);

    try {
      const { customerId } = await this.stripeClient.ensureCustomer(
        { mspOrgId: existing.mspOrgId, email: contact.email, name: contact.name },
        `stripe-customer-${existing.mspOrgId}`,
      );

      // Create the Stripe invoice only if we don't already have one
      // (draft-recovery reuses the existing id). Idempotency-key makes a
      // repeated create after a marker-write failure replay the same id.
      if (!stripeInvoiceId) {
        const created = await this.stripeClient.createInvoice(
          {
            customerId,
            metadata: {
              reseller_invoice_id: invoiceId,
              period_start: existing.periodStart,
              period_end: existing.periodEnd,
            },
          },
          `stripe-invoice-${invoiceId}`,
        );
        stripeInvoiceId = created.stripeInvoiceId;

        // OUTBOX MARKER: persist the Stripe id with status still 'draft'
        // BEFORE adding items / finalizing. A crash anywhere past this
        // point leaves the row in the recoverable marker state.
        //
        // Narrowed try/catch: a failure of THIS UPDATE is an
        // infrastructure (DB) failure, not a Stripe failure — it gets
        // the DB_ERROR code so the error-code is an accurate
        // failure-origin claim. Recovery still works: the createInvoice
        // idempotency-key means a retry's fresh path replays the same
        // Stripe invoice, and the marker write is retried.
        try {
          await this.sql`
            UPDATE reseller_invoices
               SET stripe_invoice_id = ${stripeInvoiceId}
             WHERE id = ${invoiceId}
          `;
        } catch (dbErr) {
          throw new ResellerInvoiceError(
            'DB_ERROR',
            `outbox-marker write failed for invoice ${invoiceId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
            { invoiceId },
          );
        }
      }

      // Add items (idempotency-keyed — re-adds on a draft-recovery resume
      // are safe; Stripe dedups by key). Covers the mid-loop-crash case.
      for (const li of lineItems) {
        await this.stripeClient.addInvoiceItem(
          {
            customerId,
            stripeInvoiceId,
            // Wholesale: WYRE collects base_rate_cents, not final_rate_cents.
            amountCents: li.baseRateCents,
            currency: 'usd',
            description: `Wholesale usage — subtenant ${li.subtenantOrgId} (${li.usageUnits} units)`,
          },
          `stripe-invoice-item-${li.id}`,
        );
      }

      await this.stripeClient.finalizeInvoice(stripeInvoiceId);
    } catch (err) {
      // No rollback-delete: the outbox marker (if written) makes this
      // recoverable on retry. Throw; the marker carries recovery.
      throw new ResellerInvoiceError(
        'STRIPE_API_ERROR',
        `Stripe finalize failed for invoice ${invoiceId}: ${err instanceof Error ? err.message : String(err)}`,
        { invoiceId },
      );
    }

    return this.markInvoiceOpen(invoiceId, stripeInvoiceId);
  }

  /**
   * Persist stripe_invoice_id + status='open' for a finalized invoice.
   * Single-statement UPDATE; safe to re-run (idempotent on already-open
   * rows because the WHERE still matches and the SET is a fixed point).
   */
  private async markInvoiceOpen(invoiceId: string, stripeInvoiceId: string): Promise<ResellerInvoice> {
    const [row] = await this.sql<InvoiceRow[]>`
      UPDATE reseller_invoices
         SET stripe_invoice_id = ${stripeInvoiceId},
             status            = 'open'
       WHERE id = ${invoiceId}
      RETURNING id, msp_org_id, period_start, period_end, status,
                amount_cents, currency, stripe_invoice_id, created_at, updated_at
    `;
    return rowToInvoice(row);
  }

  /**
   * Void an invoice. Voids the Stripe-side invoice (if one exists) then
   * transitions the DB row to status='void'. Line items are preserved —
   * voiding is a status transition, not a delete; the line-item history
   * stays as audit-of-truth.
   *
   * Rejects already-paid invoices: a paid invoice cannot be voided
   * (Stripe semantics + WYRE wouldn't want to drop a collected charge).
   */
  async voidInvoice(invoiceId: string, reason: string): Promise<ResellerInvoice> {
    const existing = await this.getInvoice(invoiceId);
    if (!existing) {
      throw new ResellerInvoiceError(
        'INVALID_STATE',
        `invoice ${invoiceId} does not exist`,
        { invoiceId },
      );
    }

    if (existing.status === 'void') return existing; // idempotent no-op

    if (existing.status === 'paid') {
      throw new ResellerInvoiceError(
        'INVALID_STATE',
        `invoice ${invoiceId} is 'paid'; paid invoices cannot be voided`,
        { invoiceId, status: existing.status },
      );
    }

    if (existing.stripeInvoiceId) {
      try {
        await this.stripeClient.voidInvoice(existing.stripeInvoiceId);
      } catch (err) {
        throw new ResellerInvoiceError(
          'STRIPE_API_ERROR',
          `Stripe void failed for invoice ${invoiceId}: ${err instanceof Error ? err.message : String(err)}`,
          { invoiceId },
        );
      }
    }

    const [row] = await this.sql<InvoiceRow[]>`
      UPDATE reseller_invoices
         SET status = 'void'
       WHERE id = ${invoiceId}
      RETURNING id, msp_org_id, period_start, period_end, status,
                amount_cents, currency, stripe_invoice_id, created_at, updated_at
    `;
    void reason; // accepted for caller-side audit logging; not persisted in v1
    return rowToInvoice(row);
  }
}
