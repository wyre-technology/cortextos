# PRD: MSP Admin Console (`msp-admin`)

Tag: `msp-admin`
Status: Draft v1
Owner: Conduit product
Target release: Conduit GA (post reseller-tenancy)
Last updated: 2026-04-18

## 1. Summary

Conduit is a white-label fork of Wyre's mcp-gateway that Managed Service
Providers (MSPs) resell to their end-customer businesses. The existing admin
surface in `src/web/templates/team-*.ts` is scoped to a single organization —
an "org admin" managing their own team, connections, and audit log. MSPs are a
new persona: they operate a fleet of customer sub-orgs and need a console that
sits logically *above* the per-org admin, lets them run their Conduit business,
and stays clearly separated from any one customer's data.

This PRD defines the **MSP Admin Console** — the primary reseller-scope UI a
partner uses day-to-day. It depends on the `reseller-tenancy` PRD (parent/child
org model, `reseller_admin` scope, `/resellers/:id/customers` APIs) and is
paired with the `msp-billing`, `branding-per-tenant`, and `support-tooling`
PRDs.

The console must make it easy to (a) see the book of business at a glance, (b)
provision a new customer in under two minutes, (c) diagnose a customer
incident without seeing their secrets, and (d) do all of this without blurring
the tenancy boundaries that protect customer data.

## 2. Problem statement

Today, a would-be reseller who wants to offer Conduit to 20 customers has to
either (a) create 20 disconnected orgs and juggle 20 logins, or (b) put all
customers under one org and violate data isolation. Neither works. There is no
reseller-level dashboard, no cross-customer search, no safe support
impersonation, and no way for an MSP to provision customers self-service. The
existing `src/dashboard/routes.ts` and `src/web/templates/team-dashboard.ts`
are hardcoded to a single org (`orgs[0]`) and return 403 for non-admins.

MSPs will not adopt Conduit until the console lets them run their channel
practice the way they run their RMM or PSA — a single pane for all customers,
with safe drill-in.

## 3. Personas

### 3.1 MSP Owner / Principal ("Dana")
Runs the MSP. Cares about MRR, churn, gross margin, and whether the product
is making money. Logs in weekly, not daily. Needs: dashboard, billing roll-up,
ability to add a customer, invoice export.

### 3.2 MSP Tech / Support Agent ("Marcus")
Front-line. Handles customer tickets. Lives in the console all day.
Needs: fast customer search, per-customer drill-in, safe impersonation,
customer audit log, ability to reset a customer admin's access.
**Must not** see customer vendor credentials in plaintext (they are AES-256-GCM
encrypted by `src/credentials/credential-service.ts` and that boundary must
hold for MSP staff too).

### 3.3 MSP Accounting ("Priya")
Billing and finance. Does not do technical support. Needs: invoices, usage
roll-up, per-customer MRR, export to CSV/QuickBooks, payment method
management. Does **not** need operational access to customer tenants.

### 3.4 Wyre ops (secondary)
Wyre staff occasionally need to view a reseller's state to support them.
Covered under a separate `wyre-superadmin` PRD but this console must not
*prevent* that (read-only reseller view should be reachable).

## 4. Scope

### 4.1 In scope
- New UI surface rooted at `/admin/reseller/*` for users whose membership in
  a `type=reseller` org carries the `reseller_admin` scope.
- Dashboard, customer list, per-customer drill-in, reseller settings,
  MSP-employee team management, just-in-time impersonation flow.
- Read-only views of customer audit, customer users, customer vendor
  connections (names only, never decrypted secrets).
- Reseller-scope RBAC: `reseller_owner`, `reseller_admin`, `reseller_support`,
  `reseller_billing`, `reseller_readonly`.
- Telemetry events for PMF measurement.

### 4.2 Out of scope
- The customer-facing UI (covered by existing per-org admin at `/team/*` and
  the `branding-per-tenant` PRD).
- Public marketing pages (`www.conduit.example`, `/landing/*`).
- Billing *logic* (plan catalog, Stripe integration, wholesale discount) —
  covered by `msp-billing` PRD. This PRD only covers the billing **views**
  inside the console.
