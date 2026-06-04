import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { config } from '../config.js';
import type { OrgService } from '../org/org-service.js';
import { sendLoopsEvent } from '../email/loops.js';
import { notifyBillingAnomaly } from './sales-notifier.js';
import { runAsSystem, type Sql } from '../db/context.js';

/**
 * Webhook handler for a Track C reseller-channel invoice payment success.
 *
 * rowCount-gating pattern: the UPDATE is guarded `WHERE status IN
 * ('open','past_due')` so a duplicate Stripe delivery (at-least-once)
 * AND an out-of-order delivery are both absorbed — a second
 * payment_succeeded matches zero rows because status is already 'paid'.
 *
 * FUTURE on-paid side-effects (MSP notification, revenue-event emission,
 * Loops event): gate them on `result.count > 0` of THIS update. A
 * side-effect inside `if (result.count > 0)` fires exactly-once under
 * at-least-once delivery WITHOUT a dedup table — the row-transition
 * itself is the dedup token. A dedup table is only needed if a future
 * side-effect is a non-idempotent external call that cannot be
 * rowCount-gated.
 *
 * BYPASS RLS: reseller_invoices has FORCE ROW LEVEL SECURITY (mig 027).
 * This UPDATE has no user session to satisfy the RLS policy; it relies
 * on the webhook connection role (gatewayadmin) carrying the BYPASSRLS
 * attribute. DEPLOY-CHECKLIST: the production conduit DB-role must be
 * verified to carry BYPASSRLS before this path is trusted in prod —
 * do NOT infer prod==staging (staging was confirmed 2026-05-15).
 *
 * Error disposition (retry-signal-must-match-retry-tractability):
 *   - zero-rows-matched (unresolvable / already-terminal) → permanent;
 *     log + return normally → outer handler 200-acks. Retrying cannot
 *     fix a missing row; a 500 here would trigger a Stripe retry-storm.
 *   - DB error inside the UPDATE → transient; propagates → outer 500 →
 *     Stripe retries, which can help.
 */
export async function handleResellerInvoicePaymentSucceeded(
  resellerInvoiceId: string,
  log: FastifyInstance['log'],
  sql: Sql,
): Promise<void> {
  const result = await sql`
    UPDATE reseller_invoices
       SET status = 'paid'
     WHERE id = ${resellerInvoiceId}
       AND status IN ('open', 'past_due')
  `;
  if ((result as unknown as { count: number }).count === 0) {
    log.warn(
      { resellerInvoiceId },
      'reseller invoice payment_succeeded matched no open/past_due row — acking (permanent, retry cannot help)',
    );
    return;
  }
  log.info({ resellerInvoiceId }, 'reseller invoice marked paid');
}

/**
 * Webhook handler for a Track C reseller-channel invoice payment failure.
 *
 * Sets status='past_due'. Per the Track C scope-doc, MSP-level dunning
 * lives at the subscription layer (mig 024 first_failure_at on
 * subscriptions) — the reseller-invoice carries a derived 'past_due'
 * status as a visible-state, NOT its own dunning clock. The MSP's WYRE
 * subscription dunning handles grace + suspension.
 *
 * rowCount-gating, BYPASS RLS, and error disposition: identical to
 * handleResellerInvoicePaymentSucceeded above — see that docblock.
 */
export async function handleResellerInvoicePaymentFailed(
  resellerInvoiceId: string,
  log: FastifyInstance['log'],
  sql: Sql,
): Promise<void> {
  const result = await sql`
    UPDATE reseller_invoices
       SET status = 'past_due'
     WHERE id = ${resellerInvoiceId}
       AND status = 'open'
  `;
  if ((result as unknown as { count: number }).count === 0) {
    log.warn(
      { resellerInvoiceId },
      'reseller invoice payment_failed matched no open row — acking (permanent, retry cannot help)',
    );
    return;
  }
  log.info({ resellerInvoiceId }, 'reseller invoice marked past_due');
}

