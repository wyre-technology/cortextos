# White-Label / Brand Configuration

The gateway's web UI displays brand elements (company name, logos, colors) that can be customized for different MSP deployments. This document describes the branding system and how to configure it.

## Current Branding

The web UI renders the brand name "Wyre Technology" in several locations:

- **Sidebar**: `.sidebar-brand` element at the top of the navigation
- **Mobile header**: `.mobile-brand` element in the responsive header
- **Connect pages**: `.brand` element on credential entry pages
- **Invitation pages**: `.brand` element on invite acceptance pages
- **Success pages**: `.brand` element after credential connection
- **Waitlist page**: `.brand` element on the public signup page

## Brand Customization Points

The following elements are hardcoded across template files and can be centralized for white-label deployments:

### Company Name

Appears in:
- `src/web/layout.ts` -- sidebar and mobile header
- `src/web/templates/connect.ts` -- credential connection pages
- `src/web/templates/team-connections.ts` -- team connection management
- `src/web/templates/team-team-connections.ts` -- sub-team connections
- `src/web/templates/team-service-client-connections.ts` -- service client connections
- `src/web/helpers.ts` -- success pages
- `src/org/routes.ts` -- invitation pages
- `src/org/routes/invitations.ts` -- invitation templates
- `src/waitlist/routes.ts` -- waitlist signup page

### Visual Style

The UI uses CSS custom properties for theming:

```css
:root {
  --text-primary: #fff;
  --text-secondary: #a3a3a3;
  --bg-primary: #0a0a0a;
  --bg-secondary: #171717;
  --bg-tertiary: #262626;
  --border-color: #333;
  --accent-color: #3b82f6;
}
```

### Brand Styling

```css
.sidebar-brand {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #737373;
}

.brand {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #737373;
}
```

## Implementing White-Label Support

To add environment-variable-driven branding, follow this approach:

### 1. Add Configuration Variables

Add to `src/config.ts`:

```typescript
// Brand configuration
brandName: process.env.BRAND_NAME ?? 'Wyre Technology',
brandLogoUrl: process.env.BRAND_LOGO_URL ?? '',
brandPrimaryColor: process.env.BRAND_PRIMARY_COLOR ?? '#3b82f6',
brandFaviconUrl: process.env.BRAND_FAVICON_URL ?? '',
brandSupportEmail: process.env.BRAND_SUPPORT_EMAIL ?? '',
brandSupportUrl: process.env.BRAND_SUPPORT_URL ?? '',
```

### 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BRAND_NAME` | `Wyre Technology` | Company name displayed in headers, sidebars, and footers |
| `BRAND_LOGO_URL` | (none) | URL to a logo image (SVG or PNG). Replaces the text brand name when set. |
| `BRAND_PRIMARY_COLOR` | `#3b82f6` | Accent color used for buttons, links, and active states |
| `BRAND_FAVICON_URL` | (none) | URL to a favicon |
| `BRAND_SUPPORT_EMAIL` | (none) | Support email shown on error pages |
| `BRAND_SUPPORT_URL` | (none) | Link to support portal or documentation |

### 3. Example Configurations

**Default (Wyre Technology):**
```env
# No BRAND_* variables needed — defaults apply
```

**Custom MSP Brand:**
```env
BRAND_NAME=TechForce Solutions
BRAND_LOGO_URL=https://cdn.techforce.io/logo-white.svg
BRAND_PRIMARY_COLOR=#10b981
BRAND_FAVICON_URL=https://cdn.techforce.io/favicon.ico
BRAND_SUPPORT_EMAIL=support@techforce.io
BRAND_SUPPORT_URL=https://support.techforce.io
```

**Minimal Rebrand:**
```env
BRAND_NAME=MSP Cloud Tools
BRAND_PRIMARY_COLOR=#8b5cf6
```

### 4. Template Integration

Update layout and template files to read from config instead of hardcoding:

```typescript
// In layout.ts
import { config } from '../config.js';

// Replace hardcoded brand
`<div class="sidebar-brand">${escapeHtml(config.brandName)}</div>`

// Add logo support
config.brandLogoUrl
  ? `<img src="${escapeHtml(config.brandLogoUrl)}" alt="${escapeHtml(config.brandName)}" class="sidebar-logo">`
  : `<div class="sidebar-brand">${escapeHtml(config.brandName)}</div>`

// Inject CSS custom property
`<style>:root { --accent-color: ${config.brandPrimaryColor}; }</style>`
```

## Docs Site / Landing Page

The `public/` directory (served as static files) is built from an external Astro source repository (`wyre-technology/msp-claude-plugins`) at CI time. The `public/` directory is `.gitignored` and should not be modified directly.

To customize the landing page for a white-label deployment:
1. Fork the Astro source repository
2. Update branding, copy, and imagery
3. Build and place output in `public/` during your CI pipeline

## Notes

- Brand changes are applied on gateway restart (environment variables are read at startup)
- The web UI is server-rendered HTML with inline CSS -- no separate frontend build step
- The Auth0 login page has its own branding configured in the Auth0 dashboard (Universal Login), which is separate from gateway branding
