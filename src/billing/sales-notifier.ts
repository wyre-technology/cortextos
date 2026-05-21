/**
 * sales-notifier.ts — Slack #conduit-sales notifications for billing events.
 *
 * Posts to the Slack incoming-webhook URL configured via
 * `SLACK_SALES_WEBHOOK_URL`. When the env var is empty (e.g. local dev or
 * a pre-rollout deploy), every function here is a graceful no-op so the
 * Stripe webhook handler doesn't crash on missing config.
 *
 * Failures are logged and swallowed — Slack downtime must not block the
 * Stripe webhook ACK, otherwise Stripe retries pile up and seat-sync /
 * plan-upgrade DB writes get duplicated.
 *
 * Ported from wyre-technology/mcp-gateway PR #121.
 */

import { config } from '../config.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db/context.js';
import type postgres from 'postgres';

async function postToSlack(payload: Record<string, unknown>, log: Pick<FastifyBaseLogger, 'warn'>): Promise<void> {
  if (!config.slackSalesWebhookUrl) return;
  try {
    const res = await fetch(config.slackSalesWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, statusText: res.statusText },
        'sales-notifier: Slack webhook returned non-2xx',
      );
    }
  } catch (err) {
    log.warn({ err }, 'sales-notifier: Slack webhook call threw');
  }
}

export interface BillingAnomalyEvent {
  orgId: string;
  orgName: string;
  sessionId: string;
  sessionCustomer: string | null;
  orgCustomer: string | null;
}

/**
 * Fires when a Stripe checkout.session.completed webhook arrives with a
 * customer ID that doesn't match the org's existing stripe_customer_id.
 * Indicates the upgrade flow minted a duplicate Stripe customer (or worse,
 * a hijack attempt). The webhook handler refuses to update the plan, so
 * this alert is the only signal that a paid customer is stranded.
 */
export async function notifyBillingAnomaly(
  ev: BillingAnomalyEvent,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  await postToSlack(
    {
      text: `:warning: Billing anomaly — ${ev.orgName} checkout has mismatched customer (manual fix required)`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:warning: *Billing anomaly* — *${ev.orgName}* completed a Stripe checkout, but the session's customer doesn't match the org's existing Stripe customer. Plan was NOT updated. Manual remediation needed.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Org \`${ev.orgId}\` · session \`${ev.sessionId}\` · session customer \`${ev.sessionCustomer ?? 'null'}\` · org customer \`${ev.orgCustomer ?? 'null'}\``,
            },
          ],
        },
      ],
    },
    log,
  );
}

export interface NewSignupEvent {
  userId: string;
  orgId: string;
  isOwner: boolean;
}

/**
 * Fires when a user creates their first membership in any organization.
 * Posts to #conduit-sales indicating whether they created the org (owner)
 * or joined an existing one.
 */
export async function notifyNewSignup(
  sql: Sql | postgres.TransactionSql,
  ev: NewSignupEvent,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  try {
    // Check if this is truly the user's first membership
    const membershipCount = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM org_members WHERE user_id = ${ev.userId}
    `;

    if (Number(membershipCount[0]?.count) !== 1) {
      return; // Not a new user
    }

    // Fetch user and organization details
    const userRows = await sql<{ email: string | null; name: string | null }[]>`
      SELECT email, name FROM users WHERE id = ${ev.userId} LIMIT 1
    `;

    const orgRows = await sql<{ name: string }[]>`
      SELECT name FROM organizations WHERE id = ${ev.orgId} LIMIT 1
    `;

    const user = userRows[0];
    const org = orgRows[0];

    if (!user || !org) {
      return; // Missing user or org data
    }

    // Format user line
    const userLine = user.name ? `${user.name} <${user.email}>` : user.email;

    // Set up content based on owner vs member
    const emoji = ev.isOwner ? `:office:` : `:wave:`;
    const role = ev.isOwner ? `Org owner` : `Joined existing org`;
    const headline = ev.isOwner
      ? `*${userLine}* created a new organization, *${org.name}*.`
      : `*${userLine}* joined an existing organization, *${org.name}*.`;

    await postToSlack(
      {
        text: `${emoji} New Conduit signup — ${user.email} (${role})`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *New Conduit signup*\n${headline}`,
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*User*\n${userLine}`,
              },
              {
                type: 'mrkdwn',
                text: `*Organization*\n${org.name}`,
              },
              {
                type: 'mrkdwn',
                text: `*Type*\n${role}`,
              },
            ],
          },
        ],
      },
      log,
    );
  } catch (err) {
    log.warn({ err }, 'sales-notifier: notifyNewSignup failed');
  }
}