/**
 * Registers the Stripe webhook handler at POST /api/webhooks/stripe.
 *
 * Handles:
 *   - checkout.session.completed → mark org subscription active (plan='conduit')
 *   - customer.subscription.updated → MIRROR Stripe status onto subscriptions
 *     row every transition; never flips the plan (no tiers post-flat). Also
 *     covers .created paths — Stripe always fires .updated after .created.
 *   - customer.subscription.deleted → UPSERT status='canceled' + clear the
 *     dunning clock (first_failure_at/recovered_at). Service-denial flows
 *     via the subscriptions.status gate, not a plan flip.
 *   - invoice.payment_failed → Track A: set first_failure_at + fire Loops
 *     dunning event. Track C: mark reseller_invoices past_due.
 *   - invoice.payment_succeeded → Track A: clear first_failure_at, set
 *     recovered_at, fire Loops recovered event. Track C: mark
 *     reseller_invoices paid.
 *
 * Track A vs Track C routing discriminator: a reseller-channel invoice
 * carries `metadata.reseller_invoice_id` (set by ResellerInvoiceService
 * at createInvoice time). Stripe subscription invoices never carry that
 * key — its presence is an unambiguous discriminator.
 *
 * Dunning architecture (Track A, mig 024):
 *   - Derive-on-fly. Stripe is source of truth for subscription status.
 *   - One helper field (first_failure_at) anchors the grace window.
 *   - isServiceActive() in gate.ts uses (status, first_failure_at, grace)
 *     to decide whether a paid org currently gets service. Post-flat
 *     (Shape-A′, 2026-05-26) the plan never flips — every org stays
 *     'conduit'; service-denial flows entirely through subscriptions.status
 *     + the dunning grace window. past_due/unpaid keep service live
 *     inside the grace; canceled and post-grace past_due deny.
 */
