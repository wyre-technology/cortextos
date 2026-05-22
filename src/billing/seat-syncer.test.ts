import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { createConduitSeatSyncer, type ConduitSeatSyncerDeps } from './seat-syncer.js';
import { ConduitBillingConfigError } from '../org/org-billing-provisioner.js';
import type { SeatService, SeatBilling } from './seat-service.js';

function makeBilling(billableSeats: number): SeatBilling {
  return Object.freeze({
    counts: Object.freeze({ humans: billableSeats, agents: 0 }),
    creditSeats: billableSeats,
    billableSeats,
    includedAgents: 0,
    billedAgents: 0,
    monthlyTotalCents: 60_000 + 2_000 * billableSeats,
    monthlyCreditAllocation: 2_500 * billableSeats,
  });
}

function makeStripeMock(opts: {
  subscriptionItems?: Array<{ id: string; price: { id: string }; quantity: number }>;
  updateImpl?: () => Promise<unknown>;
}) {
  const update = vi.fn(opts.updateImpl ?? (async () => ({})));
  const retrieve = vi.fn(async (id: string) => ({
    id,
    items: { data: opts.subscriptionItems ?? [] },
  }));
  return {
    stripe: {
      subscriptions: { retrieve },
      subscriptionItems: { update },
    } as unknown as Stripe,
    update,
    retrieve,
  };
}

function makeDeps(overrides: Partial<ConduitSeatSyncerDeps> & {
  billableSeats?: number;
  subscriptionItems?: Array<{ id: string; price: { id: string }; quantity: number }>;
  subscriptionId?: string | null;
  updateImpl?: () => Promise<unknown>;
} = {}) {
  const seatService = {
    getSeatBilling: vi.fn().mockResolvedValue(makeBilling(overrides.billableSeats ?? 1)),
    getSeatCounts: vi.fn(),
    computeSeatBilling: vi.fn(),
  } as unknown as SeatService;
  const mock = makeStripeMock({
    subscriptionItems: overrides.subscriptionItems,
    updateImpl: overrides.updateImpl,
  });
  const deps: ConduitSeatSyncerDeps = {
    stripe: overrides.stripe ?? mock.stripe,
    seatService: overrides.seatService ?? seatService,
    seatPriceId: overrides.seatPriceId ?? 'price_seat_test',
    getSubscriptionId:
      overrides.getSubscriptionId ??
      vi.fn().mockResolvedValue(
        // Distinguish explicit `null` (no sub) from omitted (default sub_test).
        'subscriptionId' in overrides ? overrides.subscriptionId : 'sub_test',
      ),
    required: overrides.required ?? false,
  };
  return { deps, stripeMock: mock, seatService };
}

describe('createConduitSeatSyncer — launch-gate (mirrors provisioner item 1a)', () => {
  it('required:true + seatPriceId set → factory succeeds', () => {
    const { deps } = makeDeps({ required: true });
    expect(() => createConduitSeatSyncer(deps)).not.toThrow();
  });

  it('required:true + seatPriceId unset → throws ConduitBillingConfigError at factory call', () => {
    const { deps } = makeDeps({ required: true, seatPriceId: '' });
    expect(() => createConduitSeatSyncer(deps)).toThrow(ConduitBillingConfigError);
  });

  it('required:false + seatPriceId unset → factory does NOT throw (dev/test path)', () => {
    const { deps } = makeDeps({ required: false, seatPriceId: '' });
    expect(() => createConduitSeatSyncer(deps)).not.toThrow();
  });

  it('required:false + missing seatPriceId: returned syncer resolves null at invoke', async () => {
    const { deps } = makeDeps({ required: false, seatPriceId: '' });
    const syncer = createConduitSeatSyncer(deps);
    const result = await syncer('org_x');
    expect(result).toBeNull();
  });
});

describe('createConduitSeatSyncer — invoke behavior', () => {
  it('no subscriptionId on org → null, no Stripe calls', async () => {
    const { deps, stripeMock } = makeDeps({ subscriptionId: null });
    const syncer = createConduitSeatSyncer(deps);
    const result = await syncer('org_x');
    expect(result).toBeNull();
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.update).not.toHaveBeenCalled();
  });

  it('subscription has no seat item → null, no update call (skip rather than mint)', async () => {
    // Subscription exists but lacks an item matching seatPriceId. This is
    // the "predates Layer 1 two-item shape" / "priceId env changed
    // underneath us" case — defense-in-depth, don't auto-create.
    const { deps, stripeMock } = makeDeps({
      subscriptionItems: [{ id: 'si_base', price: { id: 'price_some_other' }, quantity: 1 }],
    });
    const syncer = createConduitSeatSyncer(deps);
    const result = await syncer('org_x');
    expect(result).toBeNull();
    expect(stripeMock.update).not.toHaveBeenCalled();
  });

  it('quantity unchanged → short-circuit, no Stripe update (idempotent re-sync)', async () => {
    // Same SeatBilling.billableSeats as the existing item.quantity → no
    // need to push. Critical for the domain-auto-join race-loser path
    // where the ON CONFLICT DO NOTHING means both racers call syncSeats
    // but only one membership write actually moved the count.
    const { deps, stripeMock } = makeDeps({
      billableSeats: 5,
      subscriptionItems: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_seat_test' }, quantity: 5 },
      ],
    });
    const syncer = createConduitSeatSyncer(deps);
    const result = await syncer('org_x');
    expect(result).toEqual({ newQuantity: 5, subscriptionItemId: 'si_seat' });
    expect(stripeMock.update).not.toHaveBeenCalled();
  });

  it('quantity changed → subscriptionItems.update fires on seat-item only with proration_behavior:"none"', async () => {
    const { deps, stripeMock } = makeDeps({
      billableSeats: 7,
      subscriptionItems: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_seat_test' }, quantity: 5 },
      ],
    });
    const syncer = createConduitSeatSyncer(deps);
    const result = await syncer('org_x');
    expect(stripeMock.update).toHaveBeenCalledTimes(1);
    expect(stripeMock.update).toHaveBeenCalledWith('si_seat', {
      quantity: 7,
      proration_behavior: 'none',
    });
    expect(result).toEqual({ newQuantity: 7, subscriptionItemId: 'si_seat' });
  });

  it('only the seat-item is touched — base item is never updated even if it has a different quantity drift', async () => {
    // Defense against base-item accidental update — the base is qty 1 by
    // definition; if Stripe somehow shows qty 2 we still don't touch it.
    const { deps, stripeMock } = makeDeps({
      billableSeats: 3,
      subscriptionItems: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_seat_test' }, quantity: 1 },
      ],
    });
    const syncer = createConduitSeatSyncer(deps);
    await syncer('org_x');
    const baseUpdates = stripeMock.update.mock.calls.filter(
      (call: unknown[]) => call[0] === 'si_base',
    );
    expect(baseUpdates).toHaveLength(0);
  });

  it('seatService.getSeatBilling is the single source — call wired through', async () => {
    const { deps, seatService } = makeDeps({
      billableSeats: 3,
      subscriptionItems: [
        { id: 'si_seat', price: { id: 'price_seat_test' }, quantity: 1 },
      ],
    });
    const syncer = createConduitSeatSyncer(deps);
    await syncer('org_xyz');
    expect(seatService.getSeatBilling).toHaveBeenCalledWith('org_xyz');
  });
});
