import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type postgres from 'postgres';
import Stripe from 'stripe';
import { config } from '../config.js';
import type { OrgService } from '../org/org-service.js';
import { sendLoopsEvent } from '../email/loops.js';

/**
 * Registers the Stripe webhook handler at POST /api/webhooks/stripe.
 *
 * Handles:
 *   - checkout.session.completed → upgrade org to pro
 *   - customer.subscription.updated → sync plan (canceled-only downgrade)
 *   - customer.subscription.deleted → downgrade to free
 *   - invoice.payment_failed → set first_failure_at, fire Loops dunning event
 *   - invoice.payment_succeeded → clear first_failure_at, set recovered_at,
 *     fire Loops recovered event (only if it ended a dunning cycle)
 *
 * Dunning architecture (Track A, mig 024):
 *   - Derive-on-fly. Stripe is source of truth for subscription status.
 *   - One helper field (first_failure_at) anchors the grace window.
 *   - isServiceActive() in gate.ts uses (status, first_failure_at, grace)
 *     to decide whether a paid org currently gets service. Plan flips to
 *     'free' ONLY on canceled; past_due/unpaid keep plan='pro' so the
 *     grace-period UI surfaces correctly.
 */
export function stripeWebhookRoutes(orgService: OrgService, sql: postgres.Sql) {
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

            // Plan-tier flip only on canonical terminal states. past_due /
            // unpaid keep plan='pro' so the grace-period UI surfaces (the
            // dunning state is derived from status+first_failure_at via
            // isServiceActive, not from plan flips). Without this, the
            // existing handler would suspend instantly on first failure,
            // bypassing Ruby's 7-day grace.
            const isTerminal = subscription.status === 'canceled' || subscription.status === 'incomplete_expired';
            const plan = isTerminal ? 'free' : 'pro';
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

          case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            // Stripe API moved invoice.subscription to invoice.parent.subscription_details.subscription in v22.
            const subRaw = invoice.parent?.subscription_details?.subscription ?? null;
            const subscriptionId = typeof subRaw === 'string' ? subRaw : subRaw?.id ?? null;
            if (!subscriptionId) {
              app.log.debug({ invoiceId: invoice.id }, 'invoice.payment_failed without subscription — skipping dunning');
              break;
            }

            // Idempotency: only set first_failure_at if not already set for
            // this dunning cycle. Stripe fires payment_failed on every retry;
            // we anchor to the FIRST event timestamp for the grace-window
            // calculation. Re-failures don't shift the clock.
            const updated = await sql<{ org_id: string; first_failure_at: Date | null }[]>`
              UPDATE subscriptions
                 SET first_failure_at = COALESCE(first_failure_at, NOW()),
                     recovered_at     = NULL,
                     status           = 'past_due',
                     updated_at       = NOW()
               WHERE stripe_subscription_id = ${subscriptionId}
              RETURNING org_id, first_failure_at
            `;

            if (updated.length === 0) {
              app.log.warn({ subscriptionId }, 'invoice.payment_failed for unknown subscription — no row to update');
              break;
            }

            const { org_id: orgId } = updated[0];
            const attemptCount = invoice.attempt_count ?? 1;

            // Loops event — payment-failing (first attempt) or final-warning
            // (final retry; Stripe sets next_payment_attempt=null when retries
            // exhausted). The 4-event lifecycle matches Ruby's checkpoint-3:
            //   payment-failing : first attempt (attempt_count == 1)
            //   final-warning   : last retry (next_payment_attempt == null)
            //   suspended       : fired by isServiceActive transition (separate event)
            //   recovered       : invoice.payment_succeeded (below)
            const loopsEvent =
              invoice.next_payment_attempt === null ? 'dunning-final-warning' : 'dunning-payment-failing';

            // Fire Loops event by looking up the org owner's email.
            const owner = await orgService.getOrg(orgId).catch(() => null);
            if (owner) {
              const members = await orgService.getMembersWithProfiles(orgId).catch(() => []);
              const ownerMember = members.find((m) => m.role === 'owner');
              if (ownerMember?.email) {
                sendLoopsEvent(ownerMember.email, loopsEvent, {
                  org_id: orgId,
                  attempt_count: attemptCount,
                  amount_due_cents: invoice.amount_due,
                  currency: invoice.currency,
                  next_retry_at: invoice.next_payment_attempt,
                }).catch((err) => app.log.warn({ err, orgId, loopsEvent }, 'failed to send Loops dunning event'));
              }
            }

            app.log.info(
              { orgId, subscriptionId, loopsEvent, attemptCount },
              'Dunning event recorded',
            );
            break;
          }

          case 'invoice.payment_succeeded': {
            const invoice = event.data.object as Stripe.Invoice;
            // Stripe API moved invoice.subscription to invoice.parent.subscription_details.subscription in v22.
            const subRaw = invoice.parent?.subscription_details?.subscription ?? null;
            const subscriptionId = typeof subRaw === 'string' ? subRaw : subRaw?.id ?? null;
            if (!subscriptionId) break;

            // Only fires dunning-recovered if this success ended a dunning
            // cycle (first_failure_at was set). Normal billing-cycle success
            // is silent. recovered_at carries the 1h TTL window so the
            // UI can render the recovered state briefly then collapse to
            // state='none'.
            const updated = await sql<{ org_id: string; was_in_dunning: boolean }[]>`
              UPDATE subscriptions
                 SET recovered_at     = CASE WHEN first_failure_at IS NOT NULL THEN NOW() ELSE recovered_at END,
                     first_failure_at = NULL,
                     status           = 'active',
                     updated_at       = NOW()
               WHERE stripe_subscription_id = ${subscriptionId}
              RETURNING org_id, (recovered_at = NOW()) AS was_in_dunning
            `;

            if (updated.length === 0) break;

            const { org_id: orgId, was_in_dunning: wasInDunning } = updated[0];

            if (wasInDunning) {
              const members = await orgService.getMembersWithProfiles(orgId).catch(() => []);
              const ownerMember = members.find((m) => m.role === 'owner');
              if (ownerMember?.email) {
                sendLoopsEvent(ownerMember.email, 'dunning-recovered', {
                  org_id: orgId,
                  amount_paid_cents: invoice.amount_paid,
                  currency: invoice.currency,
                }).catch((err) => app.log.warn({ err, orgId }, 'failed to send Loops dunning-recovered event'));
              }

              app.log.info({ orgId, subscriptionId }, 'Dunning cycle recovered');
            }
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
