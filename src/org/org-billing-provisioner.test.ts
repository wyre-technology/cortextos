/**
 * org-billing-provisioner — launch-gate wire-proven test.
 *
 * The CONDUIT_BILLING_REQUIRED=true env-flag (ruby msg 1779412681446 +
 * boss disposition) turns missing Stripe price IDs into a boot-time
 * failure rather than a silent skip. THIS test is the falsifier proving
 * the flag actually catches the prod-misconfig class — without it the
 * flag is just "we will be disciplined."
 *
 * Wire-proven discipline: assert that calling the factory with
 * required:true and missing IDs THROWS at factory-call time (= boot in
 * src/index.ts), not at provision-invocation time. The throw must fire
 * synchronously from the factory itself.
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  createConduitBillingProvisioner,
  ConduitBillingConfigError,
} from './org-billing-provisioner.js';
import type { SeatService } from '../billing/seat-service.js';

function makeDeps(overrides: {
  basePriceId?: string;
  seatPriceId?: string;
  required?: boolean;
}): Parameters<typeof createConduitBillingProvisioner>[0] {
  return {
    stripe: {} as Stripe,
    seatService: {
      getSeatBilling: vi.fn(),
      getSeatCounts: vi.fn(),
      computeSeatBilling: vi.fn(),
    } as unknown as SeatService,
    basePriceId: overrides.basePriceId ?? 'price_base_test',
    seatPriceId: overrides.seatPriceId ?? 'price_seat_test',
    required: overrides.required ?? false,
  };
}

describe('createConduitBillingProvisioner — launch-gate wire-proven', () => {
  it('required:true + both price IDs set → factory succeeds, returns a provisioner', () => {
    expect(() =>
      createConduitBillingProvisioner(makeDeps({ required: true })),
    ).not.toThrow();
    const fn = createConduitBillingProvisioner(makeDeps({ required: true }));
    expect(typeof fn).toBe('function');
  });

  it('required:true + basePriceId unset → throws ConduitBillingConfigError at factory call (= boot)', () => {
    expect(() =>
      createConduitBillingProvisioner(
        makeDeps({ required: true, basePriceId: '' }),
      ),
    ).toThrow(ConduitBillingConfigError);
  });

  it('required:true + seatPriceId unset → throws ConduitBillingConfigError at factory call (= boot)', () => {
    expect(() =>
      createConduitBillingProvisioner(
        makeDeps({ required: true, seatPriceId: '' }),
      ),
    ).toThrow(ConduitBillingConfigError);
  });

  it('required:true + both unset → throw message names BOTH missing env vars', () => {
    // Named-actionable-choice discipline — the error must name both the
    // env vars that need setting (or unsetting CONDUIT_BILLING_REQUIRED).
    // A reader of the boot log needs the fix path explicit.
    expect(() =>
      createConduitBillingProvisioner(
        makeDeps({ required: true, basePriceId: '', seatPriceId: '' }),
      ),
    ).toThrow(/STRIPE_CONDUIT_BASE_PRICE_ID \+ STRIPE_CONDUIT_SEAT_PRICE_ID/);
  });

  it('required:true error message names both possible fixes (set price ID OR unset the flag)', () => {
    expect(() =>
      createConduitBillingProvisioner(
        makeDeps({ required: true, basePriceId: '' }),
      ),
    ).toThrow(/verify Azure Key Vault provisioning OR unset CONDUIT_BILLING_REQUIRED/);
  });

  it('required:false + both price IDs unset → factory does NOT throw (silent-skip-at-invoke)', () => {
    // Dev/test/CI path: missing IDs are tolerated at factory time so the
    // process boots clean. The returned provisioner returns null when
    // invoked, which createOrg interprets as "skip Stripe attach."
    expect(() =>
      createConduitBillingProvisioner(
        makeDeps({ required: false, basePriceId: '', seatPriceId: '' }),
      ),
    ).not.toThrow();
  });

  it('required:false + missing IDs: returned provisioner resolves null when invoked', async () => {
    const fn = createConduitBillingProvisioner(
      makeDeps({ required: false, basePriceId: '', seatPriceId: '' }),
    );
    const result = await fn({ orgId: 'org_x', orgName: 'X' });
    expect(result).toBeNull();
  });

  it('required defaults to false when omitted — backwards-compat with the no-launch-gate code paths', () => {
    expect(() =>
      createConduitBillingProvisioner({
        ...makeDeps({}),
        // Omit `required` entirely.
        required: undefined,
        basePriceId: '',
        seatPriceId: '',
      }),
    ).not.toThrow();
  });
});

describe('ConduitBillingConfigError', () => {
  it('has stable name (so callers can identify it without instanceof if needed)', () => {
    const err = new ConduitBillingConfigError({ basePrice: true, seatPrice: false });
    expect(err.name).toBe('ConduitBillingConfigError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConduitBillingConfigError);
  });
});