- Programmatic reseller-scope API for third parties — covered by
  `reseller-api` PRD. This PRD assumes server-side rendered pages plus
  minimal JSON endpoints for the console itself.
- Customer provisioning at scale via CSV import or SCIM — future.

## 5. Assumptions and dependencies

Assumed delivered by sibling PRDs before this one ships:

1. `reseller-tenancy`: `organizations` table gains `type` enum
   (`reseller | customer | direct`) and nullable `parent_org_id` FK; existing
   rows default to `direct`. Indexes on `parent_org_id`.
2. `reseller-tenancy`: new permission scopes on `org_members`:
   `reseller_owner`, `reseller_admin`, `reseller_support`, `reseller_billing`,
   `reseller_readonly`. Distinct from the existing `owner/admin/member`
   in `src/org/org-service.ts::OrgRole`.
3. `reseller-tenancy`: APIs `GET /resellers/:id/customers`,
   `POST /resellers/:id/customers`, `GET /resellers/:id/customers/:cid`,
   `POST /resellers/:id/customers/:cid/suspend`, `POST .../unsuspend`.
4. `msp-billing`: wholesale price list per plan is configured per reseller,
   and a `reseller_mrr_snapshot` materialized view (or equivalent) exists.
5. `branding-per-tenant`: brand config is per-org, inheritable from parent
   reseller. The existing `src/brand/index.ts` reads `BRAND_*` env vars —
   this PRD assumes those become per-org at runtime.
6. `support-tooling`: an `impersonation_session` model exists (see §9) or
   is built as part of this PRD if sibling slips. This PRD owns the UX and
   will build the backing store if it isn't delivered elsewhere.

Flagged concerns with those assumptions:

- **Assumption 2 feels wrong as stated.** Overloading `org_members.role` for
  reseller-scope permissions couples customer-scope and reseller-scope RBAC.
  Recommend a separate `reseller_members` table keyed by `(reseller_org_id,
  user_id, scope)`. Surface this to the `reseller-tenancy` author.
- **Assumption 3:** `POST /resellers/:id/customers` should return the new
  customer org plus a one-time invite token for the first customer admin,
  not just the org ID. Otherwise the provisioning flow needs a second call.

## 6. Information architecture

```
/admin/reseller/:resellerId
  ├── /                          dashboard (overview)
  ├── /customers                 customer list + search
  │   └── /:customerId
  │       ├── /                  customer overview
  │       ├── /users             customer users (read-only)
  │       ├── /connections       customer vendor connections (read-only names)
  │       ├── /audit             customer admin audit log (read-only)
  │       ├── /billing           customer billing view
  │       └── /impersonate       JIT impersonation launcher
  ├── /billing                   reseller billing roll-up
  ├── /team                      MSP employees + their reseller roles
  ├── /settings
  │   ├── /branding              reseller default branding
  │   ├── /invoicing             reseller invoicing info
  │   ├── /payment               reseller payment method (wholesale to Wyre)
  │   └── /notifications        reseller notification prefs
  └── /audit                     reseller-scope audit (who did what to whom)
```

The `:resellerId` segment is required in the URL even when a user belongs to
only one reseller org, so URLs are stable, shareable, and copy-paste safe for
support. A user who is a member of multiple resellers gets a reseller picker
in the nav shell.

## 7. Core views

### 7.1 Reseller dashboard (`/admin/reseller/:resellerId/`)

**Tiles (above the fold):**
1. Customer count — total, split active / trial / suspended.
2. MRR — sum of active customer plans priced at MSP's retail (if retail pricing
   is configured) or wholesale (if not). Shows trend vs. last month.
3. Usage — total tool calls across all customers this billing period.
   Matches shape of `src/dashboard/dashboard-service.ts::getUsageSummary`.
4. Incidents — count of customers with at least one failed auth, expired
   credential, or billing-past-due event in the last 24h.

**Below the fold:**
5. Activity feed — last 20 reseller-scope audit events (new customer
   provisioned, impersonation session started, plan changed).
6. Top 5 customers by usage (clickable → drill-in).
7. Customers approaching a plan limit (e.g. >80% of included tool calls).

