# [1.10.0](https://github.com/wyre-technology/conduit/compare/v1.9.0...v1.10.0) (2026-05-13)


### Features

* **db:** mig 023 — conduit_is_reseller_admin_of_ancestor recursive helper ([#91](https://github.com/wyre-technology/conduit/issues/91)) ([2553469](https://github.com/wyre-technology/conduit/commit/255346941e9c9cbe65e2e817c6281d31fecaa1cc)), closes [#10](https://github.com/wyre-technology/conduit/issues/10)
* **ia:** hoist /settings/team/* + /settings/billing → /org/* with permanent 301 redirects ([#90](https://github.com/wyre-technology/conduit/issues/90)) ([3f7ee19](https://github.com/wyre-technology/conduit/commit/3f7ee193285bbcff2de4aaa60502f501ca62e115))

# [1.9.0](https://github.com/wyre-technology/conduit/compare/v1.8.0...v1.9.0) (2026-05-12)


### Bug Fixes

* **billing:** route remaining plan-gate sites through isPaidPlan helper ([#87](https://github.com/wyre-technology/conduit/issues/87)) ([740a163](https://github.com/wyre-technology/conduit/commit/740a163fe15204f100981fb3df98cf0132f0276a)), closes [72/#86](https://github.com/wyre-technology/conduit/issues/86)
* **deps:** bump fast-uri 3.1.0 → 3.1.2 for two HIGH CVEs ([#85](https://github.com/wyre-technology/conduit/issues/85)) ([b6edbc4](https://github.com/wyre-technology/conduit/commit/b6edbc43f336152c4d96ddca3105d2fd958d194b)), closes [HI#severity](https://github.com/HI/issues/severity)
* **gate:** match handler-gate to render-gate via isPaidPlan helper ([#71](https://github.com/wyre-technology/conduit/issues/71)) ([1ce8ca9](https://github.com/wyre-technology/conduit/commit/1ce8ca9db5a9820036ca7d73ed0ac81e9d72906a)), closes [#9](https://github.com/wyre-technology/conduit/issues/9)
* **gate:** sweep plan-equality drift in dashboard + audit API gates ([#72](https://github.com/wyre-technology/conduit/issues/72)) ([335741c](https://github.com/wyre-technology/conduit/commit/335741c92318ba17451499c76be5764c602f2393)), closes [#71](https://github.com/wyre-technology/conduit/issues/71) [#10](https://github.com/wyre-technology/conduit/issues/10) [#10](https://github.com/wyre-technology/conduit/issues/10) [#71](https://github.com/wyre-technology/conduit/issues/71) [#71](https://github.com/wyre-technology/conduit/issues/71)
* **layout:** remove dead sidebar nav items pointing at unregistered routes ([#70](https://github.com/wyre-technology/conduit/issues/70)) ([3c0b7d1](https://github.com/wyre-technology/conduit/commit/3c0b7d11f7ed291b028cb860ab68b431a21a1318)), closes [#69](https://github.com/wyre-technology/conduit/issues/69)


### Features

* **db:** mig 021 — relax enforce_org_hierarchy to bounded-depth-3 ([#83](https://github.com/wyre-technology/conduit/issues/83)) ([a555d10](https://github.com/wyre-technology/conduit/commit/a555d1012b2dd4e0cab85cc7e7864db0a908ac33)), closes [67-#73](https://github.com/67-/issues/73) [#74-pending](https://github.com/wyre-technology/conduit/issues/74-pending) [#75](https://github.com/wyre-technology/conduit/issues/75)
* **db:** mig 022 — Bug B sweep on remaining 9 UPDATE policies ([#86](https://github.com/wyre-technology/conduit/issues/86)) ([94b2041](https://github.com/wyre-technology/conduit/commit/94b204197d37e551729f832305fc6a70d90c95a2)), closes [#10](https://github.com/wyre-technology/conduit/issues/10)
* **layout:** IA restructure A — Organization parent + sub-nav (5 items) ([#73](https://github.com/wyre-technology/conduit/issues/73)) ([3b5b1c2](https://github.com/wyre-technology/conduit/commit/3b5b1c2b77d44b2b415d3447560e77c3f7212c07)), closes [#74](https://github.com/wyre-technology/conduit/issues/74) [#74](https://github.com/wyre-technology/conduit/issues/74) [#72](https://github.com/wyre-technology/conduit/issues/72) [#10](https://github.com/wyre-technology/conduit/issues/10) [#70](https://github.com/wyre-technology/conduit/issues/70) [#10](https://github.com/wyre-technology/conduit/issues/10) [#74](https://github.com/wyre-technology/conduit/issues/74) [#71](https://github.com/wyre-technology/conduit/issues/71)

# [1.8.0](https://github.com/wyre-technology/conduit/compare/v1.7.0...v1.8.0) (2026-05-11)


### Bug Fixes

* **auth:** restore Microsoft sign-in by mirroring mcp-gateway env handling ([#68](https://github.com/wyre-technology/conduit/issues/68)) ([14d0847](https://github.com/wyre-technology/conduit/commit/14d08475ff756572029dd991c126f8f31d7ac4e3))
* **landing:** non-customer Sign In goes through provider chooser, not Auth0-direct ([#69](https://github.com/wyre-technology/conduit/issues/69)) ([444dc71](https://github.com/wyre-technology/conduit/commit/444dc7115a17bceddfa99c78ea6a2cf424b77529)), closes [#68](https://github.com/wyre-technology/conduit/issues/68) [#68](https://github.com/wyre-technology/conduit/issues/68)
* **migrations:** recover 013_organization_domains and 014_rls_with_check_clauses ([0a9e64d](https://github.com/wyre-technology/conduit/commit/0a9e64d40a3df1e430218e7e3755614dd201e121)), closes [#38](https://github.com/wyre-technology/conduit/issues/38) [#46](https://github.com/wyre-technology/conduit/issues/46)
* **rls:** migration 020 — helper-context fix (Bug A) + UPDATE-USING repair (Bug B partial) ([b2a0a0b](https://github.com/wyre-technology/conduit/commit/b2a0a0b0a08d453ee148f32f2aca632a29d89f83)), closes [#65](https://github.com/wyre-technology/conduit/issues/65)
* **rls:** SECURITY DEFINER helpers replace recursive RLS predicates (mig 018) ([5e677bf](https://github.com/wyre-technology/conduit/commit/5e677bff73ddfa6b2a7ca677868af1cf76d55d1c))
* **rls:** temporarily remove organizations_insert WITH CHECK pending root cause ([c6e02b3](https://github.com/wyre-technology/conduit/commit/c6e02b3eb59202fd1e61bdee1a537ef03b6383d7))
* **scim/integration-harness:** repair stale organizations bootstrap ([317545d](https://github.com/wyre-technology/conduit/commit/317545d86b6ed6f02352c8128710ff5831ae0a36)), closes [#46](https://github.com/wyre-technology/conduit/issues/46) [#46](https://github.com/wyre-technology/conduit/issues/46)


### Features

* **admin:** platform admin dashboard + orgs + reports ([#56](https://github.com/wyre-technology/conduit/issues/56)) ([bdc0dca](https://github.com/wyre-technology/conduit/commit/bdc0dca97409360e256fd32f0d437bfa46705339))
* **db/migrate:** assert numeric contiguity of migrations on boot ([4b487ca](https://github.com/wyre-technology/conduit/commit/4b487caf01cdbaa0f6a4df7e0cefbf8f0f8c05cf)), closes [#38](https://github.com/wyre-technology/conduit/issues/38) [#46](https://github.com/wyre-technology/conduit/issues/46)
* **migrations:** 015 drop plaintext invitation token column ([8f570b1](https://github.com/wyre-technology/conduit/commit/8f570b131980cf6277e0f52211ff7a30c73623d7))
* **scripts:** pre-migration backfill for invitation token_hash ([b1905d6](https://github.com/wyre-technology/conduit/commit/b1905d6ad8076ceae82a71faeb11f16da7766dd4))
* **ui:** adopt WYRE visual design (cyan accent, Oswald headings) ([#57](https://github.com/wyre-technology/conduit/issues/57)) ([3b11b5e](https://github.com/wyre-technology/conduit/commit/3b11b5e25d826a6e0723ba60f404752593338331)), closes [#00C9DB](https://github.com/wyre-technology/conduit/issues/00C9DB) [#2563eb](https://github.com/wyre-technology/conduit/issues/2563eb) [#EDE947](https://github.com/wyre-technology/conduit/issues/EDE947)
* **ui:** port legal pages (Terms, Privacy) ([#58](https://github.com/wyre-technology/conduit/issues/58)) ([3cc74dd](https://github.com/wyre-technology/conduit/commit/3cc74dd2cceb64e0f44e150d154aa721b1735cfa))

# [1.7.0](https://github.com/wyre-technology/conduit/compare/v1.6.1...v1.7.0) (2026-05-08)


### Features

* **auth:** multi-provider login (Auth0 + Microsoft Entra side-by-side) ([#54](https://github.com/wyre-technology/conduit/issues/54)) ([0365ee3](https://github.com/wyre-technology/conduit/commit/0365ee3db543781e44abf3568cf2529553fbe433))
* **loops:** wire user signup + org_created drips ([#50](https://github.com/wyre-technology/conduit/issues/50)) ([08431cd](https://github.com/wyre-technology/conduit/commit/08431cd5166c9a7a8df79b5a8f9575ed5361f30f))

## [1.6.1](https://github.com/wyre-technology/conduit/compare/v1.6.0...v1.6.1) (2026-05-07)


### Bug Fixes

* **ci:** skip SARIF upload from fork/dependabot PRs ([#49](https://github.com/wyre-technology/conduit/issues/49)) ([17e42dd](https://github.com/wyre-technology/conduit/commit/17e42dd012e470de1b5928d4768781dfa6f85674))

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
- `docs/security.md` — initial customer-facing security documentation
  covering credential encryption, trust model (with org-standard
  anti-claim language on certifications), authentication, multi-tenant
  + subtenant isolation, prompt injection defenses, billing/dunning
  security, and audit logging.
- `docs/deploying.md` — Cloudflare Pages deployment guide for the docs
  site under `conduit.wyre.ai/docs`.

#### Changed
- Docs site is now configured for the public path
  `https://conduit.wyre.ai/docs` (Astro `site` + `base: '/docs'` in
  `docs/astro.config.mjs`). Previously a placeholder
  `https://docs.conduit.example`.
- Migrated security documentation into the Starlight content tree at
  `docs/src/content/docs/reference/security.mdx`. The legacy
  `docs/security.md` was a draft markdown file that the Starlight build
  did not serve — customers could not read it at
  `conduit.wyre.ai/docs`. The Starlight version is now sidebar-linked
  under **Reference**. The legacy file is retained as engineering
  reference with a "MIGRATED" pointer at the top, pending the broader
  legacy `docs/*.md` sweep-delete.

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
