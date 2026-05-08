import type { FastifyRequest } from 'fastify';

/**
 * Derive the canonical base URL for a request. Uses the incoming Host header
 * when the host is on the allowlist; falls back to the first allowlist entry
 * otherwise (including the "no Host header" case). This keeps OAuth metadata,
 * callback URLs, and any echoed-back URLs consistent with whichever hostname
 * the client is actually using, which is required for DCR/token state that
 * clients cache per-issuer.
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

  if (host && allowedHosts.includes(host)) {
    return `${proto}://${host}`;
  }
  const fallback = allowedHosts[0] ?? 'http://localhost:8080';
  // Fallback always uses https unless it's a localhost entry
  const fallbackProto = fallback.startsWith('localhost') ? 'http' : 'https';
  return `${fallbackProto}://${fallback}`;
}