/**
 * Customer brand configurations
 *
 * Registry of customer-specific brand overrides keyed by URL path prefix.
 * Each entry produces a fully branded landing + login experience at /<key>.
 */

import type { BrandConfig } from './types.js';

export const customerBrands: Record<string, BrandConfig> = {
  lubing: {
    name: 'LUBING Systems',
    tagline: 'AI-Powered Operations Hub',
    logoUrl: 'https://lubingusa.com/wp-content/uploads/2022/10/Lubing-Logo-1024x279-250x68.png',
    supportUrl: '',
    docsUrl: '/',
    issuesUrl: '',
    primaryColor: '#005AAB',
    accentColor: '#FF9900',
    headingFont: "'Prompt', Arial, sans-serif",
    bodyFont: "'Public Sans', Arial, sans-serif",
    borderRadius: '10px',
    domain: '',
  },
};