Components:
- `src/web/templates/reseller-dashboard.ts` (new)
- Data source: new `src/reseller/reseller-dashboard-service.ts` that fans
  out over `src/dashboard/dashboard-service.ts` per customer, with results
  memoized for 60s. Must return in <2s for 100 customers — see §12.

### 7.2 Customer list (`/admin/reseller/:resellerId/customers`)

Table columns: name, primary contact email, plan, status, MRR, usage this
period, last activity, created at, actions.

Controls:
- Text search (matches org name, primary admin email, org ID prefix).
- Status filter: all / active / trial / suspended / past-due.
- Plan filter.
- Sort by name, MRR, usage, created.
- Pagination (page size 25 default, 100 max). Server-side.
- Bulk actions (v2): suspend selected, export selected.

Empty state: CTA "Provision your first customer" → launches 7.3.

Components:
- `src/web/templates/reseller-customer-list.ts` (new)
- Backing endpoint `GET /api/reseller/:resellerId/customers?q=&status=&plan=
  &sort=&page=&pageSize=` returning `{items, total, page, pageSize}`.

### 7.3 New-customer provisioning flow (`/admin/reseller/:resellerId/customers/new`)

Multi-step form, all on one page, three sections:

**Section A — Customer identity**
- Customer business name (required).
- Customer primary domain (optional, used for email-domain autojoin later).
- Internal reference / nickname (MSP-side, e.g. PSA customer ID).
- Notes (MSP-private).

**Section B — First customer admin**
- Email (required).
- First name, last name (optional).
- Invite expiration (default 7 days, max 30).

**Section C — Initial configuration**
- Plan: defaults to the reseller's configured default, e.g. `pro`. Picker
  limited to plans the reseller is entitled to resell (from `msp-billing`).
- Billing: "Bill to MSP" (default, bills the reseller) vs. "Bill customer
  directly" (requires reseller to have enabled customer-direct billing).
- Branding: "Inherit reseller branding" (default) vs. "Customer will
  customize later" vs. "Set now" (opens `branding-per-tenant` subform).
- Starter vendor connections: none by default; optional checklist of vendor
  slugs (from `src/credentials/vendor-config.ts`) to prompt first admin to
  connect on login.

On submit:
1. `POST /resellers/:resellerId/customers` with the assembled payload.
2. Server creates the child org (`parent_org_id = :resellerId`, `type =
   customer`, `plan` and `stripe_customer_id` per config).
3. Server creates an invitation record using
   `src/org/invitation-service.ts` for the first admin email.
4. Server returns `{org, invite}`; UI shows a success screen with (a) a
   copyable invite URL, (b) "Send via email now" button, (c) link to the
   new customer's drill-in page.

Must be idempotent on the submit button (client-side nonce + server de-dup
on `idempotency_key` header) so double-click does not create two orgs.

Emits reseller-audit event `customer_provisioned` with `{customer_org_id,
plan, billing_mode, invited_email}`.

Components:
- `src/web/templates/reseller-new-customer.ts` (new)
- `src/reseller/provisioning-service.ts` (new) — orchestrates the
  org-create + invite-create transaction.

### 7.4 Per-customer drill-in (`/admin/reseller/:resellerId/customers/:customerId/*`)

Header pinned across sub-pages: customer name, plan badge, status badge,
"Impersonate" button (see §9), "Suspend" toggle, last-activity timestamp.
Breadcrumb: `Reseller > Customers > <name>`.

Sub-tabs:

**Overview** — snapshot: user count, active vendor connections count, usage
this period, MRR, next invoice date, most-recent incident. Mirrors the shape
of `src/web/templates/team-overview.ts` but read-only.

**Users** — list of customer org members. Columns: email, role, joined,
last seen. Actions: *none by default*. MSP cannot add/remove customer users
without an explicit grant from the customer admin OR an active impersonation
session. This is a hard tenancy rule.

**Connections** — list of vendor credentials the customer org has stored
(via `src/credentials/credential-service.ts`). Shows vendor name, created
by, created at, status (valid / expired / failing). **Never** shows the
decrypted secret. "Revoke" action is disabled unless impersonating.

