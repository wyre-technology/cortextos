import type { BrandConfig } from './types.js';

function domainFromBaseUrl(): string {
  try {
    return new URL(process.env.BASE_URL ?? 'http://localhost:8080').hostname;
  } catch {
    return 'localhost';
  }
}

export const brand: BrandConfig = {
  name: process.env.BRAND_NAME ?? 'Wyre Technology',
  tagline: process.env.BRAND_TAGLINE ?? 'MCP Gateway for MSPs',
  logoUrl: process.env.BRAND_LOGO_URL ?? '/assets/logo.svg',
  supportUrl: process.env.BRAND_SUPPORT_URL ?? '',
  docsUrl: process.env.BRAND_DOCS_URL ?? '/',
  issuesUrl: process.env.BRAND_ISSUES_URL ?? 'https://github.com/wyre-technology/msp-claude-plugins/issues/new',
  primaryColor: process.env.BRAND_PRIMARY_COLOR ?? '#2563eb',
  domain: process.env.BRAND_DOMAIN ?? domainFromBaseUrl(),
};

export type { BrandConfig } from './types.js';
