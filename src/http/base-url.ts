import type { FastifyRequest } from 'fastify';

/**
 * Normalise a host entry to a bare `host[:port]` — strip a leading
 * `http(s)://` scheme and any trailing path/query/fragment. The base URL is
 * built by *prepending* a protocol (`${proto}://${host}`), so a host entry
 * that already carries a scheme would yield a double scheme
 * (`https://http://host`). ALLOWED_HOSTS entries are meant to be bare; this
 * makes a scheme-prefixed misconfiguration harmless rather than silently
 * malformed.
 */
function bareHost(entry: string): string {
  return entry.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
}

/**
 * Derive the canonical base URL for a request. Uses the incoming Host header
 * when the host is on the allowlist; falls back to the first allowlist entry
 * otherwise (including the "no Host header" case). This keeps OAuth metadata,
 * callback URLs, and any echoed-back URLs consistent with whichever hostname
 * the client is actually using, which is required for DCR/token state that
 * clients cache per-issuer.
 *
 * THROWS when the allowlist has no usable host. The previous behaviour fell
 * back to a hardcoded `'http://localhost:8080'` literal — a scheme-carrying
 * string that the `${proto}://` construction then double-schemed into
 * `https://http://localhost:8080`, which shipped as a malformed OAuth
 * redirect_uri (A3: Microsoft sign-in broke on a staging deploy whose
 * ALLOWED_HOSTS was empty). A config mistake must fail loud — a 500 on the
 * auth route — not silently emit a broken auth redirect.
 */
export function getRequestBaseUrl(
  request: Pick<FastifyRequest, 'headers' | 'protocol'>,
  allowedHosts: readonly string[]
): string {
  const host = request.headers.host;
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined) ??
    request.protocol ??
    'https';

  // Normalise to bare host[:port] so the `${proto}://` prepend below can
  // never produce a double scheme, even from a scheme-prefixed entry.
  const hosts = allowedHosts.map(bareHost).filter(Boolean);

  if (host && hosts.includes(host)) {
    return `${proto}://${host}`;
  }

  const fallback = hosts[0];
  if (!fallback) {
    throw new Error(
      'getRequestBaseUrl: ALLOWED_HOSTS is empty or has no usable host — ' +
        'cannot derive a base URL. Set ALLOWED_HOSTS to the gateway host(s).',
    );
  }
  // Fallback always uses https unless it's a localhost entry.
  const fallbackProto = fallback.startsWith('localhost') ? 'http' : 'https';
  return `${fallbackProto}://${fallback}`;
}