**Audit** — read-only view of `src/audit/admin-audit-service.ts` entries
for the customer org. Same filters as the existing team-audit template
(`src/web/templates/team-audit.ts`) but scoped and non-editable.

**Billing** — customer's current plan, usage vs. limits, next invoice, past
invoices. Data from `msp-billing`. MSP can change the customer's plan
(emits audit event). MSP cannot see the customer's payment method in "Bill
customer directly" mode — only metadata (last4, brand).

**Suspend / Unsuspend** — modal confirms action, requires a reason string
(stored on the audit event). Suspension sets customer org's
`suspended_at` and invalidates active customer sessions. Unsuspend is
symmetric. Emits `customer_suspended` / `customer_unsuspended`.

Components:
- `src/web/templates/reseller-customer-overview.ts`
- `src/web/templates/reseller-customer-users.ts`
- `src/web/templates/reseller-customer-connections.ts`
- `src/web/templates/reseller-customer-audit.ts`
- `src/web/templates/reseller-customer-billing.ts`
- `src/web/templates/reseller-customer-suspend-modal.ts`

### 7.5 Reseller settings

**Branding** (`/settings/branding`) — reseller's default brand used for new
customers: name, logo, primary color, accent, support URL, docs URL, email
sender identity. Mirrors `src/brand/types.ts::BrandConfig`. Changes here
do not retroactively change customer brands — those are copy-on-provision.

**Invoicing** (`/settings/invoicing`) — legal business name, address, tax
ID, invoice prefix, remit-to details. Used on invoices the MSP sends their
customers (if "Bill to MSP" mode).

**Payment** (`/settings/payment`) — the MSP's payment method on file with
*Wyre* (for the wholesale invoice). Stripe-backed. Read-heavy; actual
method-change flow is handled by Stripe Elements.

**Notifications** (`/settings/notifications`) — per-event email and
webhook subscriptions: new customer provisioned, customer payment failed,
customer usage >80%, impersonation session started, etc.

### 7.6 Reseller team (`/admin/reseller/:resellerId/team`)

Lists MSP employees with reseller-scope roles. Add/remove/change role.
Re-uses `src/org/invitation-service.ts` with a reseller-scope flag. Roles:
- `reseller_owner` — full control, including billing and team
- `reseller_admin` — full ops, cannot delete the reseller or change
  payment method
- `reseller_support` — customer drill-in + impersonate + customer audit
  (no billing, no team, no settings)
- `reseller_billing` — billing views + payment method + invoicing; no
  customer drill-in beyond billing tab
- `reseller_readonly` — dashboard and lists; no actions

### 7.7 Reseller-scope audit (`/admin/reseller/:resellerId/audit`)

Every reseller-scope action emits an audit event: provisioning, suspension,
plan changes, impersonation start/stop, settings changes, team changes.
Reuses the `src/audit/admin-audit-service.ts` pattern but writes to a
separate `reseller_admin_audit` table (reseller_org_id, actor, target
customer_org_id, event type, metadata). Read-only view with the same
filter UX as the existing team-audit template.

## 8. Permissions matrix

| Action | owner | admin | support | billing | readonly |
|---|---|---|---|---|---|
| View dashboard | Y | Y | Y | Y | Y |
| View customer list | Y | Y | Y | Y | Y |
| Provision new customer | Y | Y | N | N | N |
| Suspend / unsuspend customer | Y | Y | Y | N | N |
| Change customer plan | Y | Y | N | Y | N |
| View customer users | Y | Y | Y | N | N |
| Impersonate into customer | Y | Y | Y | N | N |
| View customer audit | Y | Y | Y | N | N |
| View customer billing | Y | Y | Y | Y | N |
| Edit reseller branding | Y | Y | N | N | N |
| Edit reseller payment | Y | N | N | Y | N |
| Manage MSP team | Y | Y | N | N | N |
| Delete reseller | Y | N | N | N | N |

MSP employees have **no automatic access to customer data** beyond
aggregated metrics visible in the dashboard (count, MRR, usage totals).
Per-customer drill-in requires either (a) an explicit grant — out of scope
for v1, future —  or (b) a just-in-time impersonation session.

