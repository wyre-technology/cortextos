import { config } from '../config.js';

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

/** Test seam: clears the in-memory access-token cache. */
export function __resetGraphTokenCache(): void {
  cachedToken = null;
}

// The drip scheduler calls sendEmailViaGraph serially (awaiting each send), so
// the token cache deliberately has no in-flight deduplication — concurrent
// callers would each trigger a token fetch.
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Reuse the cached token until 60s before expiry.
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const tokenUrl =
    `https://login.microsoftonline.com/${config.graphTenantId}` +
    '/oauth2/v2.0/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.graphClientId,
      client_secret: config.graphClientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Graph token request failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return cachedToken.token;
}

export interface GraphSendOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends an HTML email as `config.founderWelcomeFrom` via the Microsoft Graph
 * sendMail API. `saveToSentItems` keeps a copy in that mailbox's Sent folder.
 */
export async function sendEmailViaGraph(
  options: GraphSendOptions,
): Promise<void> {
  if (!config.founderWelcomeFrom) {
    throw new Error('FOUNDER_WELCOME_FROM is not configured');
  }
  const token = await getAccessToken();
  const sender = encodeURIComponent(config.founderWelcomeFrom);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: options.subject,
          body: { contentType: 'HTML', content: options.html },
          toRecipients: [{ emailAddress: { address: options.to } }],
        },
        saveToSentItems: true,
      }),
    },
  );
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(
      `Graph sendMail failed: ${res.status} ${await res.text()}`,
    );
  }
}
