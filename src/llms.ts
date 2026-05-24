/**
 * llms.txt — the emerging GEO (generative-engine-optimization) convention
 * (llmstxt.org): a curated, machine-readable map that points AI crawlers at a
 * site's highest-value pages. Served at the ROOT (`/llms.txt`), like robots.txt.
 *
 * Env-gated by the SAME `computeDocsNoindex` discriminator as robots.txt: the
 * gateway serves it ONLY on the indexed prod surface. On a noindex surface
 * (staging, the pre-cutover FQDN) it is suppressed — advertising an AI-crawler
 * map to pre-launch docs contradicts the staging-noindex posture, and an
 * advertised resource should only exist where its link targets are live.
 *
 * NOTE: this body is a PLACEHOLDER pending docs-content curation. It is a
 * structurally-valid llms.txt drawn from the public sidebar slugs so it is
 * usable as-is, but the curated wording + page selection is owned by the
 * docs-content lane (swapped in via a follow-up). It draws ONLY from public
 * slugs — `internal/` is excluded from this discovery channel as it is from
 * the page-serve, robots, and sitemap (Finding A).
 */

interface LlmsLink {
  readonly title: string;
  /** Slug relative to the docs base; '' is the docs index. */
  readonly slug: string;
  readonly summary: string;
}

const LLMS_LINKS: readonly LlmsLink[] = [
  { title: 'Overview', slug: '', summary: 'What Conduit is and who it is for.' },
  {
    title: 'Getting Started',
    slug: 'getting-started',
    summary: 'Connect your first AI client to Conduit.',
  },
  {
    title: 'Supported Clients',
    slug: 'reference/supported-clients',
    summary: 'Which AI clients and MCP transports Conduit supports.',
  },
  {
    title: 'Architecture',
    slug: 'reference/architecture',
    summary: 'How the gateway routes AI agents to vendor MCP servers.',
  },
  {
    title: 'API Reference',
    slug: 'reference/api',
    summary: 'The Conduit gateway HTTP and MCP endpoints.',
  },
  {
    title: 'MSP Onboarding',
    slug: 'guides/msp-onboarding',
    summary: 'Set up Conduit for an MSP tenant.',
  },
  {
    title: 'Connecting an AI Client',
    slug: 'guides/connecting-a-client',
    summary: 'Point an AI client at your Conduit tenant.',
  },
  {
    title: 'Vendor Connections',
    slug: 'guides/vendor-connections',
    summary: 'Connect the vendor MCP servers behind the gateway.',
  },
];

/**
 * Build the llms.txt body for the given docs base URL. Absolute links are
 * required by the convention; the docs live under `${baseUrl}/docs/`.
 */
export function buildLlmsTxt(baseUrl: string): string {
  const docsBase = `${baseUrl.replace(/\/$/, '')}/docs`;
  const link = (l: LlmsLink): string => {
    const url = l.slug ? `${docsBase}/${l.slug}/` : `${docsBase}/`;
    return `- [${l.title}](${url}): ${l.summary}`;
  };
  return [
    '# Conduit',
    '',
    '> Conduit is the white-label MSP channel gateway that connects AI agents to the vendor MCP servers MSPs already rely on.',
    '',
    '## Docs',
    '',
    ...LLMS_LINKS.map(link),
    '',
  ].join('\n');
}