## 9. Support workflow: impersonation

### 9.1 UX
On any customer drill-in page, an "Impersonate" button launches a modal:
- Required: reason (free-text, min 10 chars) — stored on the audit event
- Optional: ticket ID (free-text)
- Required: duration — 15m (default), 30m, 60m; max 60m
- Required: confirm check — "I understand this will be logged and visible
  to the customer"

On confirm, server creates an `impersonation_session`:
```
id, reseller_org_id, customer_org_id, actor_user_id,
reason, ticket_id, started_at, expires_at, ended_at nullable,
ended_reason nullable
```

The MSP user is redirected to the customer's admin UI at `/team/*` with
a session cookie scoped to the customer org but carrying an
`impersonating=true` claim and the `impersonation_session.id`.

### 9.2 Constraints
- Impersonation session is **time-limited** (hard expiry).
- Every write action during the session is tagged with
  `impersonation_session_id` in both `src/audit/admin-audit-service.ts`
  and `src/audit/audit-service.ts` metadata.
- The MSP user **cannot** view or export decrypted credentials even during
  impersonation. `src/credentials/credential-service.ts` must enforce this
  by checking the `impersonating` claim and refusing decrypt for non-proxy
  flows. (Proxy-time decrypt for tool calls is separate and remains
  allowed, since the tool call happens on behalf of the customer.)
- Banner is injected at the top of every customer page during
  impersonation: "You are impersonating <customer name> as <MSP user>.
  Session ends at <time>. [End session]".
- The customer admin sees impersonation events in their own team-audit
  (`src/web/templates/team-audit.ts`) with actor email masked to
  `msp-support@<reseller domain>` by default, full email if customer has
  opted in to full disclosure.
- Only one active impersonation session per (actor, customer) — starting
  a new one ends the old one with `ended_reason=superseded`.

### 9.3 Ending a session
- User clicks "End session" in the banner.
- Session hits `expires_at`.
- MSP user logs out.
- `reseller_owner` force-ends another user's session from the reseller
  audit page.

All exit paths write `ended_at` and `ended_reason`.

## 10. Tech approach

### 10.1 Routes — recommend: new namespaced surface, not reused shell

The existing admin shell under `src/web/routes.ts` is deeply coupled to
"one user, one org, Pro plan, admin/owner role" via `requireTeamAccess`.
Retrofitting a parent-selector into it would create pervasive `if
(isReseller)` branches and make the customer impersonation flow
(which *does* use the existing shell) harder to reason about.

Recommend: a new Fastify plugin `src/reseller/routes.ts` mounted at
`/admin/reseller/*`, with its own auth guard `requireResellerAccess` that
checks (a) auth0 user, (b) membership in a `type=reseller` org, (c)
reseller-scope role >= required level for the route. Templates live in
`src/web/templates/reseller-*.ts` alongside the existing `team-*.ts` so
they share layout / styles / helpers.

Rationale for keeping templates co-located: shared `renderLayout` from
`src/web/layout.ts`, shared styles in `src/web/styles.ts`, shared helpers
in `src/web/helpers.ts`. Only the routes plugin and guards are new.

### 10.2 Data layer
- New services under `src/reseller/`:
  - `reseller-service.ts` — reseller CRUD, membership
  - `reseller-dashboard-service.ts` — fan-out aggregation
  - `provisioning-service.ts` — customer org create + invite
  - `impersonation-service.ts` — session lifecycle
- Migrations in `migrations/` add:
  - `organizations.type`, `organizations.parent_org_id`,
    `organizations.suspended_at`
  - `reseller_members` table
  - `impersonation_sessions` table
  - `reseller_admin_audit` table
  - Indexes: `(parent_org_id)`, `(reseller_org_id, actor_user_id,
    ended_at)` on sessions, `(reseller_org_id, created_at desc)` on audit
- Row-level access in every reseller-scope query filters
  `WHERE parent_org_id = :resellerId` to prevent cross-reseller leakage.
  Add a unit test fixture with two resellers and assert no leakage.

