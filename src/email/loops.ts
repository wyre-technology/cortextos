import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

const LOOPS_API = 'https://app.loops.so/api/v1';
const LOOPS_TIMEOUT_MS = 5000;

// Treat email-as-name as no name — some IdPs put the email in the name claim
// when the directory has no display name set, and "alice@x.com" is not a
// useful first name in a marketing email.
function parseName(fullName: string): { firstName?: string; lastName?: string } {
  if (!fullName || fullName.includes('@')) return {};
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
  };
}

async function loopsRequest(path: string, body: unknown): Promise<Response> {
  return fetch(`${LOOPS_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.loopsApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOOPS_TIMEOUT_MS),
  });
}

export async function createLoopsContact(
  email: string,
  name?: string,
  userGroup = 'free',
): Promise<void> {
  if (!config.loopsApiKey || !email) return;

  const { firstName, lastName } = parseName(name ?? '');

  const res = await loopsRequest('/contacts/create', {
    email,
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
    userGroup,
    source: 'conduit',
  });
  if (!res.ok) throw new Error(`Loops contacts/create failed: ${res.status}`);
}

export async function sendLoopsEvent(
  email: string,
  eventName: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (!config.loopsApiKey || !email) return;

  const res = await loopsRequest('/events/send', { email, eventName, ...properties });
  if (!res.ok) throw new Error(`Loops events/send failed: ${res.status}`);
}

// Fire-and-forget enrollment for first-time signups. Creates the contact
// and emits 'signup' in parallel — the event call doesn't depend on the
// contact response, and Loops will associate by email either way.
export function enrollNewUserInLoops(
  log: FastifyBaseLogger,
  email: string,
  name: string | undefined,
): void {
  if (!email) return;
  Promise.all([
    createLoopsContact(email, name || undefined),
    sendLoopsEvent(email, 'signup'),
  ]).catch((err) => log.warn({ err }, 'failed to enroll user in Loops'));
}
