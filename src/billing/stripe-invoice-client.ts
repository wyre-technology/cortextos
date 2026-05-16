/**
 * StripeSdkInvoiceClient — the real Stripe-SDK adapter implementing the
 * StripeInvoiceClient interface that ResellerInvoiceService (surface-3)
 * depends on.
 *
 * The service depends on the interface, not this class — surface-3 tests
 * use a fake; production wires this adapter. Keeping the adapter as a
 * separate construction unit means the SDK-specific code is isolated and
 * independently testable against a mocked Stripe SDK.
 *
 * Idempotency: every create-style call forwards a caller-supplied
 * idempotency-key as the Stripe `{ idempotencyKey }` request option.
 * Stripe replays the original response for a repeated key (24h window),
 * which is what makes ResellerInvoiceService.finalizeInvoice's outbox
 * orphan-recovery retry-safe.
 *
 * β-lock (Aaron 2026-05-15): invoices are created with
 * collection_method='charge_automatically' (cards-only, MSP card-on-file)
 * and auto_advance=false (the service controls finalization explicitly).
 */

import type Stripe from 'stripe';
import type {
  StripeInvoiceClient,
} from './reseller-invoice-service.js';

export class StripeSdkInvoiceClient implements StripeInvoiceClient {
  constructor(private readonly stripe: Stripe) {}

  /**
   * Ensure a Stripe Customer exists for the MSP. Looks up by the
   * `org_id` metadata key; creates one if absent. The idempotency-key
   * guards the create against a double-create on retry.
   *
   * Note: customers.search is eventually-consistent (~seconds of index
   * lag). A retry seconds after a create can search-miss the
   * just-created customer and fall through to a fresh create — but the
   * idempotency-key (stripe-customer-{mspOrgId}) makes that second
   * create REPLAY the original customer, not duplicate it. The
   * search-miss-on-retry is therefore intentionally safe; do not
   * "fix" the harmless race by adding a wait/poll.
   */
  async ensureCustomer(
    input: { mspOrgId: string; email: string; name: string },
    idempotencyKey: string,
  ): Promise<{ customerId: string }> {
    const existing = await this.stripe.customers.search({
      query: `metadata['org_id']:'${input.mspOrgId}'`,
      limit: 1,
    });
    if (existing.data.length > 0) {
      return { customerId: existing.data[0].id };
    }

    const created = await this.stripe.customers.create(
      {
        email: input.email,
        name: input.name,
        metadata: { org_id: input.mspOrgId },
      },
      { idempotencyKey },
    );
    return { customerId: created.id };
  }

  async createInvoice(
    input: { customerId: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ stripeInvoiceId: string }> {
    const invoice = await this.stripe.invoices.create(
      {
        customer: input.customerId,
        collection_method: 'charge_automatically',
        auto_advance: false,
        currency: 'usd',
        metadata: input.metadata,
      },
      { idempotencyKey },
    );
    return { stripeInvoiceId: invoice.id };
  }

  async addInvoiceItem(
    input: {
      customerId: string;
      stripeInvoiceId: string;
      amountCents: number;
      currency: string;
      description: string;
    },
    idempotencyKey: string,
  ): Promise<void> {
    await this.stripe.invoiceItems.create(
      {
        customer: input.customerId,
        invoice: input.stripeInvoiceId,
        amount: input.amountCents,
        currency: input.currency,
        description: input.description,
      },
      { idempotencyKey },
    );
  }

  async finalizeInvoice(stripeInvoiceId: string): Promise<{ status: string }> {
    const invoice = await this.stripe.invoices.finalizeInvoice(stripeInvoiceId, {
      auto_advance: true,
    });
    return { status: invoice.status ?? 'open' };
  }

  /**
   * Retrieve a Stripe Invoice. Returns null when the invoice does not
   * resolve (Stripe `resource_missing` 404) — that null is the signal
   * the service's recovery branch uses to clear a stale outbox marker.
   */
  async retrieveInvoice(stripeInvoiceId: string): Promise<{ status: string } | null> {
    try {
      const invoice = await this.stripe.invoices.retrieve(stripeInvoiceId);
      return { status: invoice.status ?? 'draft' };
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'resource_missing'
      ) {
        return null;
      }
      throw err;
    }
  }

  async voidInvoice(stripeInvoiceId: string): Promise<void> {
    await this.stripe.invoices.voidInvoice(stripeInvoiceId);
  }

  /**
   * Delete a still-draft invoice. Stripe `del` only succeeds on drafts;
   * a non-draft invoice raises. finalizeInvoice no longer calls this
   * (the outbox marker supersedes delete-rollback); it remains for a
   * future reconciliation-cleanup utility.
   */
  async deleteDraftInvoice(stripeInvoiceId: string): Promise<void> {
    await this.stripe.invoices.del(stripeInvoiceId);
  }
}