### 10.3 JSON endpoints for the console
The console is server-rendered HTML (matches existing pattern) but a few
endpoints return JSON for incremental UI:
- `GET /api/reseller/:id/customers?q=&status=&plan=&sort=&page=&pageSize=`
- `GET /api/reseller/:id/dashboard/summary`
- `POST /api/reseller/:id/customers`
- `POST /api/reseller/:id/customers/:cid/suspend`
- `POST /api/reseller/:id/customers/:cid/unsuspend`
- `POST /api/reseller/:id/impersonation-sessions`
- `POST /api/reseller/:id/impersonation-sessions/:sid/end`

All are authenticated (consistent with user rule: every endpoint except
health/monitoring must be authenticated).

### 10.4 Feature flag
Gate the whole surface behind `RESELLER_CONSOLE_ENABLED=true`. When off,
`/admin/reseller/*` 404s. Allows staged rollout and keeps upstream
mcp-gateway re-merge clean.

## 11. Analytics / telemetry (for PMF)

Emit structured events to the existing telemetry channel for:
1. `reseller.signup` — reseller org created (from `reseller-tenancy` flow)
2. `reseller.customer.provisioned` — with plan, time-to-provision
3. `reseller.customer.first_active` — first customer user login after
   provisioning (activation funnel)
4. `reseller.customer.first_tool_call` — first successful proxy call
5. `reseller.impersonation.started` / `.ended` — with duration,
   write-action count during session
6. `reseller.dashboard.viewed` — weekly active reseller admins
7. `reseller.customer.suspended` / `.unsuspended`
8. `reseller.customer.churned` — customer org deleted or plan dropped to
   free after being paid
9. `reseller.search.performed` — query length, result count, click-through
10. `reseller.settings.branding_changed`

PMF north-star: **percent of resellers who provision ≥3 customers and
retain them >60 days**. Instrument for this.

## 12. Non-functional requirements

1. **Dashboard load time**: <2s p95 with 100 customers. Requires
   materialized MRR and usage snapshots, not live fan-out. Fan-out is
   the fallback path with a 60s memoized cache.
2. **Customer list**: <500ms p95 to first byte for a reseller with 500
   customers, filtered and paginated.
3. **Cross-customer search**: <1s p95 for a reseller with 500 customers,
   substring match on name + email + org-ID prefix. Backed by a
   Postgres trigram index on `organizations.name` and a GIN index on
   `org_members.email`.
4. **Tenancy isolation**: zero cross-reseller data leakage. Enforced by
   middleware that refuses to serve a route if `:resellerId` doesn't
   match the caller's reseller memberships. Covered by security tests.
5. **Impersonation**: 100% of write actions during a session carry the
   session ID in audit metadata. Verified by a test that starts a
   session, performs a sample of every write action, and asserts.
6. **Availability**: same SLO as rest of Conduit (99.9% monthly). No new
   SPOF.
7. **Accessibility**: WCAG 2.1 AA. Keyboard nav for customer list and
   modals. Screen-reader labels on impersonation warning banner.
8. **Browser support**: last 2 versions of Chrome, Firefox, Safari, Edge.

## 13. Acceptance criteria

Each is independently testable.

1. A user with `reseller_admin` scope on a `type=reseller` org can load
   `/admin/reseller/:resellerId/` and sees the dashboard with
   customer-count, MRR, usage, and incident tiles.
2. A user with no reseller membership gets HTTP 404 (not 403) on any
   `/admin/reseller/*` URL. (404 avoids probing.)
3. A user who is a `reseller_admin` on reseller A gets HTTP 404 on
   `/admin/reseller/<reseller-B-id>/`.
4. The dashboard returns in <2s p95 with 100 seeded customers in a load
   test.
5. A user with `reseller_admin` can complete the new-customer
   provisioning flow in §7.3 and observes: (a) a new `customer`-type org
   created with `parent_org_id = resellerId`, (b) an invitation record
   for the entered admin email, (c) a success page with a copyable
   invite URL.
6. Submitting the provisioning form twice with the same idempotency key
   creates exactly one customer org.
7. The customer list at `/admin/reseller/:id/customers` supports search,
   status filter, plan filter, sort, and pagination; server returns
   `{items,total,page,pageSize}`.
