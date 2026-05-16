/**
 * Resend transactional-email client.
 *
 * Conduit sends two classes of email:
 *   - marketing / lifecycle events -> Loops (src/email/loops.ts)
 *   - transactional (invitations, welcome, security notices) -> Resend, here.
 *
 * Gated on RESEND_API_KEY exactly as loops.ts is gated on LOOPS_API_KEY: when
 * the key is unset the send is a no-op plus one log line, so a dev / CI / not-
 * yet-provisioned environment boots and runs without email rather than
 * erroring. A configured environment that hits an API failure throws — the
 * caller (fire-and-forget at every current call site) logs and moves on.
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

const RESEND_API = 'https://api.resend.com';
const RESEND_TIMEOUT_MS = 5000;

export interface TransactionalEmail {
  /** Recipient address. */
  to: string;
  subject: string;
  /** Pre-rendered HTML body. Callers must HTML-escape interpolated values. */
  html: string;
}

/**
 * Send one transactional email via Resend. No-op (with a log line) when
 * RESEND_API_KEY is unset. Throws on an API-level failure.
 */
export async function sendTransactionalEmail(
  log: FastifyBaseLogger,
  email: TransactionalEmail,
): Promise<void> {
  if (!email.to) return;
  if (!config.resendApiKey) {
    log.info(
      { to: email.to, subject: email.subject },
      'Resend not configured (RESEND_API_KEY unset) — transactional email skipped',
    );
    return;
  }

  const res = await fetch(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: email.to,
      subject: email.subject,
      html: email.html,
    }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status}`);
  }
}