export function stripeWebhookRoutes(
  orgService: OrgService,
  sql: Sql,
) {
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

      // The /api/webhooks/stripe route is exempt from the request-context
      // plugin (no user session) — so it carries no DB context of its own.
      // Every orgService.* call in the switch below is getSql()-based and
      // throws "getSql() called with no DB context" without one. PR #118
      // (two-connection-class RLS) made getSql() context-required but did not
      // wrap this handler — the request-context-plugin docstring already
      // specifies the webhook "runs system-path explicitly via runAsSystem()".
      // This restores that intent: runAsSystem opens the BYPASSRLS system-path
      // context for the whole switch. (The switch body is intentionally not
      // re-indented, to keep this bug-fix diff minimal and reviewable.)
      try {
        await runAsSystem(async () => {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const orgId = session.metadata?.org_id;
            if (!orgId) {
              app.log.warn({ sessionId: session.id }, 'checkout.session.completed missing org_id metadata');
              break;
            }

            const org = await orgService.getOrg(orgId);
            if (!org) {
              app.log.warn({ orgId, sessionId: session.id }, 'checkout.session.completed: org not found');
              break;
            }

            // Anti-hijack guard: refuse to update the plan when the session
            // customer doesn't match the org's existing Stripe customer.
            // Combined with the checkout-side fix (resub now passes
            // `customer`), this should be impossible in normal flow — but
            // if it ever fires we surface a Slack alert so it can't silently
            // rot the way it did before mcp-gateway PR #121.
            if (org.stripeCustomerId && org.stripeCustomerId !== session.customer) {
              app.log.error(
                {
                  orgId,
                  sessionCustomer: session.customer,
                  orgCustomer: org.stripeCustomerId,
                },
                'checkout.session.completed: customer mismatch',
              );
              notifyBillingAnomaly(
                {
                  orgId,
                  orgName: org.name,
                  sessionId: session.id,
                  sessionCustomer: (session.customer as string | null) ?? null,
                  orgCustomer: org.stripeCustomerId,
                },
                app.log,
              ).catch((err) => app.log.warn({ err }, 'notifyBillingAnomaly failed'));
              break;
            }

            // Flat-pricing: one-off credit-pack purchases (mode:'payment')
            // are removed (no customer credits). A payment-mode session is
            // no longer expected here — log + skip rather than touch the plan.
            if (session.mode === 'payment') {
              app.log.warn(
                { orgId, sessionId: session.id },
                'checkout.session.completed (payment) received post-flat-pricing — credit packs removed; ignoring',
              );
              break;
            }

            // Subscription checkout completed → the org is on the single flat
            // plan. (The subscriptions row is seeded at provisioning; this
            // keeps organizations.plan canonical.)
            await orgService.updateOrgPlan(
              orgId,
              'conduit',
              session.customer as string,
              session.subscription as string,
            );
            app.log.info({ orgId }, 'Organization subscription active (conduit)');
            break;
          }

          // NOTE — no customer.subscription.created case is needed (warden
          // 2026-05-29 cancellation-access-control review, defensive
          // readability): Stripe ALWAYS fires customer.subscription.updated
          // immediately after customer.subscription.created, so the UPSERT
          // below lands the row on both same-id reactivation AND new-id
          // resubscribe paths. The reader-side getSubscription orders
          // (org_id, created_at DESC) LIMIT 1 → the newest row is
          // authoritative regardless of how many lifetime rows an org
          // accumulates. Adding a separate .created handler would duplicate
          // the UPSERT and risk a write-order race; leaving it out is the
          // load-bearing choice, not an omission.
          case 'customer.subscription.updated': {
            const subscription = event.data.object as Stripe.Subscription;
            const orgId = subscription.metadata?.org_id;
            if (!orgId) break;

            // Flat-pricing (Shape-A′, ruby ruling 2026-05-26): there are no
            // tiers, so the plan never flips — every org stays 'conduit'.
            // Service-denial flows ENTIRELY through the subscriptions.status
            // gate (isServiceActive), NOT through the plan. So this handler
            // MIRRORS Stripe's subscription.status onto the subscriptions row
            // on EVERY transition (terminal AND non-terminal) — closing the
            // re-subscribe-false-suspend edge (esp trial-re-subscribe, which
            // produces no immediate invoice to self-heal).
            //
            // FIELD OWNERSHIP (dunning-clock-ownership rule): this status-
            // mirror sets status + updated_at ONLY on non-terminal
            // transitions — NEVER first_failure_at/recovered_at (those are
            // owned by invoice.payment_failed [anchor] + payment_succeeded
            // [clear+recover]). On TERMINAL (canceled/incomplete_expired) it
            // additionally CLEARS first_failure_at + recovered_at (cancel ends
            // the dunning cycle; prevents a spurious dunning-recovered email
            // if the org re-subscribes later).
            //
            // UPSERT (Stripe-truth writer upsert-and-wins): ON CONFLICT
            // (stripe_subscription_id) — covers the seed-vs-webhook race +
            // migrated orgs uniformly. plan stays 'conduit' on the row.
            const isTerminal =
              subscription.status === 'canceled' || subscription.status === 'incomplete_expired';
            const status = isTerminal ? 'canceled' : subscription.status;
            const periodEnd =
              (subscription as unknown as { current_period_end?: number | null })
                .current_period_end;
            const periodEndIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
            if (isTerminal) {
              await sql`
                INSERT INTO subscriptions (
                  id, org_id, stripe_customer_id, stripe_subscription_id,
                  plan, status, current_period_end, cancel_at_period_end,
                  first_failure_at, recovered_at
                )
                VALUES (
                  ${subscription.id}, ${orgId}, ${subscription.customer as string},
                  ${subscription.id}, 'conduit', 'canceled', ${periodEndIso}, FALSE, NULL, NULL
                )
                ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                  status = 'canceled',
                  first_failure_at = NULL,
                  recovered_at = NULL,
                  updated_at = NOW()
              `;
            } else {
              await sql`
                INSERT INTO subscriptions (
                  id, org_id, stripe_customer_id, stripe_subscription_id,
                  plan, status, current_period_end, cancel_at_period_end
                )
                VALUES (
                  ${subscription.id}, ${orgId}, ${subscription.customer as string},
                  ${subscription.id}, 'conduit', ${status}, ${periodEndIso}, FALSE
                )
                ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                  status = ${status},
                  updated_at = NOW()
              `;
            }
            app.log.info({ orgId, status }, 'Subscription status mirrored');
            break;
          }

          case 'customer.subscription.trial_will_end': {
            // Stripe fires this event ~3 days before `trial_end` for any
            // subscription with a trial. Without this handler the event
            // fell to the default 200-ack-and-ignore branch → trialing
            // customers got ZERO conduit-side warning before the first
            // charge (Tier-3 customer-acquisition-loss surface; ruby T2
            // HIGH launch-blocker audit 2026-06-04).
            //
            // Pattern-family with `invoice.payment_failed` (PR #221):
            // Stripe-event → lookup org-owner → fire Loops event. Same
            // shape, same single-source-pin (sub.current_period_end IS
            // the trial-end the /org/billing banner reads — they cannot
            // disagree).
            const subscription = event.data.object as Stripe.Subscription;
            const orgId = subscription.metadata?.org_id;
            if (!orgId) break;

            const trialEndUnix =
              (subscription as unknown as { trial_end?: number | null }).trial_end ??
              (subscription as unknown as { current_period_end?: number | null })
                .current_period_end ??
              null;
            const trialEndIso = trialEndUnix ? new Date(trialEndUnix * 1000).toISOString() : null;

            // Fire Loops event by looking up the org owner's email.
            // Loops event slug `trial-will-end` is COPY-PLACEHOLDER —
            // pending Aaron-copy decision (subject, body, CTA URL all
            // owned by the Loops template, not this code). Once the
            // template lands in Loops dashboard, this slug becomes live
            // with no further code change. Until then the Loops API
            // returns success-no-template; safe-fallback.
            const owner = await orgService.getOrg(orgId).catch(() => null);
            if (owner) {
              const members = await orgService.getMembersWithProfiles(orgId).catch(() => []);
              const ownerMember = members.find((m) => m.role === 'owner');
              if (ownerMember?.email) {
                sendLoopsEvent(ownerMember.email, 'trial-will-end', {
                  org_id: orgId,
                  trial_end_at: trialEndIso,
                }).catch((err) =>
                  app.log.warn({ err, orgId }, 'failed to send Loops trial-will-end event'),
                );
              }
            }

            app.log.info({ orgId, trialEndIso }, 'Trial-will-end notice queued');
            break;
          }

          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            const orgId = subscription.metadata?.org_id;
            if (!orgId) break;

            // Flat-pricing (Shape-A′): cancellation denies service via the
            // subscriptions.status gate, not a plan downgrade (no free tier).
            // UPSERT status=canceled (Stripe-truth writer wins) + clear the
            // dunning-clock fields (cancel ends the cycle).
            await sql`
              INSERT INTO subscriptions (
                id, org_id, stripe_customer_id, stripe_subscription_id,
                plan, status, cancel_at_period_end, first_failure_at, recovered_at
              )
              VALUES (
                ${subscription.id}, ${orgId}, ${subscription.customer as string},
                ${subscription.id}, 'conduit', 'canceled', FALSE, NULL, NULL
              )
              ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                status = 'canceled',
                first_failure_at = NULL,
                recovered_at = NULL,
                updated_at = NOW()
            `;
            app.log.info({ orgId }, 'Subscription canceled (service denied via status gate)');
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;

            // Track C routing: reseller-channel invoices carry
            // metadata.reseller_invoice_id. Route + break before the
            // Track A subscription-dunning path.
            const resellerInvoiceIdF = invoice.metadata?.reseller_invoice_id;
            if (resellerInvoiceIdF) {
              await handleResellerInvoicePaymentFailed(resellerInvoiceIdF, app.log, sql);
              break;
            }

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

            // Track C routing: reseller-channel invoices carry
            // metadata.reseller_invoice_id. Route + break before the
            // Track A subscription-recovery path.
            const resellerInvoiceIdS = invoice.metadata?.reseller_invoice_id;
            if (resellerInvoiceIdS) {
              await handleResellerInvoicePaymentSucceeded(resellerInvoiceIdS, app.log, sql);
              break;
            }

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
        });
      } catch (err) {
        app.log.error({ err, type: event.type, id: event.id }, 'Stripe webhook handler failed');
        return reply.code(500).send({ error: 'Webhook handler failed' });
      }

      return reply.code(200).send({ received: true });
    });
  };
}
