/**
 * Robots / crawler policy for the gateway (docs + all responses).
 *
 * Non-production surfaces (staging, the pre-cutover kinddesert FQDN, local)
 * must NOT be indexed by search engines or ingested by AI crawlers — they
 * serve pre-launch docs + are not public-access. The production
 * customer-facing docs host (conduit.wyre.ai) MUST be indexable + crawlable
 * (the docs are a customer-acquisition surface at launch).
 *
 * These are pure functions over env-state so the policy is unit-testable in
 * both modes without booting the gateway; src/index.ts wires them at boot.
 *
 * NOTE: noindex/robots is crawler + AI-agent POLITENESS, not access-control —
 * compliant crawlers respect it, malicious scrapers ignore it. The concern is
 * search-index-pollution + AI-training-ingestion of pre-launch product docs,
 * not secret-protection (the docs contain no secrets), so
 * politeness-not-authgate is the correct + sufficient tool.
 */

/** The production customer-facing docs host — the only surface that indexes. */
export const PROD_DOCS_HOST = 'conduit.wyre.ai';

/**
 * The published-docs path that must NEVER be indexed, on any surface including
 * the indexed prod apex: the internal/ docs carry full per-agent system-prompt
 * contents. This is the path-belt prefix for the X-Robots-Tag header (Finding A).
 */
export const INTERNAL_DOCS_PREFIX = '/docs/internal';

/**
 * True if `url` addresses the internal docs subtree (`/docs/internal` or
 * anything beneath it), ignoring any query string. Used to apply a noindex
 * header REGARDLESS of env — the durable fix is build-exclusion, this belt
 * covers compliant crawlers + a build-regression window.
 *
 * Header-based, NOT a robots.txt `Disallow:` — a Disallow line on the indexed
 * prod robots.txt would advertise the hidden path (reconnaissance leak).
 *
 * Matches the directory exactly (`/docs/internal`, `/docs/internal/…`) but not
 * a sibling like `/docs/internal-changelog` — the prefix must be followed by
 * end-of-path, a slash, or a query/fragment delimiter.
 */
export function isInternalDocsPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return path === INTERNAL_DOCS_PREFIX || path.startsWith(`${INTERNAL_DOCS_PREFIX}/`);
}

/**
 * Known AI-crawler user-agents, named explicitly in the noindex robots.txt.
 * `User-agent: * / Disallow: /` already covers compliant crawlers; naming the
 * AI UAs is belt-and-suspenders + an explicit pre-launch-content signal.
 */
export const AI_CRAWLER_UAS = [
  'GPTBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'Google-Extended',
  'CCBot',
  'PerplexityBot',
  'Bytespider',
  'Amazonbot',
  'cohere-ai',
] as const;

/**
 * Decide whether this surface should be noindex.
 *
 * Fail-safe: index ONLY on the prod apex docs host; everything else noindex.
 * Ties the index-flip to the RECORD-2 cutover automatically (the conduit-prod
 * gateway runs the kinddesert FQDN → noindex until cutover sets BASE_URL to
 * conduit.wyre.ai → indexed). `DOCS_NOINDEX=true|false` is an explicit
 * override that wins when set.
 */
export function computeDocsNoindex(baseUrl: string, docsNoindexEnv: string | undefined): boolean {
  // Override hardening: any set value EXCEPT exactly 'false' → noindex, so a
  // typo (DOCS_NOINDEX=1|yes|TRUE) defaults-to-DENY rather than accidentally
  // flipping the surface to INDEXED. Only the explicit 'false' opts into index.
  if (docsNoindexEnv != null) return docsNoindexEnv !== 'false';
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = '';
  }
  return host !== PROD_DOCS_HOST;
}

/**
 * Build the robots.txt body. noindex → disallow all + name the AI UAs;
 * indexed → allow all + point at the docs sitemap.
 */
export function buildRobotsTxt(noindex: boolean, baseUrl: string): string {
  if (noindex) {
    return [
      '# Non-production surface — block all indexing + AI-crawler ingestion.',
      'User-agent: *',
      'Disallow: /',
      '',
      ...AI_CRAWLER_UAS.flatMap((ua) => [`User-agent: ${ua}`, 'Disallow: /', '']),
    ].join('\n');
  }
  return [
    '# Production docs — indexable + crawlable.',
    'User-agent: *',
    'Disallow:',
    '',
    `Sitemap: ${baseUrl.replace(/\/$/, '')}/docs/sitemap-index.xml`,
    '',
  ].join('\n');
}
