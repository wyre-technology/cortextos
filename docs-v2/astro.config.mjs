// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// Mirror the gateway docs build target. Production this site lives at
// https://conduit.wyre.ai/docs/. Override via SITE_URL / BASE_PATH env vars
// for staging or preview builds.
const site = process.env.SITE_URL || 'https://conduit.wyre.ai';
const base = process.env.BASE_PATH || '/docs/';

export default defineConfig({
  site,
  base,
  integrations: [
    tailwind({ applyBaseStyles: false }),
    mdx(),
    sitemap(),
  ],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: true,
    },
  },
});
