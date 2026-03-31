# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Branded landing page with WYRE brand kit (Oswald/Nunito Sans fonts, #EDE947/#00C9DB palette)
- Login chooser page with provider-specific sign-in buttons (Microsoft or Auth0)
- Extended `BrandConfig` with `accentColor`, `headingFont`, `bodyFont`, `borderRadius`
- Updated brand defaults to WYRE official colors and logo URL
- Azure AD multi-tenant OIDC authentication plugin (`src/auth/azure-ad.ts`)
- Auth provider switcher — select Auth0 or Azure AD via `AUTH_PROVIDER` env var
- Admin consent endpoint for customer tenant onboarding (`/auth/admin-consent`)
- `customer_tenants` table and migration for tracking onboarded Azure AD tenants
- Initial extraction from `mcp-gateway` — all existing functionality preserved
- Brand configuration system (`BrandConfig`) for white-label deployments
- Prompt/argument capture in audit logs
- Configurable plan catalog (replaces hardcoded free/pro)
- Usage and value dashboards
- Feature flags and config consolidation
- Comprehensive platform documentation
