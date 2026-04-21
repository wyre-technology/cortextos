# PRD: Reseller Tenancy (Conduit)

- **Tag:** `reseller-tenancy`
- **Status:** Draft for taskmaster parse
- **Owner:** Platform
- **Target release:** Conduit GA v0.1 foundation
- **Dependencies:** none (this is the foundation other Conduit PRDs depend on)
- **Dependent PRDs:** `msp-admin`, `billing`, `white-label`, `onboarding`, `audit-exports`, `customer-provisioning`, `support-tools`

---

## 1. Background and Problem Statement

Conduit is a white-label fork of Wyre's `mcp-gateway` repositioned as a channel product that Managed Service Providers (MSPs) resell to their end-customer businesses. The upstream product assumes a **flat, single-tier tenancy model**: one `organizations` row represents one customer, and everyone inside is a peer on the owner/admin/member ladder. That model breaks down immediately for the MSP channel.

An MSP like "Acme IT Services" sells Conduit access to 40 of their own SMB customers. The MSP needs to:

- Provision a customer ("Beta Corp") as a first-class tenant with its own users, credentials, audit trail, and (eventually) plan/billing.
- See an aggregated view across all 40 customers without logging into each one.
- Delegate support actions (e.g., rotate a Datto RMM credential for Beta Corp) without every MSP employee becoming a permanent member of every customer tenant.
- Be isolated: MSP A must never see MSP B's customers, and Beta Corp must never see Gamma Corp's data, and a random MSP employee who was not added to Beta Corp must not be able to read Beta Corp's data just because they work at Acme IT.

The current schema (see `src/org/org-service.ts` lines 149-290 and `src/org/team-service.ts`) has no expression of "an org owns another org." Every org is a root. We need a hierarchical model that keeps the existing flat model working for standalone/direct customers, adds a parent/child relationship for MSP resellers and their customers, and introduces a small number of new permissions to distinguish "reseller-level oversight" from "being a member of this customer."

This PRD specifies the **schema, permission model, credential resolution, audit scoping, migration, RLS posture, and API surface** needed to express the hierarchy. Pricing, white-label, billing split, and support tooling are covered by their own PRDs and are explicitly out of scope here.

## 2. Goals and Non-Goals

### 2.1 Goals

1. Introduce a parent/child relationship between orgs so a reseller org owns N customer orgs.
2. Keep existing single-tier tenants working without modification (backward compatibility is a hard constraint — no existing customer rows may break).
3. Introduce reseller-level roles and permissions without bloating the in-org role ladder.
4. Prevent cross-customer data leakage at the query layer (defense in depth; not only in middleware).
5. Preserve least-privilege: an MSP admin is NOT a member of customer sub-orgs by default.
6. Provide a minimal, consistent API surface that other Conduit PRDs (msp-admin, billing, onboarding) can build on.
7. Make the migration path for existing production data boringly safe (expand → backfill → contract, no destructive changes in phase 1).

### 2.2 Non-Goals

