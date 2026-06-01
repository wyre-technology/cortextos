import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getSql, runAsSystem } from '../db/context.js';
import { sendTransactionalEmail } from './resend.js';
import {
  dripConnectToolsSubject,
  dripConnectToolsHtml,
} from './templates/drip-connect-tools.js';
import {
  dripInviteTeamSubject,
  dripInviteTeamHtml,
} from './templates/drip-invite-team.js';
import {
  dripAccessControlsSubject,
  dripAccessControlsHtml,
} from './templates/drip-access-controls.js';
import {
  dripFeedbackSubject,
  dripFeedbackHtml,
} from './templates/drip-feedback.js';
import { sendEmailViaGraph } from './graph.js';
import {
  dripFounderWelcomeSubject,
  dripFounderWelcomeHtml,
} from './templates/drip-founder-welcome.js';

/**
 * Drip email scheduler (WYREAI-94, sub-issue 76.2 under WYREAI-76 E3).
 *
 * Polls the users table every interval (default 1h) and sends each user the
 * next drip step they're eligible for. Idempotent via drip_emails_sent
 * (migration 039) — every successful send INSERTs ON CONFLICT DO NOTHING
 * so duplicate ticks never double-send.
 *
 * Ported from mcp-gateway/src/email/drip-scheduler.ts with FOUR conduit
 * adaptations (depth-grounding round 3):
 *
 *  1. DI: gateway injects `postgres.Sql` via constructor; conduit resolves
 *     sql via getSql() against the async-context (request-path vs
 *     system-path connection-class architecture from mig 029). The
 *     scheduler runs background (no request context) so EVERY db call is
 *     wrapped in runAsSystem() — mirror of cleanupExpired in
 *     authorization-server.ts (the canonical pattern for boot-path /
 *     setInterval / system-context DB calls).
 *
 *  2. Schema-first: gateway runs `CREATE TABLE IF NOT EXISTS` at runtime
 *     inside ensureTable(); conduit's discipline is migration-first
 *     (migration 039 owns the DDL).
 *
 *  3. Send abstraction: gateway uses sendEmail({to, subject, html});
 *     conduit uses sendTransactionalEmail(log, email) — the scheduler
 *     accepts `log: FastifyBaseLogger` in constructor and threads it
 *     to the send call. The log argument also serves as a no-op fallback
 *     (sendTransactionalEmail logs and skips when RESEND_API_KEY is unset).
 *
 *  4. Launch cutoff: gateway hardcodes 2026-04-09 (gateway launch). Conduit
 *     parameterizes via DRIP_LAUNCH_CUTOFF env (default 2026-06-01) — users
 *     created before the cutoff never receive backfill drips (prevents
 *     scheduler-resume spam on pre-launch accounts).
 *
 * Caller-responsibility (warden Finding C carry-forward from PR #301):
 *   - The scheduler reads recipient `name` and `company` from users /
 *     organizations rows that ORIGINATE from signup forms (attacker-
 *     influenceable). PR #302's escape-discipline at the template layer
 *     mitigates downstream — every drip template imports escapeHtml from
 *     base.ts and wraps `${first}` interpolation. The scheduler does NOT
 *     re-escape because the template substrate is the canonical site for
 *     HTML escape. If a future template bypasses base.ts.escapeHtml, the
 *     source-grep regression guard (drip-escape-discipline.test.ts) goes
 *     red before any email lands.
 */

type DripAudience = 'all-users' | 'org-owners';
type DripTransport = 'resend' | 'graph';

interface DripRecipientData {
  recipientName?: string;
  company?: string;
}

interface DripStep {
  key: string;
  daysAfterSignup: number;
  audience: DripAudience;
  transport: DripTransport;
  subject: (data: DripRecipientData) => string;
  html: (data: DripRecipientData) => string;
}