8. Drilling into a customer shows all six sub-tabs (overview, users,
   connections, audit, billing, suspend). Users and connections tabs
   have no write actions visible outside an impersonation session.
9. A `reseller_admin` can start an impersonation session with a reason
   and a duration (max 60m) and is redirected to the customer's team UI
   with a visible impersonation banner.
10. Every write action performed during an impersonation session writes
    `impersonation_session_id` into the audit metadata in both
    `admin_audit_log` and `audit_log`.
11. Impersonation cannot decrypt a customer's stored vendor credentials
    (`src/credentials/credential-service.ts` refuses with an explicit
    error; audit event recorded).
12. Impersonation session expires at `expires_at` and the session cookie
    stops being accepted by the customer-scope auth guard.
13. Suspending a customer sets `organizations.suspended_at`,
    invalidates active sessions for that org, and emits an audit event.
    Customer users hit a "suspended" page until unsuspended.
14. `reseller_support` can impersonate and view customer audit but
    **cannot** view reseller billing or edit reseller settings.
    `reseller_billing` can view billing but **cannot** impersonate or
    view customer audit.
15. Changing reseller default branding does not retroactively change
    existing customer orgs' brand records.
16. Reseller-scope audit log at `/admin/reseller/:id/audit` shows at
    minimum the last 20 events across: provisioned, suspended,
    unsuspended, plan changed, impersonation started, impersonation
    ended, team-member added/removed/role-changed, settings changed.
17. Cross-reseller data leakage test: seed two resellers each with 5
    customers, attempt every reseller-scope endpoint as reseller-A user
    against reseller-B IDs, assert all 404.
18. All `/admin/reseller/*` and `/api/reseller/*` routes require
    authentication; unauthenticated calls get 401 and redirect to login
    for HTML routes.
19. Feature flag `RESELLER_CONSOLE_ENABLED=false` makes every
    `/admin/reseller/*` and `/api/reseller/*` route 404.
20. Emitted telemetry events match the schema in §11 and are visible in
    the existing log-shipping pipeline (`src/log-shipping/`).

## 14. Open questions

1. **Retail pricing model**: MSP sets per-customer prices, or per-plan
   markup? Pricing UI lives in `msp-billing` PRD but the dashboard MRR
   number depends on it. Assume per-plan markup for v1; revisit.
2. **Customer disclosure**: by default, how much of the MSP actor's
   identity is shown to the customer during impersonation? Proposed
   default: masked to `support@<reseller-domain>`; customer can opt to
   full disclosure in their own team settings. Needs privacy review.
3. **Multiple MSP membership**: can one user be a reseller admin for two
   different MSPs (e.g. consultant)? Proposed: yes, with the
   reseller-picker in nav. Any compliance concerns?
4. **Wyre superadmin access**: how does Wyre staff view a reseller's
   console? Separate `/admin/wyre/*` surface, or a "god mode" flag on
   reseller console? Separate surface is cleaner; deferring to
   `wyre-superadmin` PRD.
5. **Bulk provisioning**: CSV import of customers — v2 or never?
6. **Nested resellers**: MSP of MSPs (distributor tier)? Explicitly out
   of scope for this PRD; design does not preclude but does not support.
7. **Reseller deletion**: what happens to child customers when a
   reseller is deleted? Proposed: blocked while any child customers
   exist; must be offboarded or transferred first.
8. **Read-only impersonation mode**: should there be a "view as
   customer admin" that doesn't allow writes, for safer diagnosis?
   Worth exploring; cheap if we gate writes on the
   `impersonation_session.mode` field.
9. **SSO for MSP employees**: does the MSP bring its own IdP (Auth0
   connection, SAML)? Out of scope here; tracked in `msp-sso` PRD.
10. **Notification deliverability**: for customer-billing-failed emails,
    do they go to reseller only, customer only, or both? Proposed:
    reseller by default; customer CC'd if billing mode is "bill
    customer directly".

## 15. Risks

1. Tenancy-leakage bugs are the single biggest risk. Mitigation:
   seed-based cross-reseller test suite runs in CI; reviewer checklist
   for every PR that touches `reseller-*` code.
