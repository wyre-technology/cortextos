import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { config } from '../config.js';
import type { OrgService } from '../org/org-service.js';

/**
 * Registers the Stripe webhook handler at POST /api/webhooks/stripe.
 *
 * Handles:
 *   - checkout.session.completed → upgrade org to pro
 *   - customer.subscription.updated → sync plan status
 *   - customer.subscription.deleted → downgrade to free
 */
export function stripeWebhookRoutes(orgService: OrgService) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
      app.log.warn('Stripe not configured — skipping webhook registration');
      return;
    }

    const stripe = new Stripe(config.stripeSecretKey);

    // Capture raw body for webhook signature verification
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1048576 },
      (_req, body, done) => done(null, body),
    );

    app.post('/api/webhooks/stripe', async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['stripe-signature'];
      if (!signature) {
        return reply.code(400).send({ error: 'Missing stripe-signature header' });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          config.stripeWebhookSecret,
        );
      } catch (err) {
        app.log.warn({ err }, 'Stripe webhook signature verification failed');
        return reply.code(400).send({ error: 'Invalid signature' });
      }

      app.log.info({ type: event.type, id: event.id }, 'Stripe webhook received');

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const orgId = session.metadata?.org_id;
            if (!orgId) {
              app.log.warn({ sessionId: session.id }, 'checkout.session.completed missing org_id metadata');
              break;
            }

            await orgService.updateOrgPlan(
              orgId,
              'pro',
              session.customer as string,
              session.subscription as string,
            );
            app.log.info({ orgId }, 'Organization upgraded to pro');
            break;
          }

          case 'customer.subscription.updated': {
            const subscription = event.data.object as Stripe.Subscription;
            const orgId = subscription.metadata?.org_id;
            if (!orgId) break;

            const plan = subscription.status === 'active' ? 'pro' : 'free';
            await orgService.updateOrgPlan(
              orgId,
              plan,
              subscription.customer as string,
              subscription.id,
            );
            app.log.info({ orgId, plan, status: subscription.status }, 'Subscription updated');
            break;
          }

          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            const orgId = subscription.metadata?.org_id;
            if (!orgId) break;

            await orgService.updateOrgPlan(orgId, 'free');
            app.log.info({ orgId }, 'Organization downgraded to free');
            break;
          }

          default:
            app.log.debug({ type: event.type }, 'Unhandled Stripe event type');
        }
      } catch (err) {
        app.log.error({ err, type: event.type, id: event.id }, 'Stripe webhook handler failed');
        return reply.code(500).send({ error: 'Webhook handler failed' });
      }

      return reply.code(200).send({ received: true });
    });
  };
}
