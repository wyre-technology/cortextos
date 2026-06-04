/**
 * Dunning-suspension scheduler — fires the `dunning-suspended` Loops event
 * for orgs that have crossed the by-time-elapsed grace boundary into the
 * suspended state.
 *
 * Why this exists (ruby D2 HIGH launch-blocker audit 2026-06-04):
 *   The suspended transition in `deriveDunningView` is BY-TIME-ELAPSED,
 *   not webhook-anchored. A Stripe invoice.payment_failed sets
 *   first_failure_at; the customer enters a grace window; once grace
 *   elapses, the dunning-view state machine returns 'suspended' the next
 *   time anyone reads it. There is no separate Stripe event at the
 *   suspension moment — so without an in-conduit scheduler firing the
 *   event, the customer's FIRST signal of suspension was "I tried to use
 *   the service and got redirected to a page without context" (worst-
 *   discovery moment; D1 #345 fixes the explanation, this fixes the
 *   proactive nudge).
 *
 * Pattern-family with src/email/drip-scheduler.ts:
 *   Sibling shape — periodic system-path tick, runOnce() wraps the body
 *   in runAsSystem(), idempotency-by-construction at the DB layer. Drip
 *   keys idempotency on (user_id, email_key) in drip_emails_sent; this
 *   scheduler keys idempotency on subscriptions.suspension_notified_at
 *   (mig 042). The first observation marks the row; subsequent ticks
 *   filter `IS NULL` and skip. Recovery (payment_succeeded webhook) +
 *   terminal (canceled webhook) clear the timestamp, so a future
 *   suspension in a new dunning cycle fires fresh.
 *
 * Aaron-decision items pending (do NOT block scaffold-ship):
 *   - Loops template content for the 'dunning-suspended' slug (subject,
 *     body, CTA URL — owned in Loops dashboard, not this code)
 *   - Tick interval (default 1h via DUNNING_SUSPENSION_TICK_MS env,
 *     same shape as DripScheduler)
 *
 * Kill switch:
 *   DUNNING_SUSPENSION_SCHEDULER_DISABLED=true stops all firings. Same
 *   shape as DRIP_SCHEDULER_DISABLED.
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getSql, runAsSystem } from '../db/context.js';
import { sendLoopsEvent } from '../email/loops.js';
import type { OrgService } from '../org/org-service.js';

interface SuspendedRow {
  org_id: string;
  first_failure_at: Date;
  grace_end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TICK_MS = 3_600_000; // 1h
const MAX_PER_TICK_DEFAULT = 25;

export class DunningSuspensionScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private logger: FastifyBaseLogger,
    private orgService: OrgService,
  ) {}

  start(intervalMs = Number.parseInt(
    process.env.DUNNING_SUSPENSION_TICK_MS ?? String(DEFAULT_TICK_MS),
    10,
  )): void {
    this.interval = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error({ err }, 'Dunning-suspension scheduler tick failed');
      });
    }, intervalMs);
    this.interval.unref();
    // Fire immediately on startup too (runOnce establishes system-context).
    this.runOnce().catch((err) => {
      this.logger.error({ err }, 'Dunning-suspension scheduler initial run failed');
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Same compose-at-root + layer-locality discipline as DripScheduler.runOnce. */
  async runOnce(): Promise<void> {
    return runAsSystem(() => this.runOnceUnwrapped());
  }

  private async runOnceUnwrapped(): Promise<void> {
    if (process.env.DUNNING_SUSPENSION_SCHEDULER_DISABLED === 'true') return;
    if (!config.loopsApiKey) {
      // No-op when Loops is unconfigured; same posture as drip-scheduler's
      // transport-configured guard.
      return;
    }

    const sql = getSql();
    const graceDays = config.dunningGraceDays;
    const maxPerTick = Number.parseInt(
      process.env.DUNNING_SUSPENSION_MAX_PER_TICK ?? String(MAX_PER_TICK_DEFAULT),
      10,
    );

    // Find subscriptions that:
    //   - are in an active-dunning status (past_due | unpaid | incomplete)
    //   - have a first_failure_at older than grace_days ago (so the
    //     dunning-view's by-time-elapsed transition has flipped them to
    //     'suspended' in the state machine)
    //   - have NOT yet been notified (suspension_notified_at IS NULL)
    //
    // The grace boundary uses NOW() - graceDays as the cutoff. This
    // matches dunning-view's mapSubscriptionToDunningView grace check.
    // Idempotency-by-construction: we filter IS NULL on the column, and
    // immediately write NOW() to it before firing -- another tick on the
    // same row sees the column non-null and skips.
    const candidates = await sql<SuspendedRow[]>`
      SELECT org_id,
             first_failure_at,
             (first_failure_at + (${graceDays} * INTERVAL '1 day')) AS grace_end
        FROM subscriptions
       WHERE status IN ('past_due', 'unpaid', 'incomplete')
         AND first_failure_at IS NOT NULL
         AND first_failure_at + (${graceDays} * INTERVAL '1 day') < NOW()
         AND suspension_notified_at IS NULL
       ORDER BY first_failure_at
       LIMIT ${maxPerTick}
    `;

    if (candidates.length === 0) return;

    for (const row of candidates) {
      // Claim the row FIRST (write the timestamp). If we crash between
      // claim + send, the next tick skips this row -- preferring at-
      // most-once over at-least-once for the suspension nudge. Stripe-
      // side dunning still fires its own retries; this is a one-shot
      // operator-comms event, not the critical billing path.
      const claimed = await sql<{ org_id: string }[]>`
        UPDATE subscriptions
           SET suspension_notified_at = NOW(),
               updated_at = NOW()
         WHERE org_id = ${row.org_id}
           AND suspension_notified_at IS NULL
           AND status IN ('past_due', 'unpaid', 'incomplete')
        RETURNING org_id
      `;
      if (claimed.length === 0) continue; // Lost the race to a concurrent tick.

      try {
        const members = await this.orgService.getMembersWithProfiles(row.org_id);
        const ownerMember = members.find((m) => m.role === 'owner');
        if (ownerMember?.email) {
          // COPY-PLACEHOLDER: Loops template body / subject / CTA owned
          // by the Loops dashboard, not this code. The 'dunning-
          // suspended' slug activates when Aaron-copy lands in Loops.
          await sendLoopsEvent(ownerMember.email, 'dunning-suspended', {
            org_id: row.org_id,
            first_failure_at: row.first_failure_at.toISOString(),
            suspended_since: row.grace_end.toISOString(),
            grace_days: graceDays,
          });
          this.logger.info(
            { orgId: row.org_id, firstFailureAt: row.first_failure_at.toISOString() },
            'Dunning-suspended Loops event fired',
          );
        } else {
          this.logger.warn(
            { orgId: row.org_id },
            'Dunning-suspended: no owner with email found -- skipping Loops fire',
          );
        }
      } catch (err) {
        // Logged-not-thrown: a single org's Loops failure must not stop
        // the tick. The row remains marked-notified (at-most-once
        // posture); an ops-side re-fire requires manually clearing the
        // column.
        this.logger.warn(
          { err, orgId: row.org_id },
          'Failed to send dunning-suspended Loops event',
        );
      }
    }

    // Reference unused constant to keep it available for future tuning
    // without a stale-export warning.
    void DAY_MS;
  }
}
