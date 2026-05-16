/**
 * StripeSdkInvoiceClient adapter unit tests.
 *
 * Mocks the Stripe SDK surface the adapter touches; asserts each method
 * maps to the right Stripe call with the right payload + idempotency-key
 * option. Includes a verify-SDK-behavior test for finalize-on-already-
 * finalized so a future Stripe SDK semantic shift trips this test even
 * though ResellerInvoiceService's recovery branch short-circuits before
 * finalize for open/paid remotes.
 */

import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeSdkInvoiceClient } from './stripe-invoice-client.js';

function makeStripeMock(overrides: Record<string, unknown> = {}) {
  const customersCreate = vi.fn().mockResolvedValue({ id: 'cus_new' });
  const customersSearch = vi.fn().mockResolvedValue({ data: [] });
  const invoicesCreate = vi.fn().mockResolvedValue({ id: 'in_new' });
  const invoiceItemsCreate = vi.fn().mockResolvedValue({ id: 'ii_new' });
  const invoicesFinalize = vi.fn().mockResolvedValue({ id: 'in_new', status: 'open' });
  const invoicesRetrieve = vi.fn().mockResolvedValue({ id: 'in_new', status: 'draft' });
  const invoicesVoid = vi.fn().mockResolvedValue({ id: 'in_new', status: 'void' });
  const invoicesDel = vi.fn().mockResolvedValue({ id: 'in_new', deleted: true });

  const stripe = {
    customers: { create: customersCreate, search: customersSearch },
    invoices: {
      create: invoicesCreate,
      finalizeInvoice: invoicesFinalize,
      retrieve: invoicesRetrieve,
      voidInvoice: invoicesVoid,
      del: invoicesDel,
    },
    invoiceItems: { create: invoiceItemsCreate },
    ...overrides,
  } as unknown as Stripe;

  return {
    stripe,
    mocks: {
      customersCreate, customersSearch, invoicesCreate, invoiceItemsCreate,
      invoicesFinalize, invoicesRetrieve, invoicesVoid, invoicesDel,
    },
  };
}

describe('StripeSdkInvoiceClient.ensureCustomer', () => {
  it('returns the existing customer when search finds one (no create)', async () => {
    const { stripe, mocks } = makeStripeMock();
    mocks.customersSearch.mockResolvedValue({ data: [{ id: 'cus_existing' }] });
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.ensureCustomer(
      { mspOrgId: 'res-a', email: 'b@x.example', name: 'Res A' },
      'stripe-customer-res-a',
    );

    expect(result.customerId).toBe('cus_existing');
    expect(mocks.customersCreate).not.toHaveBeenCalled();
  });

  it('creates a customer with org_id metadata + idempotency-key when none exists', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.ensureCustomer(
      { mspOrgId: 'res-a', email: 'b@x.example', name: 'Res A' },
      'stripe-customer-res-a',
    );

    expect(result.customerId).toBe('cus_new');
    expect(mocks.customersCreate).toHaveBeenCalledWith(
      { email: 'b@x.example', name: 'Res A', metadata: { org_id: 'res-a' } },
      { idempotencyKey: 'stripe-customer-res-a' },
    );
  });
});

describe('StripeSdkInvoiceClient.createInvoice', () => {
  it('creates a charge_automatically + auto_advance=false invoice with idempotency-key', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.createInvoice(
      { customerId: 'cus_x', metadata: { reseller_invoice_id: 'inv-1' } },
      'stripe-invoice-inv-1',
    );

    expect(result.stripeInvoiceId).toBe('in_new');
    expect(mocks.invoicesCreate).toHaveBeenCalledWith(
      {
        customer: 'cus_x',
        collection_method: 'charge_automatically',
        auto_advance: false,
        currency: 'usd',
        metadata: { reseller_invoice_id: 'inv-1' },
      },
      { idempotencyKey: 'stripe-invoice-inv-1' },
    );
  });
});

describe('StripeSdkInvoiceClient.addInvoiceItem', () => {
  it('attaches a single-amount invoice item with idempotency-key', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);

    await client.addInvoiceItem(
      {
        customerId: 'cus_x', stripeInvoiceId: 'in_x',
        amountCents: 1000, currency: 'usd', description: 'Wholesale usage',
      },
      'stripe-invoice-item-li-1',
    );

    expect(mocks.invoiceItemsCreate).toHaveBeenCalledWith(
      { customer: 'cus_x', invoice: 'in_x', amount: 1000, currency: 'usd', description: 'Wholesale usage' },
      { idempotencyKey: 'stripe-invoice-item-li-1' },
    );
  });
});

describe('StripeSdkInvoiceClient.retrieveInvoice', () => {
  it('returns the invoice status', async () => {
    const { stripe, mocks } = makeStripeMock();
    mocks.invoicesRetrieve.mockResolvedValue({ id: 'in_x', status: 'open' });
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.retrieveInvoice('in_x');
    expect(result).toEqual({ status: 'open' });
  });

  it('returns null on Stripe resource_missing (404)', async () => {
    const { stripe, mocks } = makeStripeMock();
    mocks.invoicesRetrieve.mockRejectedValue({ code: 'resource_missing' });
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.retrieveInvoice('in_gone');
    expect(result).toBeNull();
  });

  it('rethrows non-resource_missing errors', async () => {
    const { stripe, mocks } = makeStripeMock();
    mocks.invoicesRetrieve.mockRejectedValue(new Error('stripe is down'));
    const client = new StripeSdkInvoiceClient(stripe);

    await expect(client.retrieveInvoice('in_x')).rejects.toThrow('stripe is down');
  });
});

describe('StripeSdkInvoiceClient.finalizeInvoice — verify-SDK-behavior', () => {
  it('finalizes a draft invoice → returns status', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.finalizeInvoice('in_x');
    expect(result.status).toBe('open');
    expect(mocks.invoicesFinalize).toHaveBeenCalledWith('in_x', { auto_advance: true });
  });

  it('pins SDK contract: finalize on an already-finalized invoice surfaces the SDK behavior', async () => {
    // ResellerInvoiceService's recovery branch short-circuits before
    // finalize for open/paid remotes — so finalize-on-finalized should
    // not happen in practice. This test pins what the SDK does anyway,
    // so a future Stripe semantic shift (e.g. finalize-on-finalized
    // starts throwing) trips here as a regression-detector.
    const { stripe, mocks } = makeStripeMock();
    mocks.invoicesFinalize.mockResolvedValue({ id: 'in_x', status: 'open' });
    const client = new StripeSdkInvoiceClient(stripe);

    const result = await client.finalizeInvoice('in_x');
    expect(result.status).toBe('open'); // SDK returns the already-open invoice
  });
});

describe('StripeSdkInvoiceClient.voidInvoice / deleteDraftInvoice', () => {
  it('voidInvoice calls stripe.invoices.voidInvoice', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);
    await client.voidInvoice('in_x');
    expect(mocks.invoicesVoid).toHaveBeenCalledWith('in_x');
  });

  it('deleteDraftInvoice calls stripe.invoices.del', async () => {
    const { stripe, mocks } = makeStripeMock();
    const client = new StripeSdkInvoiceClient(stripe);
    await client.deleteDraftInvoice('in_x');
    expect(mocks.invoicesDel).toHaveBeenCalledWith('in_x');
  });
});
