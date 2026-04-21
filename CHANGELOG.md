# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Provenance

This changelog tracks Conduit-specific changes. Conduit is downstream of
wyre-technology/mcp-gateway — inherited upstream changes are summarized
here rather than re-itemized. For the full upstream history see the
mcp-gateway CHANGELOG.

## [Unreleased]

### Conduit-specific

#### Added
- Reseller/MSP multi-tenancy expand migration (`migrations/002_reseller_tenancy_expand.sql`)
- Upstream sync automation: `scripts/sync-upstream.sh` and `.github/workflows/upstream-sync-report.yml`
- Taskmaster integration (`.taskmaster/`) for platform-ops planning
- CODEOWNERS for review routing
- Operations documentation (`docs/operations/`)
- Security baseline scanning (platform-ops #13): Dependabot config
  (`.github/dependabot.yml`), CodeQL workflow, gitleaks workflow,
  Trivy filesystem + container image workflow, and
  `docs/operations/security-scanning.md` triage guide. All findings
  upload as SARIF to the GitHub Security tab; non-blocking by design.

#### Changed
- Docker tagging strategy pinned to `ghcr.io/wyre-technology/conduit` (distinct from upstream image path)
- Release workflow hardened: semver + `latest` (main only) + `sha-<short>` tags via `docker/metadata-action`

### Inherited from upstream

- Synced from `wyre-technology/mcp-gateway@main` — see upstream CHANGELOG for itemized
  entries. Track the exact commit range in each release's notes
  (format: `mcp-gateway@<base>..<head>`).

## [Pre-fork baseline]

Entries below predate the Conduit/upstream split and describe the initial
extraction from mcp-gateway plus early Conduit customization work.

### Added
- Lubing USA customer brand with path-based routing (`/lubing` landing, `/lubing/login`)
- Customer brand registry (`src/brand/customers.ts`) for multi-tenant white-label deployments
- Dynamic Google Fonts loading based on per-brand font configuration
- Landing page and login page now accept `BrandConfig` override for customer branding
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
