# [1.6.0](https://github.com/wyre-technology/conduit/compare/v1.5.0...v1.6.0) (2026-05-06)


### Features

* **audit:** prompt-capture toggle on /settings/team/audit ([3e44050](https://github.com/wyre-technology/conduit/commit/3e4405032785eafde28ac3a6ebfcae53ce4db7ba))
* **audit:** wire prompt capture correctly on both proxy paths ([9e89402](https://github.com/wyre-technology/conduit/commit/9e89402e23e753cac5bff9010d0956b9bd0a850e))

# [1.5.0](https://github.com/wyre-technology/conduit/compare/v1.4.0...v1.5.0) (2026-05-05)


### Bug Fixes

* **docker:** copy migrations/ into runtime image ([af7e628](https://github.com/wyre-technology/conduit/commit/af7e6286048dd4d7d48a1af38155e42126f00540))
* **migrate:** tolerate pre-mig-011 org_invitations on source ([93b05b7](https://github.com/wyre-technology/conduit/commit/93b05b75c5e9bbe1c4a593d31ff6b780c82b63f9))


### Features

* **consolidation:** fold mcp-gateway into Conduit ([#46](https://github.com/wyre-technology/conduit/issues/46)) ([4e8cf87](https://github.com/wyre-technology/conduit/commit/4e8cf878854c06655a660ad7da0572b323718d13))
* **db:** migration runner — apply migrations/*.sql at boot ([ffd529a](https://github.com/wyre-technology/conduit/commit/ffd529a07e447f0bd80b2b235ad76d05f2789e91))
* **deploy:** staging.conduit.wyre.ai auto-deploy path ([0d722b7](https://github.com/wyre-technology/conduit/commit/0d722b73e40667803cc89096ae7af8383f2ef011))
* **scim:** SCIM 2.0 inbound provisioning (tenant + reseller scope) ([#38](https://github.com/wyre-technology/conduit/issues/38)) ([400c9a0](https://github.com/wyre-technology/conduit/commit/400c9a07536c893c2a05589bf7887b4319c9e6e4))
* **security:** backport safe-fetch SSRF guard for ported vendors ([25a80c6](https://github.com/wyre-technology/conduit/commit/25a80c6e4796a97fa609d93a25cde171723ee4d6))

# [1.4.0](https://github.com/wyre-technology/wyre-mcp-gateway-platform/compare/v1.3.4...v1.4.0) (2026-04-21)


### Bug Fixes

* **test:** align brand tagline expectation with 'Customer MCP Gateway' ([#21](https://github.com/wyre-technology/wyre-mcp-gateway-platform/issues/21)) ([f9fa99b](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/f9fa99bd1082ab33d173239509b4b6316c2a821d))


### Features

* **brand:** BrandResolver with hierarchical org→parent→wyre-default ([6628724](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/6628724602d699eb0f8cae8af1342e3c0d75dbbb))
* **brand:** extend BrandConfig type for white-label schema ([501f736](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/501f736f5ff714a99ad6a9f1f28bfcb369bd9b27))
* **credentials:** reseller-shared credential resolution fallback ([7a3f04b](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/7a3f04b60f159b99e2929ffa7e5fac3ec9876d79))
* **docs:** Astro Starlight shell for Conduit documentation ([cda1378](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/cda13786df18ea8e66e523a11f9a5dcc7df0a88f))
* **migrations:** brand_profiles + white-label schema (008) ([b61bc0b](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/b61bc0bd9df45b5610d770911fd81bd8838012b6))
* **migrations:** impersonation_sessions + reseller_admin_audit (012) ([8749912](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/8749912344d46c851edaa75c1dd12ce8aff5f997))
* **migrations:** onboarding_progress + customer sub-org schema (009-010) ([c529d76](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/c529d76cd38e80a64e624c43ebe475163b3ff667))
* **migrations:** reseller tenancy schema + RLS (002-007) ([64ffd0a](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/64ffd0a54f5ec45c399ec51bcb315feb286f3df5))
* **org:** hash invitation tokens at rest (dual-write) ([804880a](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/804880a4cc474c4d433a92c7c81cb1b2b3b76974))
* **org:** reseller hierarchy helpers on OrgService ([b0891ea](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/b0891eaa6f41f27c0cd29ae681e1c92ae75b514b))
* **org:** ResellerMemberService with §5.2 permission matrix ([84892f0](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/84892f06978b5e7c1ce6a9ad048f366378bc3209))
* **platform-ops:** upstream sync tooling + release pipeline ([707e6d0](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/707e6d0b0e27e7177bce17180a2eb6c68cafac56))
* **proxy:** credential-injector uses reseller-shared fallback ([7b59fc7](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/7b59fc7a19c736dd2dc876e9bd85790aa3896d62))
* **reseller:** CRUD endpoints for reseller profile + members ([dc01763](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/dc01763003139b27b59db382aa1e377e5a0f6b2f))
* **reseller:** membership-gated Or404 lookups on ResellerService ([70fca5b](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/70fca5b85270df0b8f614eabd5234980e0659db3))
* **reseller:** middleware helpers for role + cross-tenant access ([1d05877](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/1d05877df305ae1fda7e698afecbb294a4045f87))
* **reseller:** scaffold reseller admin package behind feature flag ([8620154](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/862015413ac73867a708285f0029f25a4f7fb9c7))
* **security:** baseline security scanning (CodeQL/Deps/Gitleaks/Trivy) ([56a6891](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/56a6891fef53adfeba11a95c7d2faf50e5342926))
* **signup:** public /signup route with Auth0 login_hint + rate limit ([d4c8848](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/d4c884804de21c5415ef2f13325300dc106df1dd))
* **taskmaster:** initialize Conduit task backlog from 8 PRDs ([5af5fc7](https://github.com/wyre-technology/wyre-mcp-gateway-platform/commit/5af5fc7089ad01da3427deb1db95461516b0196b))

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
