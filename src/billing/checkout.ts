import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { config } from '../config.js';
import type { OrgService } from '../org/org-service.js';
import { requireAuth0 } from '../auth/auth0.js';
import { isPaidPlan } from './gate.js';

/**
 * Registers billing routes for Stripe Checkout and Customer Portal.
 *
 *   POST /api/billing/checkout         — create a subscription Checkout Session
 *   POST /api/billing/checkout-credits — create a one-off credit-pack Checkout
 *   POST /api/billing/portal           — create a Stripe Customer Portal session
 */

/**
 * One-off credit-pack sizes → their Stripe Price ID. A pack with no
 * configured price ID is unavailable (handled per-request). The webhook does
 * NOT need a reverse map — the selected pack's `credits` is carried in the
 * Checkout session metadata (see the checkout-credits route below).
 *
 * Exported so checkout.test.ts can derive its expected price ID from this
 * exact object — the test is the create/webhook drift-lock that replaces the
 * gateway's line-item reverse-map, and it only locks if it reads the real map
 * rather than a hardcoded mirror.
 */
export const CREDIT_PACKS: Record<number, string> = {
  1000: config.stripeCredits1000PriceId,
  2500: config.stripeCredits2500PriceId,
  5000: config.stripeCredits5000PriceId,
};

