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

// Google Analytics (GA4), PROD-GATED client-side. The docs are built ONCE into
// the gateway image and served by BOTH the staging and prod gateways
// (single-image-both-envs), so a baked head tag ships identically to both — a
// build-time gate can't distinguish them. The guard below is the runtime
// equivalent of the `computeDocsNoindex` prod-apex-host discriminator, enforced
// in the browser: it injects the gtag.js <script> AND runs init ONLY when the
// page is served from the prod apex (GA_PROD_HOST). Off-prod (staging, preview,
// local) it makes ZERO request to googletagmanager.com and fires nothing —
// keeping the GA property clean of pre-launch/internal traffic. The measurement
// ID is a public client-side identifier (ships in HTML by design, not a secret).
const GA_PROD_HOST = 'conduit.wyre.ai';
const GA_MEASUREMENT_ID = 'G-V3W6M1YEHL';
const GA_GUARD = `if (location.hostname === ${JSON.stringify(GA_PROD_HOST)}) {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}';
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', ${JSON.stringify(GA_MEASUREMENT_ID)});
}`;

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
        {
          tag: 'script',
          content: GA_GUARD,
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
            { label: 'Onboarding a Customer', slug: 'guides/customer-provisioning' },
            { label: 'Connecting an AI Client', slug: 'guides/connecting-a-client' },
            { label: 'Connecting Microsoft Copilot Studio', slug: 'guides/connecting-copilot-studio' },
            { label: 'Vendor Connections', slug: 'guides/vendor-connections' },
            { label: 'White-label Setup', slug: 'guides/white-label-setup' },
            { label: 'Billing & Plans', slug: 'guides/billing' },
            { label: 'Monitoring Your Tenant', slug: 'guides/monitoring' },
            { label: 'SCIM Provisioning', slug: 'guides/scim' },
            {
              label: 'On-prem Gateway',
              items: [
                { label: 'Overview', slug: 'guides/onprem' },
                { label: 'Quickstart', slug: 'guides/onprem/quickstart' },
                { label: 'Architecture Context', slug: 'guides/onprem/architecture' },
                { label: 'Reference', slug: 'guides/onprem/reference' },
                { label: 'Troubleshooting', slug: 'guides/onprem/troubleshooting' },
              ],
            },
          ],
        },
        {
          label: 'Integration walkthroughs',
          items: [
            { label: 'IT Glue', slug: 'guides/integrations/it-glue' },
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
        // Internal docs section removed 2026-06-16 — internal/agents-impl.mdx
        // moved out of the Starlight content collection to docs/internal/
        // (engineer-facing repo file, not a built route). Sidebar entry deleted
        // to close the discovery channel that even the collapsed-by-default
        // entry left open: the section LABEL was visible in nav HTML on every
        // page that rendered the sidebar.
        //
        // Defense-in-depth belts (robots.ts X-Robots-Tag noindex prefix on
        // /docs/internal, sitemap /internal/ filter, llms.txt internal-
        // exclusion-by-curation) stay as regression-window guards per
        // src/robots.ts header comment.
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
            { label: 'Integration Walkthrough Standard', slug: 'contributing/integration-walkthroughs' },
          ],
        },
      ],
    }),
  ],
});
