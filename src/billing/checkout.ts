import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { config } from '../config.js';
import type { OrgService } from '../org/org-service.js';
import { requireAuth0 } from '../auth/auth0.js';

/**
 * Registers billing routes for Stripe Checkout and Customer Portal.
 *
 *   POST /api/billing/checkout — create Stripe Checkout Session
 *   POST /api/billing/portal   — create Stripe Customer Portal session
 */
export function billingRoutes(orgService: OrgService) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    if (!config.stripeSecretKey || !config.stripeProPriceId) {
      app.log.warn('Stripe not fully configured — skipping billing routes');
      return;
    }

    const stripe = new Stripe(config.stripeSecretKey);

    // POST /api/billing/checkout — start subscription checkout
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

        // If already on pro, redirect to portal instead
        if (org.plan === 'pro' && org.stripeCustomerId) {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: org.stripeCustomerId,
            return_url: `${config.baseUrl}/settings`,
          });
          return reply.send({ url: portalSession.url });
        }

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
          mode: 'subscription',
          line_items: [{ price: config.stripeProPriceId, quantity: 1 }],
          success_url: `${config.baseUrl}/settings?upgraded=true`,
          cancel_url: `${config.baseUrl}/settings`,
          metadata: { org_id: orgId },
          subscription_data: { metadata: { org_id: orgId } },
          customer_email: user.email || undefined,
        };

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