2. Performance on the dashboard as the fleet grows. Mitigation:
   materialized views + 60s memoization + explicit load test in CI.
3. Support-agent over-reach via impersonation. Mitigation: reason
   required, time-boxed, audited, surfaced to customer, credentials
   never decryptable by MSP.
4. Re-merge to upstream `mcp-gateway` is harder the more this code
   touches shared files. Mitigation: new code in new directories
   (`src/reseller/`, `src/web/templates/reseller-*.ts`). Only minimal
   hooks in shared files, behind a feature flag.
5. Over-complicated reseller RBAC confuses early MSPs. Mitigation:
   ship with `reseller_owner` and `reseller_admin` visibly, and treat
   `support / billing / readonly` as power-user configs that default to
   hidden in the UI until requested.

## 16. Rollout plan

1. Dark launch behind `RESELLER_CONSOLE_ENABLED=false` to staging.
2. Enable for Wyre internal "reseller" to dogfood (we become our own
   first MSP).
3. Enable for 1-2 design-partner MSPs under NDA, with telemetry watched.
4. Open to remaining early partners; pricing from `msp-billing` must be
   live by this step.
5. GA with marketing. Feature flag stays for rollback but defaults on.

## 17. Proposed task list

- [ ] Task: Scaffold `src/reseller/` package (`reseller-service.ts`,
  `routes.ts`, types) and mount at `/admin/reseller/*` behind
  `RESELLER_CONSOLE_ENABLED` flag.
- [ ] Task: Implement `requireResellerAccess` guard with 404-on-no-match
  semantics; unit tests cover all matrix cells from §8.
- [ ] Task: Migrations for `organizations.type`,
  `organizations.parent_org_id`, `organizations.suspended_at`,
  `reseller_members`, `impersonation_sessions`, `reseller_admin_audit`,
  plus indexes from §10.2.
- [ ] Task: Build reseller dashboard view
  (`src/web/templates/reseller-dashboard.ts`) + summary endpoint
  `GET /api/reseller/:id/dashboard/summary`, with materialized snapshot
  + 60s memoized fan-out fallback; load test to <2s p95 at 100
  customers.
- [ ] Task: Build customer list view + endpoint, server-side search /
  filter / sort / paginate; trigram index on `organizations.name`.
- [ ] Task: Build new-customer provisioning flow
  (`src/web/templates/reseller-new-customer.ts` +
  `src/reseller/provisioning-service.ts` + `POST
  /api/reseller/:id/customers`), idempotent on client-supplied key;
  emits `reseller.customer.provisioned` telemetry.
- [ ] Task: Build per-customer drill-in shell with six sub-tabs
  (overview, users, connections, audit, billing, suspend-modal);
  users/connections tabs are read-only outside impersonation.
- [ ] Task: Implement impersonation service + session model + banner
  injection + write-action tagging in both audit services; enforce
  credential-decrypt refusal in `src/credentials/credential-service.ts`.
- [ ] Task: Implement suspend / unsuspend flow with reason capture,
  session invalidation, customer-facing "suspended" page, audit event.
- [ ] Task: Build reseller settings surface: branding defaults,
  invoicing, payment (Stripe Elements), notifications; persist per
  reseller org.
- [ ] Task: Build MSP team management view at
  `/admin/reseller/:id/team` with all five reseller-scope roles;
  invitation flow reusing `src/org/invitation-service.ts`.
- [ ] Task: Build reseller-scope audit view + `reseller_admin_audit`
  write path; integrate with existing `src/audit/` patterns.
- [ ] Task: Cross-reseller isolation test suite (seeded fixtures, 2
  resellers × 5 customers, assert 404 on every cross-access path).
- [ ] Task: Telemetry emission for all events in §11; verify flow
  through `src/log-shipping/`.
- [ ] Task: Feature-flag wiring + staging dark-launch verification +
  dogfood enablement for Wyre's internal reseller org.
- [ ] Task: Accessibility pass (WCAG 2.1 AA) on dashboard, customer
  list, and impersonation modal/banner.
