# PRD: White-Label Branding for Conduit

**Tag:** `white-label`
**Owner:** Platform / Conduit team
**Status:** Draft v1 (for taskmaster parse)
**Last updated:** 2026-04-18
**Related docs:**
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/docs/white-label.md` (existing env-var approach)
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/brand/index.ts` (current `BrandConfig` + env-var loader)
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/brand/customers.ts` (hardcoded per-customer overrides registry — e.g. `lubing`)
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/brand/types.ts` (`BrandConfig` type)
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/docs/feature-requests/per-org-email-branding.md` (referenced but not present in checked-out tree — source of truth for email-branding intent)

---

## 1. Problem statement

Conduit is the white-label MSP channel/reseller distribution of Wyre's mcp-gateway. Today, branding is driven entirely by `BRAND_*` environment variables baked into a deployment (see `src/brand/index.ts`). That model made sense when each MSP got its own container, but Conduit's reseller model requires:

1. **A single Conduit deployment serving many MSP resellers**, each with independently branded experiences for their downstream customers.
2. **Hierarchical inheritance**: Wyre brands the reseller-admin UI that MSPs see; MSPs brand the customer UI that their end customers see; customers may override a narrow set of fields if the MSP permits.
3. **Zero-leak branding**: a customer of MSP X should never see Wyre strings, logos, domains, or email From-addresses anywhere in their journey.
4. **Operator escape hatch**: Wyre staff must still be able to see un-branded or Wyre-branded views when debugging a customer-facing issue.

The existing env-var approach (`BRAND_NAME`, `BRAND_LOGO_URL`, etc.) and the hardcoded `customerBrands` registry in `src/brand/customers.ts` cannot scale to a self-serve reseller model and must be migrated to database-backed, per-org brand profiles without breaking any current deployment.

## 2. Goals / non-goals

### Goals
- G1. Allow a Wyre operator to create a reseller (MSP) org and configure its brand via admin UI.
- G2. Allow an MSP org admin to configure their own brand (within Wyre-granted bounds) and optionally per-customer overrides.
- G3. Route requests by Host header to the correct brand, including custom domains with valid TLS.
- G4. Render every customer-visible surface (web UI, emails, invoice PDFs, OAuth consent, favicons, meta tags) in the correct brand with no Wyre strings leaking to a customer of an MSP.
- G5. Cache brand lookups so page TTFB is not regressed (<5ms brand resolution overhead P95).
- G6. Migrate existing `BRAND_*` env-driven deployments to DB-backed profiles behind a feature flag, with a clean rollback.
- G7. Keep the Wyre-internal staff/admin view always resolvable on a known `*.wyre.*` hostname, regardless of any custom-domain config.

### Non-goals (out of scope for v1)
- Per-user branding (individual end users theming their dashboard).
- White-label mobile app.
- Affiliate / referral program UI.
- Per-reseller fully custom HTML/React components.
- Reseller-operated SMTP relays (stretch — see v2 email section).
- Per-org internationalization / translation of UI copy.
- Branded marketing/landing site builder (`public/` is built by an external Astro pipeline — out of scope here).

## 3. Personas

- **Wyre operator (platform admin)** — creates reseller orgs, sets quotas, handles escalations. Always sees Wyre-branded UI. Can "impersonate" to see any brand.
- **MSP owner / reseller admin (e.g., TechForce)** — signs up (or is provisioned) as a reseller, configures their brand once, onboards customer sub-orgs. Sees Wyre branding in the reseller-admin surface (they know they are on Wyre), sees their own branding in customer-facing surfaces.
- **MSP support engineer** — member of MSP org, uses reseller-admin tools to help their customers. Same branding rules as MSP owner.
- **Customer admin (end-customer of MSP)** — admin of a sub-org under the MSP. Sees only MSP X's brand, never Wyre. May optionally set their own logo/color if MSP permits.
- **Customer end-user** — regular user of a customer org. Sees MSP X's brand (or customer-override brand if set). Never sees Wyre.

## 4. Branding scope (what gets branded)

Every surface below must resolve to the active brand profile for the request. The *active profile* = the customer's profile (if set and complete) ⟶ falling back to the parent MSP's profile ⟶ falling back to the Wyre default.

| # | Surface | Source file(s) (today) | Branded? | Notes |
|---|---------|------------------------|----------|-------|
| 1 | Sidebar & mobile header | `src/web/layout.ts` (`.sidebar-brand`, `.mobile-brand`) | Yes | Logo + name + color tokens |
| 2 | Browser tab title + meta | `src/web/layout.ts` line 283 (`<title>`) | Yes | `${title} - ${brand.name}` |
| 3 | Favicon | not currently set | Yes | Per-brand upload |
| 4 | OG image / social meta | not currently set | Yes | Per-brand upload |
| 5 | Dashboard chrome (header/footer/nav) | `src/web/layout.ts`, `src/web/styles.ts` | Yes | Color tokens + logo |
| 6 | Connect / OAuth consent screens | `src/web/templates/connect.ts` | Yes | Brand name + logo + support link |
| 7 | Credential / team connection pages | `src/web/templates/team-connections.ts`, `team-team-connections.ts`, `team-service-client-connections.ts` | Yes | `.brand` element |
| 8 | Success / landed pages | `src/web/helpers.ts` | Yes | `.brand` element |
| 9 | Invitation pages (Join org) | `src/org/routes.ts` line 961, `src/org/routes/invitations.ts` line 45 | Yes | Title + `.brand` |
| 10 | Waitlist page | `src/waitlist/routes.ts` line 241 | Yes | Title + `.brand` (currently hardcodes `MCP Gateway`) |
| 11 | Auth0 / Azure AD error & support report URLs | `src/auth/auth0.ts` line 256, `src/auth/azure-ad.ts` line 241 | Yes | `brand.issuesUrl` must become reseller support URL for customer surface |
| 12 | Transactional emails: invite | not yet extracted / see feature-request | Yes | From name, from address, logo, colors, footer |
| 13 | Transactional emails: password reset | Auth0 (currently) | Yes | Auth0 templating — resolves by reseller |
| 14 | Transactional emails: billing | `src/billing/*` | Yes | Resellers' invoices branded with MSP; Wyre→MSP invoices stay Wyre-branded |
| 15 | Transactional emails: audit / alerts | `src/audit/*` | Yes | Branded by target org |
| 16 | Invoice PDFs | (TBD — v1 only MSP is billed by Wyre; customers not billed) | Wyre→MSP Wyre-branded; MSP→customer out of scope for v1 | |
| 17 | Support links (all "Contact support") | everywhere that references `brand.supportUrl` / `issuesUrl` | Yes | Goes to MSP's support channel, not Wyre's GitHub issues |
| 18 | OAuth app display names | `src/oauth/*` | Partial | Display name per brand when acting on behalf of an MSP-branded customer |
| 19 | Public landing | `public/` (built externally via Astro) | Not covered here | Out of scope — separate pipeline |
| 20 | Custom domain | N/A today | Yes | MSP X's customers hit `portal.mspx.com` with MSP X TLS cert |

## 5. Branding inheritance model

Three tiers:

```
Wyre default brand (ships with product)
   │
   ├── Reseller brand (owned by MSP org, row in brand_profiles)
   │      │
   │      ├── Customer-org brand override (optional row in brand_profiles with parent_brand_id)
   │      └── …
   │
   └── (other resellers)
```

### Resolution rules
1. On every request, resolve the **target org** (the org whose data is being viewed). If the user is browsing their own org, target = their org. If the user is viewing a sub-org (MSP admin drilling into a customer), target = the sub-org.
2. Look up the target org's `brand_profile_id`. If set, use it.
3. Else walk to the org's `parent_org_id` and repeat.
4. Else fall back to the reseller default brand (Wyre default) — identified by `is_wyre_default = true`.

### What each actor can override
| Field | Wyre-operator sets | MSP admin can override | Customer admin can override (if MSP-permitted) |
|-------|--------------------|------------------------|-----------------------------------------------|
| `name`, `tagline` | Default | Yes | Yes |
| `logo_url`, `favicon_url`, `og_image_url` | Default | Yes | Yes |
| `primary_color`, `accent_color` | Default | Yes | Yes |
| `heading_font`, `body_font`, `border_radius` | Default | Yes | No (avoid "design chaos" at customer tier) |
| `support_url`, `docs_url`, `issues_url` | Default | Yes | Optional |
| `custom_domain` | — | Yes (must verify) | No (uses MSP subpath or MSP domain) |
| `from_email_display_name` | Default | Yes | No (v1) |
| `allow_customer_overrides` (flag) | — | Yes (boolean, defaults false) | — |

An MSP may set `allow_customer_overrides = false` to prevent their customers from rebranding at all — then all customers inherit the MSP brand rigidly.

## 6. Storage: brand assets

### Assets
- Logos (SVG preferred; PNG ≤ 512 KB; no JPEG for logos)
- Favicons (32×32 and 180×180 PNG, or SVG)
- OG images (1200×630 PNG ≤ 1 MB)

### Where
- **Primary**: Azure Blob Storage (already available; `infrastructure/` / `azure/` dirs exist in repo).
  - Container: `conduit-brand-assets`
  - Path: `/{org_id}/{asset_type}/{sha256}.{ext}`
  - Served via Azure CDN (Front Door) with immutable cache headers + content hash in URL.
- Upload endpoint authenticated as org admin. Size-limited, MIME-sniffed, SVG scrubbed (strip `<script>`, `onload=`, `xlink:href=javascript:`, external refs) via a server-side sanitizer (e.g., `dompurify` server mode or `svg-sanitizer`).
- Max 5 MB per upload. Stored URL recorded in `brand_profiles.logo_url` etc.
- Deletion: soft-delete asset record; blob kept for 30 days for rollback.

### Fallback
If Azure Blob is not configured in a deployment, support an S3-compatible config and a local-disk fallback for on-prem. Config keys:
- `BRAND_ASSET_STORAGE` = `azure_blob` | `s3` | `local`
- `BRAND_ASSET_PUBLIC_BASE_URL`
- Provider-specific creds from existing infra.

## 7. Custom domains

### Flow (MSP-initiated)
1. MSP enters `portal.mspx.com` in reseller admin UI.
2. Conduit creates a `custom_domains` row in `pending` status; shows the MSP:
   - CNAME target: `ingress.conduit.wyre.io` (or Wyre-owned edge)
   - ACME DNS-01 TXT record (`_acme-challenge.portal.mspx.com`) OR instructs to add CNAME and rely on HTTP-01.
3. Conduit verification worker polls DNS every 60s (max 48h). On success → status `verifying_tls`.
4. TLS cert issued via ACME (Let's Encrypt, per-domain; wildcard NOT viable since MSP domain is not under our control). Store cert material in Azure Key Vault.
5. Cert live → status `active`. Requests to that Host header resolve to the MSP's brand.
6. Auto-renew 30 days before expiry; alert MSP + Wyre ops on failure.

### Tenant resolution by Host header
- New middleware `src/brand/host-resolver.ts`:
  1. Read `Host` header (trust-proxy aware).
  2. Lookup in `custom_domains` → resolves to `org_id`.
  3. If `Host` matches Wyre-canonical (`*.wyre.io`, `gateway.wyre.io`), treat as Wyre-admin surface (no brand override; Wyre default).
  4. If no match → serve generic Wyre default OR 421 Misdirected Request if strict mode.
- Cache `Host` → `brand_profile_id` in Redis (TTL 60s, invalidated on brand/domain update).

### TLS strategy
- v1: per-domain ACME (Let's Encrypt) with automated renewal via `acme-client` npm package or Caddy reverse proxy.
- v2 (stretch): optional "bring your own cert" upload for MSPs with strict compliance needs.
- Wildcard: Wyre-owned `*.conduit.wyre.io` gets a single wildcard cert; each MSP gets a free subdomain `{slug}.conduit.wyre.io` even without custom domain.

## 8. Email sending strategy

### v1 (ship first)
- **All email sent from Wyre-owned sending domain** (e.g., `mail.conduit.wyre.io`), properly SPF/DKIM/DMARC aligned.
- **From header**: `"{MSP display name} via Conduit" <noreply@mail.conduit.wyre.io>`.
- **Reply-To**: MSP's configured support email.
- **Body**: rendered with MSP brand (logo, colors, footer).
- This avoids every MSP needing to prove domain ownership before first email sends. Works immediately.

### v2 (per-reseller domains)
- MSP verifies a sending domain (`mail.mspx.com`) via DKIM + SPF include + DMARC record.
- Conduit uses per-domain sending identities (e.g., SES configuration set, SendGrid subuser, or Postmark server). Provider TBD — recommend a single transactional provider that supports multi-tenant (SendGrid, Postmark, Resend, or SES).
- MSP's customer emails appear to come from `noreply@mail.mspx.com` with full alignment.
- Feature-flagged per MSP.

### Deliverability
- v1 shared IP pool with per-reseller SPF/DKIM still pointing at Wyre domain — reseller's reputation is Wyre's reputation.
- v2 decouples (stretch).

### Template system
- One set of template files with brand tokens:
  - `src/email/templates/invite.tsx` (or `.hbs`) using `{{brand.name}}`, `{{brand.logo_url}}`, `{{brand.primary_color}}`.
  - Rendered via MJML → HTML + plaintext.
- Tests: snapshot test per template × brand.

## 9. CSS theming: tokens not raw CSS

Use **design tokens** only. An MSP cannot inject arbitrary CSS. The brand record contains:

- Colors: `primary_color`, `accent_color`, `text_primary`, `text_secondary`, `bg_primary`, `bg_secondary`, `border_color` (all hex strings, regex-validated `^#[0-9a-fA-F]{6}$`).
- Typography: `heading_font`, `body_font` — each an enum selected from a Wyre-curated Google Fonts allowlist (prevents CSS injection via font URL).
- Radii / spacing: `border_radius` (integer 0–24 px).
- Logo / favicon / og-image URLs (must be in the brand-assets CDN — validated on save).

Rendered at request time as an inline `<style>:root { --primary-color: {{hex}}; … }</style>` block. No user-supplied CSS is ever concatenated into the page.

**Rationale**: prevents CSS/XSS/phishing-overlay attacks, keeps the design system consistent, enables audit of what MSPs are doing.

## 10. Wyre-internal / debugging views

- All Wyre staff access Conduit via `admin.conduit.wyre.io` (canonical hostname). Middleware detects this Host and forces `brand = wyreDefault`, ignoring any org-level brand override, unless the operator explicitly opts into "preview as reseller".
- A new "Preview as brand" mode in the Wyre operator UI sets a short-lived cookie (`brand_preview={brand_id}`) that overrides resolution on this session only. Banner: "Previewing as {brand.name} — [exit]".
- Audit log: every `brand_preview` activation writes an audit entry (`brand.preview.started`, `brand.preview.ended`).

## 11. Migration from `BRAND_*` env vars

Current state (see `src/brand/index.ts`): a single module-level `brand: BrandConfig` built from env vars at process start. Also `src/brand/customers.ts` with a hardcoded `customerBrands` registry (just `lubing` today).

### Migration plan
1. **Phase 0 (behind flag)**: add `FEATURE_DB_BRANDING` env var (default `false`). Ship DB schema, admin UI, and host resolver in "read-only fallback" mode — if a brand profile is found, use it; otherwise fall back to env-var `brand` object.
2. **Phase 1 (per-deployment opt-in)**: for each existing Conduit deployment, an operator runs a one-time migration script `scripts/migrate-brand-env-to-db.ts`:
   - Reads all `BRAND_*` env vars.
   - Inserts a row into `brand_profiles` with `is_wyre_default = true` (if Wyre deployment) or seeds as the single-tenant MSP brand.
   - Also imports hardcoded entries from `src/brand/customers.ts` into `brand_profiles` keyed by the customer org slug.
3. **Phase 2 (flag on everywhere)**: flip `FEATURE_DB_BRANDING=true`; the env-var pathway is used only as a last-resort default for Wyre brand defaults if the DB has no Wyre-default row.
4. **Phase 3 (cleanup)**: remove the env-var read path from `src/brand/index.ts`; keep env vars only as seeds for fresh installs. Remove `src/brand/customers.ts`.

### Backwards-compat guarantee
- For any deployment where no operator has migrated, behavior is unchanged (env-vars still win until `FEATURE_DB_BRANDING=true`).
- No changes required to existing docker-compose files until the flag is flipped.

## 12. Caching

Brand resolution happens on every request. Three layers:

1. **In-memory LRU per process** (keyed by `org_id`, max 5k entries, TTL 60s). Handles hot path.
2. **Redis cache** (keyed by `host:` + host, and `org:` + org_id; TTL 300s). Shared across processes.
3. **Postgres** (source of truth).

### Invalidation
- On `PATCH /admin/brand-profiles/:id` or domain verification transition → publish `brand.invalidated` event on Redis pub/sub. All processes drop matching LRU entries. Redis entry deleted directly by the write path.
- On asset upload that changes a URL → same event.
- Version field on `brand_profiles.version` (bigint, increments on every update); response cache key includes `version` so CDN / browser don't serve stale CSS between invalidation and next load.

### Performance target
- Brand resolution adds ≤5ms P95 to request latency under cache hit.
- Cold cache (DB hit) ≤25ms P95.

## 13. Schema sketch

Migration file: `migrations/00X_brand_profiles.sql` (number assigned at implementation time).

```sql
-- Brand profile — one row per distinct brand.
-- Wyre ships one row seeded as is_wyre_default = true.
-- Each MSP org has exactly one brand row (MSP tier).
-- Customer orgs MAY have a row that inherits from parent (customer tier).
CREATE TABLE IF NOT EXISTS brand_profiles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID REFERENCES orgs(id) ON DELETE CASCADE,
  parent_brand_id         UUID REFERENCES brand_profiles(id) ON DELETE SET NULL,
  tier                    TEXT NOT NULL CHECK (tier IN ('wyre_default','reseller','customer')),
  is_wyre_default         BOOLEAN NOT NULL DEFAULT false,

  -- Identity
  name                    TEXT NOT NULL,
  tagline                 TEXT,
  from_email_display_name TEXT,
  support_url             TEXT,
  support_email           TEXT,
  docs_url                TEXT,
  issues_url              TEXT,

  -- Visual
  logo_url                TEXT,
  logo_dark_url           TEXT,           -- optional dark-mode variant
  favicon_url             TEXT,
  og_image_url            TEXT,
  primary_color           TEXT CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color            TEXT CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  text_primary            TEXT CHECK (text_primary ~ '^#[0-9a-fA-F]{6}$'),
  text_secondary          TEXT CHECK (text_secondary ~ '^#[0-9a-fA-F]{6}$'),
  bg_primary              TEXT CHECK (bg_primary ~ '^#[0-9a-fA-F]{6}$'),
  bg_secondary            TEXT CHECK (bg_secondary ~ '^#[0-9a-fA-F]{6}$'),
  border_color            TEXT CHECK (border_color ~ '^#[0-9a-fA-F]{6}$'),
  heading_font            TEXT,           -- must be on allowlist
  body_font               TEXT,           -- must be on allowlist
  border_radius           INTEGER CHECK (border_radius BETWEEN 0 AND 24),

  -- Controls
  allow_customer_overrides BOOLEAN NOT NULL DEFAULT false,

  -- Concurrency / caching
  version                 BIGINT NOT NULL DEFAULT 1,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by              UUID REFERENCES users(id),
  updated_by              UUID REFERENCES users(id)
);

-- Exactly one Wyre default.
CREATE UNIQUE INDEX brand_profiles_one_wyre_default
  ON brand_profiles (is_wyre_default)
  WHERE is_wyre_default = true;

-- Fast lookup by org.
CREATE UNIQUE INDEX brand_profiles_one_per_org
  ON brand_profiles (org_id)
  WHERE org_id IS NOT NULL;

-- Font allowlist (editable by Wyre ops only).
CREATE TABLE IF NOT EXISTS brand_font_allowlist (
  id            SERIAL PRIMARY KEY,
  family_name   TEXT UNIQUE NOT NULL,
  google_fonts  BOOLEAN NOT NULL DEFAULT true,
  weight_css    TEXT,
  active        BOOLEAN NOT NULL DEFAULT true
);

-- Custom domains.
CREATE TABLE IF NOT EXISTS custom_domains (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  hostname           TEXT UNIQUE NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','verifying_dns','verifying_tls','active','failed','revoked')),
  dns_token          TEXT,                     -- ACME DNS-01 token
  tls_cert_ref       TEXT,                     -- Key Vault ref
  tls_cert_not_after TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX custom_domains_active_hostname
  ON custom_domains (hostname)
  WHERE status = 'active';

-- Brand assets (logos etc.). Blobs stored externally, metadata here.
CREATE TABLE IF NOT EXISTS brand_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('logo','logo_dark','favicon','og_image')),
  content_hash     TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  public_url       TEXT NOT NULL,
  uploaded_by      UUID REFERENCES users(id),
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

CREATE INDEX brand_assets_org_kind ON brand_assets (org_id, kind) WHERE deleted_at IS NULL;

-- Audit of brand-preview / impersonation by Wyre operators.
CREATE TABLE IF NOT EXISTS brand_preview_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  UUID NOT NULL REFERENCES users(id),
  brand_id     UUID NOT NULL REFERENCES brand_profiles(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  reason       TEXT
);
```

### Updated `BrandConfig` type

`src/brand/types.ts` evolves (additive — existing fields remain):

```typescript
export interface BrandConfig {
  id: string;                       // brand_profiles.id
  orgId: string | null;
  parentBrandId: string | null;
  tier: 'wyre_default' | 'reseller' | 'customer';

  name: string;
  tagline: string;
  fromEmailDisplayName: string;
  supportUrl: string;
  supportEmail: string;
  docsUrl: string;
  issuesUrl: string;

  logoUrl: string;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;

  primaryColor: string;
  accentColor: string;
  textPrimary: string;
  textSecondary: string;
  bgPrimary: string;
  bgSecondary: string;
  borderColor: string;

  headingFont: string;
  bodyFont: string;
  borderRadius: number;

  allowCustomerOverrides: boolean;

  /** Public domain if custom-domain is active; else canonical *.conduit.wyre.io host. */
  domain: string;

  version: number;
}
```

## 14. API surface

All endpoints under `/admin/*` require `wyre_operator` role. All `/reseller/*` require org-admin of an MSP-tier org. All `/org/:id/brand/*` require org-admin of that org.

- `GET /admin/brand-profiles` — Wyre ops: list all brands.
- `POST /admin/brand-profiles` — create a Wyre-default or reseller seed.
- `PATCH /admin/brand-profiles/:id` — Wyre ops edit any brand.
- `GET /reseller/brand` — MSP admin reads own brand.
- `PATCH /reseller/brand` — MSP admin edits own brand (subject to Wyre-locked fields).
- `POST /reseller/brand/assets` — multipart upload, returns CDN URL.
- `GET /reseller/custom-domains` — list + status.
- `POST /reseller/custom-domains` — add hostname, returns verification instructions.
- `POST /reseller/custom-domains/:id/verify` — trigger verification poll now.
- `DELETE /reseller/custom-domains/:id` — revoke.
- `GET /org/:id/brand` — customer admin reads (or parent MSP admin drilling in).
- `PATCH /org/:id/brand` — customer admin updates own brand (only if `allow_customer_overrides=true` on parent).
- `POST /admin/brand-preview` — Wyre operator toggles preview mode.

All endpoints honor the "API endpoints must be authenticated" global rule. Request validation via zod schemas (project already uses zod patterns elsewhere). Rate-limit asset uploads (10/min/org).

## 15. Acceptance criteria

Each criterion must be testable as an automated test or a documented manual QA step.

1. A Wyre operator can create a new reseller org and set its `brand_profiles` row via admin UI; the reseller's login page at `{slug}.conduit.wyre.io` immediately renders the new brand.
2. An MSP admin can upload a logo ≤5 MB (PNG, JPG, SVG) via `/reseller/brand/assets`; the upload is virus/MIME-validated, SVGs are sanitized (script tags stripped), and the returned URL is served from the brand-assets CDN with cache-control `public, max-age=31536000, immutable`.
3. When a customer of MSP X logs into their dashboard at `portal.mspx.com`, every visible string, logo, favicon, and color matches MSP X's brand; no string "Wyre" appears anywhere in the HTML, inline CSS, or meta tags.
4. When an MSP admin logs into the reseller-admin area, they see Wyre branding (operator-facing surface) — confirmed by automated snapshot test.
5. A transactional email sent to a customer of MSP X has From name "{MSP X display} via Conduit", Reply-To set to MSP X's support email, body rendered with MSP X's logo + colors; rendered HTML contains no Wyre strings.
6. An MSP admin adds `portal.mspx.com` as a custom domain; within 5 minutes of correct DNS, the domain transitions through `verifying_dns` → `verifying_tls` → `active`; requests to `https://portal.mspx.com` are served with a valid cert (not self-signed).
7. If `allow_customer_overrides=false` on an MSP's brand, `PATCH /org/:id/brand` for a child customer returns `403` and does not mutate state.
8. If `allow_customer_overrides=true`, a customer admin can set their own `logo_url`, `primary_color`, `name`; font-family fields remain immutable (returns `403` with `field_locked`).
9. Brand-profile updates invalidate both in-memory LRU and Redis cache within 2s P95; subsequent page loads reflect the new brand immediately.
10. Font selection rejects any `heading_font` / `body_font` value not in `brand_font_allowlist` (returns 400).
11. Color fields reject any value not matching `^#[0-9a-fA-F]{6}$`.
12. Migration script `scripts/migrate-brand-env-to-db.ts` run on a Wyre deployment produces exactly one row with `is_wyre_default=true`, all fields populated from `BRAND_*` env; running twice is idempotent.
13. With `FEATURE_DB_BRANDING=false`, the product behaves identically to today (env-var driven) — regression-test by running existing `src/brand/brand.test.ts` suite unchanged.
14. Wyre operator activating "Preview as {brand}" writes a `brand_preview_audit` row; exiting preview writes `ended_at`.
15. Requests to `admin.conduit.wyre.io` always resolve to Wyre-default brand even if a DB record says otherwise.
16. Brand resolution adds ≤5ms P95 latency on cache hit (measured via OpenTelemetry histogram `conduit.brand.resolve_ms`).
17. SVG upload containing a `<script>` tag or `onload=` attribute is rejected (returns 422 with reason).
18. OAuth consent screen (`src/web/templates/connect.ts`) title, logo, and support link reflect the resolving brand, verified by snapshot test per tier.
19. Waitlist page (`src/waitlist/routes.ts`) displays the resolving brand instead of hardcoded "MCP Gateway".
20. `issuesUrl` used by Auth0/Azure error pages (`src/auth/auth0.ts`, `src/auth/azure-ad.ts`) resolves to the tenant's configured support URL, not the Wyre GitHub issues URL, when viewed by a customer.

## 16. Security considerations

- **SVG XSS** — all uploaded SVGs run through a sanitizer that strips `<script>`, event handlers, foreign-namespace elements, and external `xlink:href` references. Covered by automated tests.
- **Open redirect via support URL** — all outbound support/docs/issues URLs rendered with `rel="noopener noreferrer"` and validated on save (must be HTTPS, no javascript:/data: schemes).
- **Host-header spoofing** — trust-proxy config required; Host only taken from the configured ingress, never from arbitrary clients.
- **Cross-tenant leakage** — tests must assert that requests under `portal.mspx.com` cannot retrieve any org data from MSP Y, even if authenticated as a user who belongs to both. Covered by existing multi-tenant security patterns.
- **Reseller SSRF via logo URL** — the logo URL is always a Conduit-controlled CDN URL (uploaded first, then referenced). MSPs cannot paste arbitrary `http://internal/…` URLs.
- **Cert private keys** — stored only in Azure Key Vault; never logged.
- **Brand preview cookie** — HTTP-only, `SameSite=Strict`, 30-minute lifetime, bound to operator session.

## 17. Observability

- Metrics (Prometheus-style, via existing OTel setup):
  - `conduit.brand.resolve_ms` histogram (p50/p95/p99), tagged by `cache_layer` ∈ {`lru`,`redis`,`db`}.
  - `conduit.brand.cache_hit_ratio` gauge.
  - `conduit.custom_domain.status{hostname,status}` gauge.
  - `conduit.brand.asset_upload_bytes` counter.
- Audit log events (into existing audit system):
  - `brand.profile.created`, `brand.profile.updated`, `brand.asset.uploaded`, `brand.asset.deleted`
  - `brand.domain.added`, `brand.domain.verified`, `brand.domain.failed`, `brand.domain.revoked`
  - `brand.preview.started`, `brand.preview.ended`
- Alerts:
  - Custom-domain cert expires in <14 days → warn; <3 days → page.
  - DNS verification backlog > 50 → warn.
  - Brand cache hit ratio < 0.9 → warn.

## 18. Rollout plan

- **Week 1-2**: schema + migrations, asset storage, `brand_profiles` CRUD behind feature flag. No UI wiring yet.
- **Week 3**: host-resolver middleware, LRU + Redis caching, brand-resolution in request context. Wyre default seed.
- **Week 4**: MSP reseller-admin UI for brand editing + asset upload + font allowlist.
- **Week 5**: custom-domain flow (DNS verification, ACME integration).
- **Week 6**: email template branding (v1 — Wyre-owned domain with display-name spoof).
- **Week 7**: operator preview mode, audit, observability dashboards.
- **Week 8**: run migration for Wyre's own deployment; flip `FEATURE_DB_BRANDING=true` in one canary deployment; monitor; flip globally.
- **Post-GA**: deprecate env-var branding (Phase 3 cleanup).

## 19. Open questions

1. **Email provider**: Postmark vs. SendGrid vs. SES vs. Resend — who offers best multi-tenant subuser model for v2? (Decision needed before email work starts.)
2. **Invoice PDFs to customers**: v1 assumes Wyre bills MSP and MSP bills their own customer via their own ops; Conduit does not issue PDF invoices to end customers. Confirm with Billing PRD owner.
3. **Auth0 Universal Login branding**: Auth0 supports per-connection branding (logo, colors, text) but not fully per-tenant at runtime. Do we stand up Auth0 tenants per reseller, or fork to a hosted login page we control? (Blocker for acceptance criterion #3 email-from-anywhere-no-Wyre.)
4. **Shared vs. dedicated CNAME target**: if we use Caddy reverse-proxy for auto-TLS vs. ACME client library, which fits Azure Container Apps topology best?
5. **Fallback brand when custom domain DNS breaks mid-flight**: show "Domain misconfigured" page with Wyre branding? With MSP branding from DB? Silent fallback to `{slug}.conduit.wyre.io`?
6. **Do we support per-request "preview" for an MSP admin** (seeing their customer's view) or only for Wyre operators? Leaning: yes for MSP admins too, scoped to their own subtree.
7. **OG images**: dynamic (render brand name + logo composite) or static upload only? v1 leans static upload.
8. **How do we handle a customer org whose MSP changes its brand** — do cached customer sessions need forced logout? Leaning: no, just cache-bust.
9. **Dark mode**: enough resellers care to carry `logo_dark_url` etc., or defer until demanded?
10. **Should the Wyre "issues_url" (currently pointing at `wyre-technology/msp-claude-plugins`) be renamed/replaced for the Conduit repo**? Orthogonal cleanup — call out but don't block on.

## 20. Out of scope (restated)

- Per-user branding.
- White-label mobile app.
- Affiliate / referral program UI.
- Per-reseller fully custom frontend components / arbitrary CSS.
- Reseller-run SMTP relays (v2 stretch).
- Per-tenant i18n.
- Astro-built marketing landing (`public/` dir) — separate pipeline.

---

## Proposed task list

Each bullet maps to a top-level taskmaster task inside the `white-label` tag. Intentionally sized so most expand to 4–8 subtasks.

1. **Schema & migrations** — add `brand_profiles`, `custom_domains`, `brand_assets`, `brand_font_allowlist`, `brand_preview_audit` tables; seed Wyre-default row and font allowlist.
2. **`BrandConfig` type + resolver core** — extend `src/brand/types.ts`; implement `resolveBrand(req)` that walks org → parent → wyre-default; unit tests.
3. **Host-header resolution middleware** — new `src/brand/host-resolver.ts`; trust-proxy aware; fallback rules; integration tests.
4. **Caching layer** — in-process LRU + Redis pub/sub invalidation; observability counters; cache-hit-ratio dashboard.
5. **Brand asset storage** — Azure Blob adapter (primary), S3/local fallbacks; SVG sanitization; MIME/size validation; `POST /reseller/brand/assets` endpoint.
6. **Reseller-admin brand CRUD API** — authenticated `/reseller/brand` endpoints with zod validation; enforce Wyre-locked fields; field-level `allow_customer_overrides` checks.
7. **Reseller-admin brand UI** — form for colors, fonts (allowlist dropdown), logos, support URLs, support email, domain; live preview.
8. **Customer-level brand override UI + API** — conditional on parent `allow_customer_overrides`; scoped field set.
9. **Custom domain flow (DNS + ACME)** — add hostname → DNS verification worker → ACME cert issuance (Let's Encrypt) → Key Vault storage → auto-renew scheduler; status UI.
10. **Template refactor — inject brand everywhere** — update `src/web/layout.ts`, `src/web/templates/*`, `src/web/helpers.ts`, `src/org/routes.ts`, `src/org/routes/invitations.ts`, `src/waitlist/routes.ts`, `src/auth/auth0.ts`, `src/auth/azure-ad.ts` to read from request-context brand rather than module-level singleton. Snapshot tests per tier.
11. **Favicon / OG-image / meta-tag rendering** — per-brand `<link rel="icon">`, OG meta, Twitter meta; dynamic per Host.
12. **Email template branding (v1)** — MJML templates for invite / password reset / audit alert / billing-to-MSP; token-substitute brand fields; From/Reply-To headers per brand; Wyre-owned sending domain with display-name spoof.
13. **Wyre operator preview mode** — preview cookie + banner + audit; `admin.conduit.wyre.io` hard-pin to Wyre default.
14. **Migration script `scripts/migrate-brand-env-to-db.ts`** — idempotent import from `BRAND_*` env + `src/brand/customers.ts` into `brand_profiles`; dry-run mode; docs.
15. **Feature flag `FEATURE_DB_BRANDING` wiring** — fallback to env-var loader when flag off; rollout checklist; runbook.
16. **Observability + security review** — metrics/alerts listed in §17; cross-tenant leakage test; SVG XSS test; run the `multi-tenant-security-validation` skill as the gate on GA.
