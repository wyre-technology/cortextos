// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

// schema.org structured data injected into every docs page <head> for
// SEO/AEO/GEO. Claims are grounded + minimal — name/category/description/url/
// publisher only. NO aggregateRating/offers/reviewCount: search + AI engines
// ingest structured data as fact, so unbacked claims are a trust breach, not
// a marketing flourish. Per-page FAQPage schema is added separately (content-
// owned) once the docs-content lane supplies the Q/A pairs.
const ORG_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'WYRE Technology',
  url: 'https://wyre.ai',
  description:
    'WYRE Technology builds Conduit, the white-label MSP channel gateway connecting AI agents to vendor MCP servers.',
};
const SOFTWARE_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Conduit',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: 'https://conduit.wyre.ai',
  description:
    'Conduit is the white-label MSP channel gateway that connects AI agents to the vendor MCP servers MSPs already rely on.',
  publisher: {
    '@type': 'Organization',
    name: 'WYRE Technology',
    url: 'https://wyre.ai',
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://conduit.wyre.ai',
  base: '/docs',
  integrations: [
    // Emits /docs/sitemap-index.xml (the URL the prod robots.txt already
    // advertises). The filter excludes internal/ — the per-agent system-prompt
    // docs must not be discoverable via the sitemap channel any more than via
    // the page-serve, robots, or llms.txt channels (Finding A: exclude across
    // ALL crawler-discovery channels, not just the page).
    sitemap({
      filter: (page) => !page.includes('/internal/'),
    }),
    starlight({
      head: [
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify(ORG_SCHEMA),
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify(SOFTWARE_SCHEMA),
        },
      ],
      title: 'Conduit Docs',
      description:
        'Conduit is the white-label MSP channel gateway that connects AI agents to the vendor MCP servers MSPs already rely on.',
      social: {
        github: 'https://github.com/wyre-technology/conduit',
      },
      logo: {
        // Placeholder — replace with real Conduit mark when brand asset lands.
        src: './src/assets/logo-placeholder.svg',
        replacesTitle: false,
      },
      editLink: {
        baseUrl:
          'https://github.com/wyre-technology/conduit/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Getting Started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'MSP Onboarding', slug: 'guides/msp-onboarding' },
            { label: 'Connecting an AI Client', slug: 'guides/connecting-a-client' },
            { label: 'Vendor Connections', slug: 'guides/vendor-connections' },
            { label: 'White-label Setup', slug: 'guides/white-label-setup' },
            { label: 'Billing & Plans', slug: 'guides/billing' },
            { label: 'Monitoring Your Tenant', slug: 'guides/monitoring' },
            { label: 'SCIM Provisioning', slug: 'guides/scim' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Architecture', slug: 'reference/architecture' },
            { label: 'Supported Clients', slug: 'reference/supported-clients' },
            { label: 'API', slug: 'reference/api' },
            { label: 'CLI Wrapper', slug: 'reference/cli' },
            { label: 'Permissions', slug: 'reference/permissions' },
            { label: 'Security', slug: 'reference/security' },
            { label: 'Subtenant Model', slug: 'reference/subtenants' },
            { label: 'Vendor Health', slug: 'reference/vendor-health' },
            { label: 'Prompt Capture & Privacy', slug: 'reference/prompt-capture' },
            { label: 'Agents', slug: 'reference/agents-concepts' },
          ],
        },
        {
          label: 'Templates',
          items: [
            { label: 'Onboarding Email', slug: 'templates/onboarding-email' },
            { label: 'OAuth Consent', slug: 'templates/oauth-consent' },
            { label: 'Revocation Notice', slug: 'templates/revocation-notice' },
            { label: 'Security Notice', slug: 'templates/security-notice' },
          ],
        },
        {
          label: 'Internal',
          collapsed: true,
          items: [
            { label: 'Agents — Implementation', slug: 'internal/agents-impl' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Upstream Sync', slug: 'operations/upstream-sync' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Contributing to the Docs', slug: 'contributing/contributing' },
            { label: 'Style Guide', slug: 'contributing/style-guide' },
          ],
        },
      ],
    }),
  ],
});