const DRIP_STEPS: DripStep[] = [
  {
    key: 'drip-connect-tools',
    daysAfterSignup: 1,
    audience: 'all-users',
    transport: 'resend',
    subject: dripConnectToolsSubject,
    html: dripConnectToolsHtml,
  },
  {
    key: 'drip-invite-team',
    daysAfterSignup: 3,
    audience: 'all-users',
    transport: 'resend',
    subject: dripInviteTeamSubject,
    html: dripInviteTeamHtml,
  },
  {
    key: 'drip-access-controls',
    daysAfterSignup: 5,
    audience: 'all-users',
    transport: 'resend',
    subject: dripAccessControlsSubject,
    html: dripAccessControlsHtml,
  },
  {
    key: 'drip-feedback',
    daysAfterSignup: 7,
    audience: 'all-users',
    transport: 'resend',
    subject: dripFeedbackSubject,
    html: dripFeedbackHtml,
  },
  {
    key: 'founder-welcome',
    daysAfterSignup: 0,
    audience: 'org-owners',
    transport: 'graph',
    subject: dripFounderWelcomeSubject,
    html: dripFounderWelcomeHtml,
  },
];

const DRIP_LAUNCH_CUTOFF = process.env.DRIP_LAUNCH_CUTOFF ?? '2026-06-01T00:00:00Z';