- UI work for the MSP console (that's `msp-admin`).
- Billing split / retail markup model (that's `billing`).
- BRAND_* per-customer theming (that's `white-label`).
- Customer self-signup flows (that's `onboarding`).
- Re-merging upstream `mcp-gateway` with Conduit (long-term; tracked separately).
- Cross-reseller moves of customers (change of MSP ownership) — deferred.
- Reseller-of-reseller (multi-level) hierarchies. Hierarchy depth is capped at two (reseller → customer) for v1.

## 3. Personas

### 3.1 MSP Owner (primary channel persona)
Runs "Acme IT Services." Signs the wholesale contract with Wyre. Owns the reseller org. Needs: provision customers, remove customers, view aggregated usage/billing, assign internal MSP staff reseller-level roles.

### 3.2 MSP Technician
Employee of Acme IT. Day-to-day provisions new customers, troubleshoots credential issues, looks at audit logs across customers they are allowed to support. Must NOT have default read access to every customer's data — access is explicit.

### 3.3 MSP Billing / Finance Viewer
Read-only reseller role. Sees aggregated usage and invoice-oriented data across customers. Never needs vendor credentials or tool execution.

### 3.4 End-Customer Admin
Owner or admin inside a customer sub-org (e.g., "Beta Corp" CTO). Same UX as today's org owner/admin: invites users, manages credentials, sets tool allowlists. Does NOT see the reseller. Does NOT see sibling customers. May or may not even know they're on Conduit (white-label) or that an MSP is above them — see `white-label` PRD.

### 3.5 End-Customer User
Regular member of a customer sub-org. Authenticates, receives their personal credential scopes, runs MCP tools. Identical to today's `member` role.

### 3.6 Wyre Operator (supertenant)
Wyre staff operating the platform. Already exists as an implicit role; out of scope for this PRD except to confirm reseller hierarchy does not break staff tooling.

## 4. Current State (Baseline)

### 4.1 Tables (from source, not documentation)

- `users` — Auth0-backed user identities. See `src/auth/auth0.ts`, `src/auth/azure-ad.ts`.
- `organizations` — single-tier tenants. Defined in `src/org/org-service.ts:151-161`. Columns: `id`, `name`, `owner_id`, `plan`, `stripe_customer_id`, `stripe_subscription_id`, `created_at`, `updated_at`. Migration adds `prompt_capture_enabled`.
- `org_members` — `src/org/org-service.ts:164-173`. Roles constrained to `('owner', 'admin', 'member')` by `org_members_role_check`.
- `org_teams` / `org_team_members` — `src/org/team-service.ts:79-100`.
- `credentials` (personal, keyed by `user_id`) — `src/credentials/credential-service.ts:100-114`.
- `org_credentials` — `src/org/org-service.ts:180-193`.
- `org_team_credentials` — `src/credentials/credential-service.ts:119-133`.
- `service_client_credentials` — `src/credentials/credential-service.ts:138-152`.
- `org_invitations` — `src/org/org-service.ts:196-206`.
- `org_tool_allowlist` — `src/org/org-service.ts:259-269`.
- `org_server_access` — `src/org/org-service.ts:294-299`.
- `admin_audit_log` — `src/org/org-service.ts:277-286`.
- `request_log` — `src/org/org-service.ts:230-253`.
- `customer_tenants` (Azure AD multi-tenant admin consent) — `migrations/001_customer_tenants.sql`. NOTE: despite the name, this is about Azure AD tenant IDs for enterprise SSO, not about reseller→customer tenancy. Do not conflate.

### 4.2 Credential Resolution (current)

From `src/proxy/credential-injector.ts`, the resolution order for a human user invoking a tool is:

1. **Service client credential** (if auth is via service client, not a human).
2. **Personal credential** — `credentialService.get(userId, vendorSlug)`.
3. **Team credential** — for any team the user belongs to in the org (`getTeamCredential`).
4. **Org credential** — `getOrgCredential(orgId, vendorSlug)`, gated by `hasServerAccess`.

Everything is single-org. There is no concept of "reseller-level shared credentials" today.

### 4.3 Audit (current)

- `admin_audit_log` is per-org (`org_id` NOT NULL, FK to `organizations` with CASCADE).
- `request_log` is per-user + per-org, used for usage/prompt capture.
- Neither has any notion of "who is the reseller, if any."

## 5. Design Decisions

### 5.1 Hierarchy Representation — DECISION

**Chosen approach: `organizations.parent_org_id` nullable FK + `organizations.type` enum.**

Rejected alternatives:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. `parent_org_id` on `organizations` + `type` enum** | Minimal schema delta. Single source of truth. Existing queries keep working when `parent_org_id IS NULL`. Easy to express "list my customers" and "find my reseller." Trivially reversible. | Hierarchy conventions spread implicitly across services — discipline required. Can't easily hang reseller-only columns without nullability noise. | **Chosen.** |
| B. Separate `resellers` table + `reseller_customers` join | Cleanest conceptual separation. Reseller-only columns have a home. | Doubles the surface area. Every query that needs to know "is this org a reseller?" must join. Awkward for orgs that are *both* a reseller and a customer (future: MSP-of-MSP, explicitly deferred but not worth painting into a corner). Two sources of truth about which orgs exist. | Rejected. |
| C. `org.parent_org_id` only (no `type`) | Even smaller delta. | Can't distinguish "child" from "standalone" from "reseller with zero customers." Ambiguous semantics for invites and billing. | Rejected. |
| D. Materialized path / `ltree` | Supports arbitrary depth. | Overkill for a two-level hierarchy we've explicitly capped. Postgres `ltree` adds operational burden without value here. | Rejected. |

**Shape:**

- `organizations.type` — enum-like text with check constraint: `'reseller' | 'customer' | 'standalone'`. Default `'standalone'` so existing rows slot in cleanly.
- `organizations.parent_org_id` — nullable FK back to `organizations(id)`. `NULL` for `'standalone'` and `'reseller'`. NOT NULL for `'customer'`.
- Invariant enforced by check constraint + trigger: a row with `type='customer'` must have `parent_org_id IS NOT NULL` AND the referenced parent must have `type='reseller'`. A row with `type IN ('reseller','standalone')` must have `parent_org_id IS NULL`.
- Depth is implicitly capped at 2 by the "parent must be a reseller" constraint (a reseller cannot itself have a parent).

### 5.2 Permission Model — DECISION

**Chosen approach: new `reseller_members` table with reseller-specific roles, DISJOINT from `org_members`.**

Rationale: the existing `org_members.role IN ('owner','admin','member')` check is load-bearing across many call sites. Adding new role strings there pollutes a constraint that is tested against in-org operations. Reseller-level permissions are a genuinely different concept ("I have oversight across N customer orgs I am NOT a member of") and deserve a separate table.

New table `reseller_members`:

- `reseller_org_id` — FK to `organizations(id)` where `type='reseller'`.
- `user_id` — FK to `users(id)`.
- `role` — one of:
  - `reseller_owner` — full reseller control, can add/remove customers, can elevate self into any customer as temporary support agent.
  - `reseller_admin` — same as owner minus ability to manage reseller billing or delete the reseller.
  - `reseller_billing_viewer` — read aggregated usage/billing across customers; no customer-data read access.
  - `reseller_support_agent` — can perform explicit support impersonation into a customer sub-org, subject to audit and optional customer-side opt-in. Cannot manage other reseller members.

Customer-side roles remain `owner/admin/member` — unchanged. We are NOT introducing a `customer_support_agent` role inside `org_members`; instead, support access is expressed via an explicit **support grant** (see §5.4) so the audit story is clean.

Permission matrix:

| Action | reseller_owner | reseller_admin | reseller_billing_viewer | reseller_support_agent | customer owner/admin | customer member |
|---|---|---|---|---|---|---|
| Create customer sub-org | Y | Y | N | N | N | N |
| Delete customer sub-org | Y | N | N | N | N | N |
| List customers under reseller | Y | Y | Y | Y (assigned only) | N | N |
| View customer aggregated usage | Y | Y | Y | Y (assigned only) | N (own org only) | N |
| View customer audit log | Y | Y | N | Y (assigned only, audited) | Y (own org) | N |
| Read customer vendor credentials | N (never) | N (never) | N | N (never) | N (only use, not view plaintext) | N |
| Rotate customer vendor credential | Y (audited) | Y (audited) | N | Y (audited, assigned only) | Y | N |
| Invite user into customer | Y | Y | N | Y (assigned only) | Y | N |
| Change customer plan | Y | Y | N | N | N (subject to billing PRD) | N |
| Manage reseller_members | Y | Y (cannot elevate to owner) | N | N | N | N |
| View reseller billing to Wyre | Y | Y | Y | N | N | N |
| Execute tool AS customer user | N (except via explicit support grant, see §5.4) | N | N | N | N | Y (self) |

Note: vendor credentials are **never** returned in plaintext to reseller-level users, same as today's org admins. Rotation means "store a new encrypted blob," not "reveal the current one."

### 5.3 Credential Resolution — EXTENSION

Extend the order in `src/proxy/credential-injector.ts` to:

1. Service client credential (unchanged).
2. Personal credential (unchanged).
3. Team credential (unchanged).
4. Customer-org credential (was "org credential" — semantics preserved).
5. **NEW: Reseller-org shared credential** — if the current org has `parent_org_id IS NOT NULL` AND the vendor is in the reseller's **shared vendor list** for that customer, fall back to `getOrgCredential(parentOrgId, vendorSlug)`.

The reseller-level fallback is **opt-in per vendor per customer**. Rationale: an MSP that manages all its customers' Datto RMM through one master API key is a legitimate pattern; an MSP that shares its ConnectWise credential across tenants by accident is a security incident. Opt-in avoids the foot-gun.

New table `reseller_shared_vendor_grants`:

- `reseller_org_id` — FK to reseller org.
- `customer_org_id` — FK to customer org (must be child of reseller).
- `vendor_slug` — TEXT.
- `granted_by` — user who granted.
- `granted_at` — timestamp.
- UNIQUE on `(reseller_org_id, customer_org_id, vendor_slug)`.

Credential injector change: when resolving, after the customer-org lookup returns null, check `reseller_shared_vendor_grants` for this `(customer_org, vendor)` pair, and if present resolve from the reseller org's `org_credentials`. Encryption scope for reseller-level credentials is the **reseller org's id** (same pattern as today's org creds; see `credential-service.ts:160-166`). No changes to crypto.

### 5.4 Support Impersonation (Temporary Customer Access)

Rather than make `reseller_support_agent` a permanent customer-side member, support access is expressed as a **time-boxed support grant**:

New table `reseller_support_grants`:

- `id`, `reseller_org_id`, `customer_org_id`, `granted_to_user_id`, `granted_by_user_id`, `scope` (JSONB — vendor slugs or `*`), `expires_at`, `revoked_at`, `reason` (required free-text for audit), `created_at`.

While a grant is active, the subject user gains effective `admin`-level access to the customer sub-org for the declared scope. Every use is written to **both** the customer's `admin_audit_log` AND the reseller's audit view with a `source='support_grant'` marker. Expiry is enforced at the middleware layer, not by cron — checked on each request.

Customer owner/admin can **revoke a grant at any time** (`revoked_at`). Customer owner/admin can optionally require **pre-approval** of grants via an org setting `support_grants_require_approval BOOLEAN` (on `organizations`, defaulting to `false` for existing orgs, `true` for newly-provisioned customer orgs under a reseller — see §7).

### 5.5 Audit Scoping

`admin_audit_log` already has `org_id NOT NULL`. We keep that invariant: every entry lives in exactly one customer's audit log. For reseller-level visibility we do NOT denormalize. Instead:

- Query-side: reseller admins query `admin_audit_log` WHERE `org_id IN (SELECT id FROM organizations WHERE parent_org_id = :reseller_org_id)`.
- Mark reseller-originated events with `actor_org_id` (new nullable column on `admin_audit_log`). When NULL, actor is a direct member of `org_id`. When populated, actor was acting from `actor_org_id` (their reseller home) into `org_id` (the customer).
- New column `metadata` already exists (JSONB); we'll add documented keys: `support_grant_id`, `source` (`'direct' | 'support_grant' | 'reseller_shared'`), `impersonated` (boolean).

`request_log` (tool usage) gets the same `actor_org_id` column for reseller support sessions, so usage aggregation can correctly attribute or exclude support-driven tool calls.

### 5.6 Tenancy Isolation (RLS Posture)

Today, tenancy is enforced entirely in application middleware. For reseller mode this is insufficient — one `WHERE org_id = $1` typo leaks data across customers of the same reseller.

**Phase 1 (this PRD):**
- Enable Postgres Row-Level Security on the following tables: `organizations`, `org_members`, `org_credentials`, `org_team_credentials`, `org_invitations`, `org_tool_allowlist`, `org_server_access`, `admin_audit_log`, `request_log`, `credentials`, `reseller_members`, `reseller_shared_vendor_grants`, `reseller_support_grants`.
- Define RLS policies that read the current principal from Postgres session variables set by the connection-acquiring middleware: `app.user_id`, `app.current_org_id`, `app.is_reseller_admin` (boolean), `app.reseller_org_id` (nullable).
- Policies favor `USING` + `WITH CHECK` symmetry; writes must pass the same filter as reads.
- Application-layer checks stay in place; RLS is belt-and-suspenders.

**Phase 2 (follow-up, not this PRD):** migrate to Postgres roles per tenant-class (reseller, customer, operator) and drop the session-variable shim. Tracked in `#tenancy-hardening`.

Acceptance includes an explicit negative test matrix: an attacker-controlled principal must not read sibling customer data through any table in the RLS list (see §9).

### 5.7 Migration Strategy

Expand / backfill / contract, deployed in three releases:

- **Release A (expand):**
  - Add `organizations.type` with default `'standalone'`.
  - Add `organizations.parent_org_id` nullable.
  - Add check constraint.
  - Create `reseller_members`, `reseller_shared_vendor_grants`, `reseller_support_grants`.
  - Add `actor_org_id` to `admin_audit_log` and `request_log`.
  - New columns are nullable / defaulted. No reads assume them.
- **Release B (backfill + enable):**
  - Classify existing orgs: every existing row stays `'standalone'`. No automatic promotion to `'customer'` or `'reseller'`.
  - Turn on RLS with permissive policies (log only) to shake out false positives, then enforcing.
  - Start writing `actor_org_id` on new audit rows.
- **Release C (contract):**
  - Make `type` NOT NULL (it already has a default — this is safe).
  - Add FK trigger enforcing the "parent must be reseller" invariant.
  - Switch middleware to the new `type`-aware branch.
  - Remove any temporary dual-write paths.

No destructive operations. Existing production orgs all land in `'standalone'` and behave exactly as today.

## 6. Schema Changes (DDL sketch)

The following are sketches — migration files live under `migrations/` and follow the project's existing `NNN_description.sql` pattern (see `001_customer_tenants.sql`).

### 6.1 `organizations` additions

```sql
-- migrations/002_reseller_tenancy_expand.sql

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'standalone';

ALTER TABLE organizations
  ADD CONSTRAINT organizations_type_check
  CHECK (type IN ('reseller', 'customer', 'standalone'));

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS parent_org_id TEXT
    REFERENCES organizations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_organizations_parent
  ON organizations(parent_org_id)
  WHERE parent_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_type
  ON organizations(type);

-- Integrity: customer => has parent; parent must be reseller.
CREATE OR REPLACE FUNCTION enforce_org_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
  parent_type TEXT;
BEGIN
  IF NEW.type = 'customer' THEN
    IF NEW.parent_org_id IS NULL THEN
      RAISE EXCEPTION 'customer orgs must have parent_org_id';
    END IF;
    SELECT type INTO parent_type FROM organizations WHERE id = NEW.parent_org_id;
    IF parent_type IS DISTINCT FROM 'reseller' THEN
      RAISE EXCEPTION 'customer parent must be a reseller (got %)', parent_type;
    END IF;
  ELSIF NEW.type IN ('reseller', 'standalone') THEN
    IF NEW.parent_org_id IS NOT NULL THEN
      RAISE EXCEPTION '% orgs cannot have a parent', NEW.type;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_org_hierarchy ON organizations;
CREATE TRIGGER trg_enforce_org_hierarchy
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_org_hierarchy();

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS support_grants_require_approval BOOLEAN NOT NULL DEFAULT FALSE;
```

### 6.2 `reseller_members`

```sql
CREATE TABLE IF NOT EXISTS reseller_members (
  id               TEXT PRIMARY KEY,
  reseller_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN (
                     'reseller_owner',
                     'reseller_admin',
                     'reseller_billing_viewer',
                     'reseller_support_agent'
                   )),
  invited_by       TEXT REFERENCES users(id),
  joined_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(reseller_org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reseller_members_user
  ON reseller_members(user_id);

CREATE INDEX IF NOT EXISTS idx_reseller_members_org
  ON reseller_members(reseller_org_id);

-- Integrity: reseller_org_id must point at an org with type='reseller'.
-- Enforced via trigger at insert/update time (same pattern as above).
```

### 6.3 `reseller_shared_vendor_grants`

```sql
CREATE TABLE IF NOT EXISTS reseller_shared_vendor_grants (
  id               TEXT PRIMARY KEY,
  reseller_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_slug      TEXT NOT NULL,
  granted_by       TEXT NOT NULL REFERENCES users(id),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(reseller_org_id, customer_org_id, vendor_slug)
);

CREATE INDEX IF NOT EXISTS idx_rsvg_lookup
  ON reseller_shared_vendor_grants(customer_org_id, vendor_slug);
```

### 6.4 `reseller_support_grants`

```sql
CREATE TABLE IF NOT EXISTS reseller_support_grants (
  id                    TEXT PRIMARY KEY,
  reseller_org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_to_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id    TEXT NOT NULL REFERENCES users(id),
  scope                 JSONB NOT NULL DEFAULT '{"vendors":"*"}'::jsonb,
  reason                TEXT NOT NULL,
  approval_required     BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by_user_id   TEXT REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoked_by_user_id    TEXT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_rsg_active_lookup
  ON reseller_support_grants(granted_to_user_id, customer_org_id)
  WHERE revoked_at IS NULL;
```

### 6.5 Audit / request log additions

```sql
ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS actor_org_id TEXT REFERENCES organizations(id);

ALTER TABLE request_log
  ADD COLUMN IF NOT EXISTS actor_org_id TEXT;

-- request_log historically has no FK on org_id; keep parity.
```

### 6.6 RLS enablement (sketch; policies defined in §5.6)

```sql
ALTER TABLE organizations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members                ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_credentials            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_team_credentials       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invitations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tool_allowlist         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_server_access          ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials                ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_shared_vendor_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_support_grants    ENABLE ROW LEVEL SECURITY;
```

Example policy (customer data readable to its own members OR the parent reseller's admins):

```sql
CREATE POLICY org_credentials_read ON org_credentials
  FOR SELECT
  USING (
    org_id = current_setting('app.current_org_id', true)
    OR EXISTS (
      SELECT 1
      FROM organizations o
      JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
      WHERE o.id = org_credentials.org_id
        AND rm.user_id = current_setting('app.user_id', true)
        AND rm.role IN ('reseller_owner','reseller_admin')
    )
  );
```

Important: the reseller-admin read visibility above is for **metadata only** (which vendors are configured, when rotated). Plaintext decryption still requires the customer-org encryption scope (see `deriveKey` in `credential-service.ts:160-166`); reseller admins cannot decrypt customer secrets simply by being able to SELECT the encrypted blob.

## 7. API Surface

All endpoints below require Auth0 session authentication. All write endpoints require the actor to have sufficient reseller-level role (checked via new `requireResellerRole` middleware living alongside the existing `requireOrgRole` in `src/org/routes/helpers.ts`).

### 7.1 Reseller CRUD

- `POST /api/resellers` — create a reseller org. Initially restricted to Wyre operators; exposed to self-serve signup by `onboarding` PRD.
- `GET /api/resellers/:id` — read reseller profile (name, member count, customer count, plan).
- `PATCH /api/resellers/:id` — update reseller metadata.
- `GET /api/resellers/:id/members` — list reseller_members.
- `POST /api/resellers/:id/members` — invite a reseller member (role required).
- `DELETE /api/resellers/:id/members/:memberId` — remove reseller member.
- `PATCH /api/resellers/:id/members/:memberId` — change reseller role.

### 7.2 Customer sub-org management

- `GET /api/resellers/:id/customers` — list customer sub-orgs under this reseller. Paginated. Returns `{ id, name, plan, createdAt, memberCount, activeVendors }`.
- `POST /api/resellers/:id/customers` — provision a new customer sub-org. Body: `{ name, initialOwnerEmail, plan?, brandingOverrides? }`. Atomic: creates `organizations` row with `type='customer'` and `parent_org_id=:id`, sends invite to `initialOwnerEmail`, seeds defaults, writes audit entry to BOTH reseller and new customer logs. Newly-provisioned customer orgs get `support_grants_require_approval=TRUE` by default (opposite of standalone orgs) as the safer default for the channel.
- `GET /api/resellers/:id/customers/:customerId` — read customer details from reseller's perspective.
- `DELETE /api/resellers/:id/customers/:customerId` — soft-delete / offboard customer (hard delete is deferred).
- `POST /api/resellers/:id/customers/:customerId/transfer-standalone` — detach customer from reseller (becomes standalone). Guarded by customer-owner consent token. Deferred stretch.

### 7.3 Shared credentials and access grants

- `GET /api/resellers/:id/shared-vendors` — list reseller-level `org_credentials` (metadata only).
- `PUT /api/resellers/:id/shared-vendors/:vendorSlug` — store/rotate reseller-level vendor credential.
- `GET /api/resellers/:id/customers/:customerId/shared-vendor-grants` — list which reseller-shared vendors are opted in for this customer.
- `POST /api/resellers/:id/customers/:customerId/shared-vendor-grants` — opt a customer into reseller-shared vendor.
- `DELETE /api/resellers/:id/customers/:customerId/shared-vendor-grants/:vendorSlug` — revoke opt-in.

### 7.4 Support grants

- `POST /api/resellers/:id/customers/:customerId/support-grants` — request support access. Body: `{ userId, scope, expiresInMinutes, reason }`. If customer has `support_grants_require_approval=TRUE`, grant is created with `approved_at=NULL` and does not take effect until a customer owner/admin approves.
- `GET /api/resellers/:id/support-grants` — list grants for this reseller (active / expired / revoked filter).
- `DELETE /api/resellers/:id/customers/:customerId/support-grants/:grantId` — reseller-side revoke.
- `POST /api/orgs/:orgId/support-grants/:grantId/approve` — customer-side approve.
- `DELETE /api/orgs/:orgId/support-grants/:grantId` — customer-side revoke.

### 7.5 Aggregated reads

- `GET /api/resellers/:id/audit` — merged audit across all customer sub-orgs + reseller-level events. Query params: `customerOrgId`, `actorUserId`, `eventType`, `since`, `until`, `cursor`.
- `GET /api/resellers/:id/usage` — aggregated `request_log` counts per customer per vendor per day (feeds `billing` PRD).

### 7.6 Backward-compat

All existing `/api/orgs/...` endpoints continue to work identically for `type='standalone'` and `type='customer'`. A `customer` org's owner sees no reseller endpoints and no cross-reseller data. This is a hard requirement; see acceptance §9.

## 8. Service-Layer Changes

Concrete code touch points (real file paths):

- `src/org/org-service.ts` — extend `initTables` with `type` and `parent_org_id` additions; add helpers `isReseller(orgId)`, `getCustomersOfReseller(resellerOrgId, opts)`, `getResellerOfCustomer(customerOrgId)`.
- `src/org/member-service.ts` — unchanged for customer roles; new `src/org/reseller-member-service.ts` for reseller roles.
- `src/org/routes/helpers.ts` — add `requireResellerRole(...)` and `requireResellerOrCustomerAccess(...)` middleware.
- `src/org/routes/org-crud.ts` — when creating an org, accept optional `type` + `parentOrgId` and validate caller permission.
- New `src/org/routes/resellers.ts` — endpoints under §7.1–§7.5.
- New `src/org/routes/support-grants.ts` — support grant lifecycle endpoints.
- `src/credentials/credential-service.ts` — add `getResellerSharedCredential(customerOrgId, vendorSlug)` helper that joins `reseller_shared_vendor_grants` and resolves from parent reseller's `org_credentials`.
- `src/proxy/credential-injector.ts` — add step 5 (reseller-shared fallback) after the existing org lookup around line 149.
- `src/audit/admin-audit-service.ts` — accept optional `actorOrgId` in `log()`; add `listForReseller(resellerOrgId, filters)`.
- `src/audit/audit-service.ts` — same for `request_log`-derived reads.
- `src/auth/auth0.ts` / connection-acquire path — set Postgres `app.user_id`, `app.current_org_id`, `app.reseller_org_id`, `app.is_reseller_admin` session vars on every request-scoped connection for RLS policies.

## 9. Acceptance Criteria

All criteria are testable. Numbering is stable so taskmaster can cross-reference.

### Schema & migration
1. `organizations.type` exists, defaults `'standalone'`, constrained to `{reseller, customer, standalone}`.
2. `organizations.parent_org_id` exists, nullable, FK to `organizations(id)` `ON DELETE RESTRICT`.
3. Trigger rejects inserting a `customer` with `NULL parent_org_id`, rejects inserting a `customer` whose parent is not `type='reseller'`, rejects a `reseller` or `standalone` with a non-null `parent_org_id`.
4. Applying migrations to a snapshot of the current production DB leaves every existing org with `type='standalone'`, `parent_org_id IS NULL`, and no behavior change for any existing API call.
5. Rolling back the migration (Down script) is possible without data loss for greenfield deploys and documented as non-trivial for deploys that already have reseller data.

### Reseller membership
6. A user with `reseller_owner` can create another reseller member of any role via `POST /api/resellers/:id/members`.
7. A user with `reseller_admin` cannot elevate another member to `reseller_owner`.
8. A user with `reseller_billing_viewer` cannot create customers, cannot read customer audit logs, cannot read customer credentials metadata, but can read `/api/resellers/:id/usage`.
9. A user who is only in `org_members` of a customer org has no access to `/api/resellers/...` endpoints and receives 403.

### Customer provisioning
10. `POST /api/resellers/:id/customers` creates a new `organizations` row with `type='customer'`, `parent_org_id=:id`, `support_grants_require_approval=TRUE`, and emits an invite to `initialOwnerEmail`.
11. A customer org's owner/admin sees their org behave identically to a standalone org for all pre-existing API routes (`/api/orgs/:orgId/*`).
12. `DELETE /api/resellers/:id/customers/:customerId` marks the customer as deleted and cascades to members/credentials per the existing CASCADE policy, subject to a `confirm=true` guard.

### Credential resolution
13. Tool invocation by a customer member resolves credentials in order: service-client → personal → team → customer-org → reseller-shared (only if opted in). Verified by unit tests in `src/proxy/credential-injector.test.ts`.
14. Reseller-shared credential fallback does NOT fire for a customer unless a row exists in `reseller_shared_vendor_grants` for that `(customer_org, vendor)`.
15. Reseller admins cannot retrieve plaintext vendor credentials for customer orgs via any endpoint.

### Support grants
16. A support grant with `approval_required=TRUE` on a customer with `support_grants_require_approval=TRUE` does not grant effective access until `approved_at` is set.
17. All requests made under a support grant write audit rows to BOTH the customer's `admin_audit_log` (as `source='support_grant'`) AND the reseller-level audit view.
18. Expiry is enforced on each request, not on a cron — an expired grant stops working immediately.
19. Customer owner/admin can revoke a grant at any time and subsequent requests fail 403 within one request.

### Audit & observability
20. `GET /api/resellers/:id/audit` returns merged rows across all customers under the reseller, filterable by `customerOrgId`, `eventType`, time range, paginated by opaque cursor.
21. A customer's owner querying their own `admin_audit_log` sees reseller-originated actions clearly marked with `actor_org_id` and `source='support_grant'` or `source='reseller_shared'`.
22. `request_log` aggregation correctly distinguishes support-originated tool calls (for billing purposes) via `actor_org_id`.

### Tenancy isolation (RLS)
23. A negative-test suite (`src/**/rls.test.ts`) verifies that with session vars set for a customer-A member, selects against every RLS-enabled table return zero rows belonging to customer B under the same reseller.
24. The same negative-test suite verifies cross-reseller isolation: MSP A cannot see MSP B or any of MSP B's customers.
25. RLS policies are defined with `USING` and `WITH CHECK` on every enabled table — no write-side escape hatches.
26. RLS remains opt-in via `app.bypass_rls = 'on'` only for a specific privileged "platform" connection; that setting is never touched by request-scoped code paths.

### Backward compatibility
27. Every test in `src/org/org-service.test.ts`, `src/credentials/credential-service.test.ts`, and `src/proxy/credential-injector.test.ts` continues to pass without modification after `type='standalone'` rows are introduced.
28. An existing standalone org upgraded to a reseller (manual operator action) behaves correctly: its members remain standalone members of the now-reseller org; they do NOT automatically gain reseller-level roles.

### Performance
29. `GET /api/resellers/:id/customers` with 500 customer sub-orgs returns in < 200ms P95 against the dev database.
30. RLS does not regress `/api/orgs/:orgId/credentials` latency by more than 10% P95.

## 10. Open Questions

1. **Reseller onboarding locus.** Does a reseller self-signup, or is reseller creation gated behind Wyre operator approval for v1? (Leaning: operator-gated for v1, self-serve in `onboarding` PRD.)
2. **Cross-reseller customer transfer.** Explicit non-goal for v1, but schema with `ON DELETE RESTRICT` on `parent_org_id` is friendly to an eventual `PATCH /organizations/:id/parent_org_id`. Confirm?
3. **Reseller-level teams.** Should reseller_members have a team concept (e.g., "Tier-1 support pool")? Defer unless use case emerges. Flag for review after first paying reseller.
4. **Audit retention across levels.** Does the customer's audit retention policy override the reseller's view, or do resellers get longer retention by contract? Interaction with `billing` PRD.
5. **White-label brand inheritance.** Does a customer under a reseller default to the reseller's BRAND_* overrides, or Conduit defaults? Cross-refs `white-label` PRD — decision there, schema-ready here (the parent pointer is all that's needed).
6. **OAuth client scoping.** Should OAuth dynamic-client-registration tie new clients to the customer org only, or allow reseller-scoped clients? Current leaning: customer-scoped; reseller-scoped deferred.
7. **Auth0 org sync.** Auth0 supports Organizations. Do we mirror our reseller/customer split into Auth0 Orgs, or keep Auth0 flat and use our Postgres model as authoritative? Affects SSO connections and invite flows.
8. **`customer_tenants` (Azure AD) interaction.** Azure AD tenant IDs map to users, not orgs. Does a reseller get a tenant ID used for SSO across all its customers, or per-customer? Probably per-customer; confirm with sales before committing.

## 11. Out of Scope / Deferred

- MSP console UI (→ `msp-admin`).
- Billing split, retail markup, invoice generation (→ `billing`).
- Per-customer white-label (→ `white-label`).
- Customer self-signup flows (→ `onboarding`).
- Reseller-of-reseller (multi-level) hierarchies.
- Cross-reseller customer transfers.
- Hard-delete of customer orgs (soft-delete only in v1).
- Per-tenant Postgres roles (Phase 2 tenancy hardening).

## 12. Risks

- **RLS false-positive blocking legitimate admin actions.** Mitigated by shadow-mode rollout in Release B.
- **Migration trigger cost on large `organizations` tables.** Expected small (< 100k rows), so trigger cost is negligible; monitor.
- **Reseller admins believing they have credential plaintext access.** Mitigated by explicit docs + API never returning plaintext; credential rotation UX must be clear it's write-only.
- **Hierarchical queries accidentally unbounded.** Mitigated by the 2-level cap and explicit `parent_org_id` index.
- **Upstream merge churn.** Every table added here increases merge surface with upstream `mcp-gateway`. Mitigated by keeping reseller-specific tables in discrete migration files and a separate `src/org/reseller-*` module boundary, so upstream-only files stay untouched.

## 13. Rollout Plan

- Week 1–2: Release A (expand migrations; no runtime behavior change).
- Week 3: Release B (backfill + RLS shadow mode + new services wired; feature-flagged behind `CONDUIT_RESELLER_ENABLED`).
- Week 4: Release B enforcement (RLS enforcing, feature flag flipped for internal test reseller).
- Week 5: Release C (contract migration, flag removed, internal test reseller onboarded).
- Week 6+: First real reseller onboarded, `msp-admin` PRD work kicks off.

## 14. Proposed Task List

The following bullets are candidate tasks for taskmaster's `parse-prd`. Each is roughly one engineer-week or less, with clear outputs.

- Write migration `002_reseller_tenancy_expand.sql` adding `organizations.type`, `parent_org_id`, `support_grants_require_approval`, check constraint, hierarchy-integrity trigger, and indexes; verify idempotent and reversible on a prod-snapshot dataset.
- Write migration `003_reseller_members.sql` creating `reseller_members` with role check and reseller-type integrity trigger, plus indexes.
- Write migration `004_reseller_shared_vendor_grants.sql` creating `reseller_shared_vendor_grants` with uniqueness and lookup index.
- Write migration `005_reseller_support_grants.sql` creating `reseller_support_grants` with active-lookup partial index and `expires_at > created_at` check.
- Write migration `006_audit_actor_org_id.sql` adding `actor_org_id` to `admin_audit_log` and `request_log`.
- Write migration `007_rls_enable.sql` enabling RLS on the 13 tables listed in §5.6 with policies using `app.user_id` / `app.current_org_id` / `app.is_reseller_admin` / `app.reseller_org_id` session variables; include a shadow-mode toggle.
- Implement `ResellerMemberService` at `src/org/reseller-member-service.ts` with CRUD, role checks, and unit tests covering the permission matrix in §5.2.
- Extend `OrgService` (`src/org/org-service.ts`) with `isReseller`, `getCustomersOfReseller`, `getResellerOfCustomer`, and reseller-aware org creation; add tests to `src/org/org-service.test.ts`.
- Add `requireResellerRole` and `requireResellerOrCustomerAccess` middleware in `src/org/routes/helpers.ts`; add tests.
- Implement reseller endpoints (`/api/resellers/...`) in new `src/org/routes/resellers.ts` covering §7.1–§7.3 and §7.5; register under the existing org routes tree.
- Implement support-grant endpoints in new `src/org/routes/support-grants.ts` covering §7.4, including customer-side approve/revoke.
- Extend `CredentialService` with `getResellerSharedCredential(customerOrgId, vendorSlug)` and tests in `src/credentials/credential-service.test.ts`.
- Modify `src/proxy/credential-injector.ts` to add reseller-shared fallback after the customer-org lookup; extend `src/proxy/credential-injector.test.ts` to cover the new step and the gating grant.
- Extend audit services (`src/audit/admin-audit-service.ts`, `src/audit/audit-service.ts`) with `actor_org_id`-aware writes and a `listForReseller` aggregated reader.
- Wire Postgres session variables (`app.user_id`, `app.current_org_id`, `app.reseller_org_id`, `app.is_reseller_admin`) in the request-scoped DB connection path feeding off the Auth0 session; document in `docs/architecture.md`.
- Add RLS negative-test suite covering cross-customer and cross-reseller isolation (§9 acceptance 23–26).
- Add performance-regression tests for `/api/resellers/:id/customers` at 500-customer scale and for `/api/orgs/:orgId/credentials` pre/post RLS.
- Update `docs/architecture.md`, `docs/teams-and-orgs.md` (create if missing), and `CHANGELOG.md` with the reseller model, migration ordering, and runbook for onboarding a reseller manually for v1.