export function billingRoutes(orgService: OrgService) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // Layer 1: the registration gate drops the stripeProPriceId requirement.
    // The trialing two-item subscription (conduit base + seat) is created
    // server-side at org creation by createConduitBillingProvisioner; the
    // pro single-price endpoint is legacy-only and per-route logic handles
    // its absence. Credit-pack purchases (a separate route below) only
    // need their own pack-specific price IDs; the per-route check (line
    // ~130) catches missing packs at request time.
    if (!config.stripeSecretKey) {
      app.log.warn('Stripe not configured — skipping billing routes');
      return;
    }

    const stripe = new Stripe(config.stripeSecretKey);

    // POST /api/billing/checkout
    //
    // Layer 1 disposition (DOR §9.1 + §7): every standalone org is created
    // with a Stripe trialing subscription attached, so stripeCustomerId is
    // set from creation. This endpoint routes EVERY caller with a
    // stripeCustomerId to the Customer Portal — that's where they add a
    // payment method during/after trial, change card, cancel, etc. The
    // legacy "first-subscribe" path below (lines ~120+) fires only for
    // pre-Layer-1 orgs without a stripeCustomerId, which post-WI-8
    // migration is the empty set.
    app.post<{ Body: { org_id: string; coupon?: string } }>(
      '/api/billing/checkout',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { org_id: orgId, coupon } = request.body;
        if (!orgId) {
          return reply.code(400).send({ error: 'org_id is required' });
        }

        // Verify user is org owner
        const membership = await orgService.getMembership(orgId, user.sub);
        if (!membership || membership.role !== 'owner') {
          return reply.code(403).send({ error: 'Only the org owner can manage billing' });
        }

        const org = await orgService.getOrg(orgId);
        if (!org) {
          return reply.code(404).send({ error: 'Organization not found' });
        }

        // Layer 1 happy path: org has a Stripe customer (because every
        // conduit org gets one at creation) → Customer Portal handles
        // payment-method-attach, card change, cancel, invoice history.
        // No new subscription is created here — the trialing sub already
        // exists; portal updates default_payment_method on that sub.
        // The isPaidPlan gate is kept as a safety check for the
        // migration window (a legacy 'free' org with a stripeCustomerId
        // from a prior aborted upgrade would otherwise short-circuit
        // here; falls through to the legacy first-subscribe path below).
        if (isPaidPlan(org.plan) && org.stripeCustomerId) {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: org.stripeCustomerId,
            return_url: `${config.baseUrl}/settings`,
          });
          return reply.send({ url: portalSession.url });
        }

        // Legacy first-subscribe path (pre-Layer-1 / WI-8 migration in
        // flight). Requires stripeProPriceId to be set; without it the
        // endpoint returns a clear error rather than failing late in the
        // Stripe call. Post-migration this branch is unreachable.
        if (!config.stripeProPriceId) {
          return reply
            .code(409)
            .send({
              error:
                'No subscription on this org and the legacy first-subscribe path is not configured (Layer 1: every conduit org gets a subscription at creation; this state should not occur post-migration).',
            });
        }

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
          mode: 'subscription',
          line_items: [{ price: config.stripeProPriceId, quantity: 1 }],
          success_url: `${config.baseUrl}/settings?upgraded=true`,
          cancel_url: `${config.baseUrl}/settings`,
          metadata: { org_id: orgId },
          subscription_data: { metadata: { org_id: orgId } },
        };

        // Resub flow: org cancelled (plan=free) but still has a Stripe
        // customer from a prior subscription. Reuse that customer so we
        // don't mint a duplicate — duplicates trip the webhook's
        // anti-hijack guard and leave the upgrade silently stranded.
        // Stripe rejects passing both `customer` and `customer_email`.
        if (org.stripeCustomerId) {
          sessionParams.customer = org.stripeCustomerId;
        } else {
          sessionParams.customer_email = user.email || undefined;
        }

        if (coupon) {
          // Only allow coupons explicitly published for customer use.
          // Internal/sales-driven discounts must be applied server-side
          // via a code path that knows which org gets which discount.
          if (!config.stripePublicCouponCodes.has(coupon)) {
            return reply.code(400).send({ error: 'Invalid or unrecognised coupon code' });
          }
          sessionParams.discounts = [{ coupon }];
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        return reply.send({ url: session.url });
      },
    );

    // POST /api/billing/checkout-credits — one-off credit-pack purchase.
    // mode:'payment' (not subscription). The org's credit block is added by
    // the webhook on checkout.session.completed; see stripe-webhook.ts.
    app.post<{ Body: { org_id: string; credits: number } }>(
      '/api/billing/checkout-credits',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { org_id: orgId, credits } = request.body;
        if (!orgId) {
          return reply.code(400).send({ error: 'org_id is required' });
        }

        // A bad pack size is a client error (400); a valid size with no
        // configured Stripe price is an operator/config error (500).
        if (![1000, 2500, 5000].includes(credits)) {
          return reply.code(400).send({ error: 'credits must be 1000, 2500, or 5000' });
        }
        const priceId = CREDIT_PACKS[credits];
        if (!priceId) {
          return reply
            .code(500)
            .send({ error: `The ${credits}-credit pack is not configured` });
        }

        // Owner-only — billing is owner-gated, matching /checkout and /portal.
        const membership = await orgService.getMembership(orgId, user.sub);
        if (!membership || membership.role !== 'owner') {
          return reply.code(403).send({ error: 'Only the org owner can manage billing' });
        }

        const org = await orgService.getOrg(orgId);
        if (!org) {
          return reply.code(404).send({ error: 'Organization not found' });
        }

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
          mode: 'payment',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${config.baseUrl}/org/billing?credits_added=${credits}`,
          cancel_url: `${config.baseUrl}/org/billing`,
          // PORT-AND-TIGHTEN vs mcp-gateway: `credits` is carried in metadata
          // so the webhook reads it directly — no listLineItems call, no
          // priceId reverse-map. Set here from the same CREDIT_PACKS map.
          metadata: { org_id: orgId, credits: String(credits) },
        };
        if (org.stripeCustomerId) {
          sessionParams.customer = org.stripeCustomerId;
        } else {
          sessionParams.customer_email = user.email || undefined;
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        return reply.send({ url: session.url });
      },
    );

    // POST /api/billing/portal — open Stripe Customer Portal
    app.post<{ Body: { org_id: string } }>(
      '/api/billing/portal',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { org_id: orgId } = request.body;
        if (!orgId) {
          return reply.code(400).send({ error: 'org_id is required' });
        }

        const org = await orgService.getOrg(orgId);
        if (!org || !org.stripeCustomerId) {
          return reply.code(404).send({ error: 'No billing account found' });
        }

        // Verify user is org owner
        const membership = await orgService.getMembership(orgId, user.sub);
        if (!membership || membership.role !== 'owner') {
          return reply.code(403).send({ error: 'Only the org owner can manage billing' });
        }

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: org.stripeCustomerId,
          return_url: `${config.baseUrl}/settings`,
        });

        return reply.send({ url: portalSession.url });
      },
    );
  };
}