export class DripScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private logger: FastifyBaseLogger) {}

  start(intervalMs = 3_600_000): void {
    this.interval = setInterval(() => {
      // runOnce() establishes its own runAsSystem context internally so any
      // future caller (admin manual-trigger, CLI one-shot, debug endpoint)
      // inherits the system-context wrap by-construction — start() does
      // NOT need to re-wrap. (Warden Finding on PR #303, lifted into the
      // function itself per compose-at-root + layer-locality triad.)
      this.runOnce().catch((err) => {
        this.logger.error({ err }, 'Drip scheduler tick failed');
      });
    }, intervalMs);
    this.interval.unref();

    // Fire immediately on startup as well (runOnce establishes system-context).
    this.runOnce().catch((err) => {
      this.logger.error({ err }, 'Drip scheduler initial run failed');
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run one drip-tick: scan eligible users, send their next step, mark in
   * drip_emails_sent. The whole body runs under `runAsSystem` so any caller
   * (start()'s setInterval tick, an admin manual-trigger, a debug endpoint)
   * inherits the system-context wrap by-construction. Lifting the wrap
   * into the function itself (vs at the start()-entry only) prevents a
   * future direct caller from silently breaking the system-context — same
   * shape as compose-at-root at the context-wrap layer.
   *
   * Warden Finding on PR #303 carry-forward (in-iteration fix per the
   * `in-iteration-fix sub-pin` we banked earlier — small + structural +
   * within canary surface → fix-in-iteration > file-as-follow-up).
   */
  async runOnce(): Promise<void> {
    return runAsSystem(() => this.runOnceUnwrapped());
  }

  private async runOnceUnwrapped(): Promise<void> {
    // Abort only when neither transport is configured. Per-step transport
    // checks (Resend key / graphConfigured) gate the individual steps.
    if (!config.resendApiKey && !this.graphConfigured()) return;
    // Kill switch — set DRIP_SCHEDULER_DISABLED=true to stop all drip emails.
    if (process.env.DRIP_SCHEDULER_DISABLED === 'true') return;

    const counts: Record<string, number> = {};

    // Upper-bound grace window: how stale a user's signup can be before we
    // skip a drip step they never received. Prevents backfill spam when the
    // scheduler resumes after an outage (e.g. RESEND_API_KEY missing for weeks).
    const GRACE_DAYS = 2;

    // Hard cap on sends per tick. Second line of defense: even if the WHERE
    // clause has a bug, we lose at most one tick's worth of email instead of a
    // full backfill blast. Tune via DRIP_MAX_PER_TICK.
    const MAX_PER_TICK = Number.parseInt(process.env.DRIP_MAX_PER_TICK ?? '25', 10);
    let totalSent = 0;
    let rateCapped = false;

    outer: for (const step of DRIP_STEPS) {
      // A graph-transport step is a no-op until the Graph credentials are set.
      if (step.transport === 'graph' && !this.graphConfigured()) {
        continue;
      }

      const maxAgeDays = step.daysAfterSignup + GRACE_DAYS;
      const users = await this.fetchRecipients(step, maxAgeDays);

      let sent = 0;
      for (const user of users) {
        if (totalSent >= MAX_PER_TICK) {
          rateCapped = true;
          break outer;
        }
        const data: DripRecipientData = {
          recipientName: user.name || undefined,
          company: user.company || undefined,
        };
        try {
          const payload = {
            to: user.email,
            subject: step.subject(data),
            html: step.html(data),
          };
          if (step.transport === 'graph') {
            await sendEmailViaGraph(payload);
          } else {
            // sendTransactionalEmail no-ops + logs when RESEND_API_KEY is
            // unset (mirrors the resendApiKey gate above; this is the
            // second-tier per-call safeguard).
            await sendTransactionalEmail(this.logger, payload);
          }

          await getSql()`
            INSERT INTO drip_emails_sent (user_id, email_key)
            VALUES (${user.id}, ${step.key})
            ON CONFLICT (user_id, email_key) DO NOTHING
          `;

          sent++;
          totalSent++;
        } catch (err) {
          this.logger.warn(
            { err, userId: user.id, emailKey: step.key },
            'Failed to send drip email, skipping',
          );
        }
      }

      if (sent > 0) {
        counts[step.key] = sent;
      }
    }

    if (rateCapped) {
      this.logger.warn(
        { totalSent, maxPerTick: MAX_PER_TICK },
        'Drip scheduler hit per-tick rate cap; remaining users will be sent on next tick',
      );
    }

    const parts = Object.entries(counts).map(
      ([key, n]) => `${n} ${key}`,
    );
    if (parts.length > 0) {
      this.logger.info(`Drip: sent ${parts.join(', ')}`);
    }
  }

  private graphConfigured(): boolean {
    return Boolean(
      config.graphTenantId && config.graphClientId && config.graphClientSecret,
    );
  }

  private async fetchRecipients(
    step: DripStep,
    maxAgeDays: number,
  ): Promise<
    Array<{ id: string; email: string; name: string | null; company?: string | null }>
  > {
    if (step.audience === 'org-owners') {
      return getSql()`
        SELECT DISTINCT ON (u.id) u.id, u.email, u.name, o.name AS company
        FROM users u
        JOIN organizations o ON o.owner_id = u.id
        LEFT JOIN drip_emails_sent d
          ON d.user_id = u.id AND d.email_key = ${step.key}
        WHERE u.created_at <= NOW() - ${step.daysAfterSignup + ' days'}::interval
          AND u.created_at >= NOW() - ${maxAgeDays + ' days'}::interval
          AND u.created_at >= ${DRIP_LAUNCH_CUTOFF}::timestamptz
          AND u.email IS NOT NULL
          AND d.user_id IS NULL
          AND u.email NOT ILIKE '%@wyretechnology.com'
          AND u.email NOT ILIKE '%@wyre.ai'
        ORDER BY u.id, o.created_at
      ` as never;
    }
    return getSql()`
      SELECT u.id, u.email, u.name
      FROM users u
      LEFT JOIN drip_emails_sent d
        ON d.user_id = u.id AND d.email_key = ${step.key}
      WHERE u.created_at <= NOW() - ${step.daysAfterSignup + ' days'}::interval
        AND u.created_at >= NOW() - ${maxAgeDays + ' days'}::interval
        AND u.created_at >= ${DRIP_LAUNCH_CUTOFF}::timestamptz
        AND u.email IS NOT NULL
        AND d.user_id IS NULL
    ` as never;
  }
}
