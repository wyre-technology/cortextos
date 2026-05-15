// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://conduit.wyre.ai',
  base: '/docs',
  integrations: [
    starlight({
      title: 'Conduit Docs',
      description:
        'Conduit is the white-label MSP channel gateway that connects AI agents to the vendor MCP servers MSPs already rely on.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/wyre-technology/wyre-mcp-gateway-platform',
        },
      ],
      logo: {
        // Placeholder — replace with real Conduit mark when brand asset lands.
        src: './src/assets/logo-placeholder.svg',
        replacesTitle: false,
      },
      editLink: {
        baseUrl:
          'https://github.com/wyre-technology/wyre-mcp-gateway-platform/edit/main/docs/',
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
            { label: 'Adding Customers', slug: 'guides/adding-customers' },
            { label: 'Customer Provisioning', slug: 'guides/customer-provisioning' },
            { label: 'Vendor Connections', slug: 'guides/vendor-connections' },
            { label: 'White-label Setup', slug: 'guides/white-label-setup' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'API', slug: 'reference/api' },
            { label: 'Permissions', slug: 'reference/permissions' },
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
