# PRD — Conduit Onboarding (Funnels A, B, C)

**Tag**: `onboarding`
**Product**: Conduit (white-label MSP channel gateway, forked from `mcp-gateway`)
**Repo**: `/Users/asachs/work/wyre/engineering/projects/gateway/conduit`
**Status**: Draft v1
**Author**: Product / Eng (drafted 2026-04-18)
**Builds on**: upstream branches `feat/onboarding-ux`, `fix/hash-invitation-tokens`, `feat/billing`

---

## 1. Summary

Conduit sells MCP-gateway access through a white-label MSP reseller channel. Every "account" is one of three personas arriving through one of three onboarding funnels. Conduit must convert each of them to activation (first vendor connection + first successful tool call) with minimal friction, without compromising the multi-tenant isolation and billing posture that Wyre is accountable for.

This PRD defines the three funnels, their entry points, the data and services they touch, acceptance criteria, and the engineering tasks required to ship v1.

- **Funnel A — Reseller signup**: An MSP finds Conduit via marketing, signs up, pays, and becomes a reseller org under Wyre.
- **Funnel B — Customer provisioning**: A reseller admin inside Conduit creates a customer sub-org for one of their MSP clients.
- **Funnel C — End-user join**: An individual user clicks an invite link from Funnel A or B and lands inside an org as a regular member.

All three funnels share the same invitation-token substrate, the same brand rendering pipeline, and the same `OrgService` / `InvitationService` / `MemberService` backends — but their UX, gating, and audit surface differ.

---

## 2. Goals & Non-Goals

### 2.1 Goals (v1)

1. A cold MSP prospect can self-service sign up, pay, and provision their first customer in **< 15 minutes**.
2. A reseller admin can provision a new customer sub-org in **< 2 minutes** (happy path, no branding override).
3. An invited end user can reach their org dashboard in **< 90 seconds** from clicking the email link.
4. Every funnel emits discrete analytics events enabling drop-off diagnosis per step.
5. Invite tokens are never stored in plaintext (inherits `fix/hash-invitation-tokens`).
6. No endpoint introduced by this PRD is unauthenticated except the three explicitly enumerated public pages (signup, invite landing, password reset).
7. Every funnel is fully brandable — the reseller's end-customers never see "Wyre" chrome unless the reseller chooses to co-brand.

### 2.2 Non-goals (v2 or later)

- Self-service customer-direct signup without an MSP sponsor.
- SSO auto-provisioning from the MSP's own IdP (SCIM / JIT).
- Affiliate / referral tracking attribution beyond a single UTM cookie.
- Multi-language onboarding copy (English-only at launch).
- In-app chat support widget.
- Usage-based up-tier prompts during onboarding (handled by billing PRD).

---

## 3. Personas

### 3.1 Morgan — MSP Founder (Funnel A)

- Runs a 4-engineer MSP serving ~25 SMB clients.
- Found Conduit from a Pax8 partner webinar. Needs to decide in one sitting if Conduit is worth plugging into their Autotask + Mosyle + CIPP stack.
- Motivations: stop paying per-seat for three separate Claude deployments across clients; unify audit.
- Drop-off risks: confusing pricing, required credit card before demo value, any step that asks for DNS changes before they've seen the product.
- Success criterion: reaches the "Add your first customer" screen within 10 minutes of landing on marketing.

### 3.2 Jamie — MSP Ops Engineer (Funnel B)

- Works under Morgan. Provisions new customers in Autotask, ticketing tools, endpoint management.
- Comes to Conduit from an internal runbook. Expects to provision a customer as a 30-second task between support tickets.
- Motivations: correctness, not discovery. Wants pre-filled defaults, clear confirmation that the customer got the invite.
- Drop-off risks: forms that ask for data Jamie doesn't have (customer's Azure tenant ID, etc.). Any silent failure on email delivery.
- Success criterion: new customer sub-org visible in the reseller admin dashboard, invite email confirmed sent.

### 3.3 Riley — Customer Admin (Funnel B → C bridge)

- IT lead at one of Morgan's customers. Receives an invite from "Morgan @ AcmeMSP".
- Has never heard of Conduit. The reseller brand is what they recognize.
- Motivations: set up Claude access for their helpdesk team without learning a new product category.
- Drop-off risks: any mention of "Wyre" or "mcp-gateway" in the invite email; unclear what they're agreeing to; password flow that bounces them between Auth0 and the product and back.
- Success criterion: lands on dashboard, sees their team pre-seeded, knows what to do next.

### 3.4 Avery — End User (Funnel C)

- Helpdesk tech at Riley's company. Gets an invite from Riley.
- Will use the product 4 hours a day forever after onboarding; their first 90 seconds determine whether they adopt it or route around it.
- Motivations: start answering tickets with Claude immediately.
- Drop-off risks: Auth0 federation friction (Google vs Microsoft vs email); being asked to pick a team when there's only one.
- Success criterion: first tool call within two minutes of accepting the invite.

---

## 4. Funnel A — Reseller Signup

### 4.1 Entry points

- Public marketing site (external). Primary CTA: `Start free trial` linking to `https://conduit.wyre.<tld>/signup`.
- Partner referral links carry `?ref=<partner_slug>` query param; stored in a first-party cookie for 30 days.
- Direct inbound `/signup` hit (word of mouth, sales demo hand-off).

### 4.2 Flow

```
Landing → /signup (email + org name + password, or Auth0 federated)
       → Auth0 verification email (if password path)
       → /onboarding/reseller/welcome  ("Tell us about your MSP")
       → /onboarding/reseller/plan     (reseller-tier plan picker)
       → /onboarding/reseller/billing  (Stripe Checkout — card on file)
       → /onboarding/reseller/brand    (logo upload, primary color, custom domain — optional)
       → /onboarding/reseller/first-customer (optional, launches Funnel B wizard inline)
       → /dashboard                     (activation: customer count > 0 OR "skip" pressed)
```

### 4.3 Signup page — `/signup`

- Public (rate-limited: 10/min per IP, 3/min per email domain).
- Reuses the Conduit landing shell in `src/landing/page.ts`, branded as **Wyre Conduit** by default (no reseller brand yet — they don't exist).
- Three auth paths (all via Auth0, consistent with existing `src/auth/auth0.ts`):
  1. Email + password.
  2. Continue with Google.
  3. Continue with Microsoft (same Azure AD flow as `src/auth/azure-ad.ts`).
- Form fields: `email`, `password` (if not federated), `organization_name`, `expected_customer_count` (select: 1-5 / 6-20 / 21-100 / 100+), `agreed_to_terms` (required checkbox, links to ToS + DPA).
- On submit: creates Auth0 user, creates `orgs` row with `kind='reseller'`, creates owner `org_members` row, sets session cookie, redirects to `/onboarding/reseller/welcome`.

### 4.4 Reseller application review

- **v1 decision**: **auto-approve**, gated only by Stripe-verified payment method.
- No manual review queue in v1. An async job checks for fraud signals (burner email domains, known-bad IP ranges, velocity heuristics) and flags the reseller org with `review_required=true`, which blocks `addCustomer` until a Wyre admin clears.
- v2 will add an explicit review queue UI in the Wyre-internal admin surface.

### 4.5 Plan selection for MSP (reseller tiers)

- Three reseller tiers (mirrors customer-facing billing in `src/billing/plan-catalog.ts` but with wholesale pricing):
  - **Launch** — up to 5 customer sub-orgs, $X/mo, 20% channel discount on customer Pro tier.
  - **Growth** — up to 25 customer sub-orgs, $Y/mo, 30% channel discount.
  - **Scale** — unlimited customer sub-orgs + dedicated Slack, custom pricing, 40% channel discount.
- Stripe product + price IDs live in `src/billing/plan-catalog.ts` under a new `resellerPlans` registry.
- A 14-day trial is granted automatically; credit card is required to start the trial but is not charged until day 14.

### 4.6 Reseller admin tour

Three-step interstitial wizard after billing completion. Progress persisted server-side in `onboarding_progress` table (see §7.5) so the user can close the tab and resume.

1. **Who are your customers?** — optional survey (industries, geo, average customer size). Used to tailor vendor suggestions.
2. **Which vendors will you offer?** — multi-select over the vendor catalog (pulled from `vendors` table), pre-checked based on the industry survey answers. Becomes the reseller's default allowlist inherited by new customer sub-orgs.
3. **Your brand** — logo upload, primary color (with live preview that mimics `src/brand/types.ts` shape), optional custom subdomain (`<reseller>.conduit.wyre.<tld>`) with DNS verification queued async.

Tour is skippable. Each skipped step emits an analytics event.

### 4.7 First-customer wizard

- At the end of the reseller tour: "Ready to add your first customer?" — CTA launches Funnel B inline.
- If skipped, the dashboard shows a persistent top-of-page banner: "You haven't added a customer yet — [Add your first customer]" until either a customer is added or the banner is dismissed by the reseller.

### 4.8 Files touched / added (Funnel A)

- New: `src/onboarding/reseller-signup.ts` (Fastify route plugin).
- New: `src/onboarding/reseller-wizard.ts` (wizard state machine).
- New: `src/web/templates/onboarding-reseller.ts` (HTML templates in the inline-template style already used by `src/web/templates/team-overview.ts`).
- New migration: `migrations/002_onboarding_progress.sql` — creates `onboarding_progress` and adds `orgs.kind`, `orgs.review_required`, `orgs.trial_ends_at`.
- Modified: `src/billing/plan-catalog.ts` — add `resellerPlans` registry.
- Modified: `src/billing/checkout.ts` — support reseller plan SKUs.
- Modified: `src/landing/page.ts` — add CTA to `/signup`.
- New: `src/auth/signup.ts` — Auth0 user-creation helper (branches on federated vs password).

---

## 5. Funnel B — Customer Provisioning

### 5.1 Entry points

- Reseller admin dashboard top-of-page banner (post-Funnel A if skipped).
- Reseller admin sidebar → **Customers** → **+ Add Customer**.
- Inline CTA at the end of Funnel A's wizard.
- CLI: `conduit customer add` (forwarded to the same server-side service — same transaction).

### 5.2 Who can invoke

- `org_members.role = 'owner'` or `'admin'` on a reseller org **only**.
- Not self-service — no public URL. Attempting to POST the endpoint without an authenticated reseller-owner session returns 403.
- Rate-limited to 20 customer creations per reseller per hour (abuse guardrail).

### 5.3 Form — `/admin/customers/new`

Required fields:

| Field | Notes |
| --- | --- |
| `customer_name` | Display name of the customer company. Used in all branded emails. |
| `primary_admin_email` | Must not already be a member of another org owned by this reseller (conflict → pick a different email or merge). |
| `plan` | Select from the reseller's own published plan catalog (defaults to the reseller's "default customer plan"). |

Optional fields:

| Field | Notes |
| --- | --- |
| `domain` | Customer's primary email domain. When set, Funnel C invites auto-accept if the invitee's email matches and the reseller has enabled domain trust. |
| `brand_override.logo_url` | Falls back to reseller brand. |
| `brand_override.primary_color` | Falls back to reseller brand. |
| `vendor_allowlist` | Multi-select; defaults to the reseller's configured allowlist from Funnel A step 2. |
| `send_invite_now` | Boolean, default true. If false, creates the sub-org in "draft" state with no invite email. |

### 5.4 Provisioning transaction

Single DB transaction (extends `src/org/org-service.ts`):

1. Insert `orgs` row with `kind='customer'`, `parent_org_id=<reseller_id>`, `plan_id=<selected>`, `brand_override=<jsonb>`.
2. Insert `tool_allowlists` row seeded from the reseller default or the explicit override.
3. Insert `onboarding_progress` row with `step='customer_admin_pending'`.
4. If `send_invite_now`, call `InvitationService.createInvitation` with `maxUses=1`, `expiresInHours=168` and an `intended_role='owner'` flag (new column — v1 always invites the customer primary admin as owner of the customer sub-org).
5. Audit event `customer_org.created` with reseller actor, customer target, and plan.

Failure in any step rolls back all rows. No partial customer sub-org can exist.

### 5.5 Invite email to customer admin

- Template: `src/web/templates/emails/customer-admin-invite.ts` (new).
- Subject: `You've been invited to <customer_name>'s Conduit workspace by <reseller_name>`.
- Uses reseller brand (not Wyre) for logo, primary color, from-address display name.
- SMTP from-address is `invites@<reseller-subdomain>.conduit.wyre.<tld>` when custom subdomain is verified, else `invites@conduit.wyre.<tld>` with reseller's name in the display.
- Body references the invite link: `https://<reseller-subdomain-or-default>/invite/<token>`. Tokens are hashed at rest per upstream `fix/hash-invitation-tokens`.
- Email delivery goes through the platform's existing transactional provider (reused from the team-invite flow in `src/org/routes/invitations.ts`).

### 5.6 Customer admin tour

After Riley clicks the invite, sets their password, and lands on the dashboard:

- Step 1: **Welcome to your workspace** — shows what the reseller provisioned (plan, default vendors, team count).
- Step 2: **Invite your team** — inline email-list invite form. Reuses `InvitationService` in multi-use or single-use mode depending on field.
- Step 3: **Connect your first vendor** — vendor picker filtered by the customer's allowlist. Launches OAuth for the selected vendor.
- Completion: `onboarding_progress.step` becomes `activated`; analytics event `customer.activated` emitted with `time_to_activation_ms`.

Tour is **self-guided** (not briefed by MSP). MSP can optionally pre-populate team invites in Funnel B form, but this is v1.1 — not v1.

### 5.7 Default vendor allowlist

- Every customer sub-org inherits `tool_allowlists` from its parent reseller at provisioning time.
- Reseller admin can edit the allowlist per-customer after creation.
- Future customer-side requests to enable a vendor not on the allowlist surface a "Request from your MSP" flow — a notification into the reseller admin's queue. **v2, noted for scope awareness.**

### 5.8 Files touched / added (Funnel B)

- New: `src/onboarding/customer-provision.ts` (Fastify route + service).
- New: `src/web/templates/emails/customer-admin-invite.ts`.
- New: `src/web/templates/onboarding-customer.ts` (admin tour templates).
- Modified: `src/org/org-service.ts` — add `createCustomerSubOrg({ resellerId, ... })`.
- Modified: `src/org/invitation-service.ts` — add `intended_role` column support; column added by migration 003.
- Modified: `src/org/routes/org-crud.ts` — new `POST /orgs/:resellerId/customers` route.
- New migration: `migrations/003_customer_suborg.sql` — `orgs.parent_org_id`, `orgs.kind`, `org_invitations.intended_role`, indexes.

---

## 6. Funnel C — End-user Join

### 6.1 Entry point

- Clicking the invite link in an email (from Funnel A's team invite, Funnel B's customer admin invite, or Riley inviting Avery).
- Existing invite handler: `src/org/routes/invitations.ts` — see `renderInvitePage()`. Funnel C extends this rather than replacing it.

### 6.2 Flow

```
Email → /invite/<token>
      → render invite landing (reseller-branded if org is customer sub-org, Wyre-branded if Wyre employee invite)
      → [Accept & Join] button
      → /auth/login?invite=<token>  (Auth0 Universal Login)
            └── federation decision (see §6.3)
      → Auth0 callback
      → InvitationService.acceptInvitation()
      → welcome interstitial ("You've joined <org_name>")
      → /dashboard
```

### 6.3 Auth0 federation decision

When the invitee lands at Auth0:

- If the invitee's email domain matches the customer org's `domain` field **and** the reseller has enabled domain federation for that customer, Auth0 is configured to prefer the matching social / enterprise connection. Implementation: server-side `connection` hint appended to the `/authorize` URL by `src/auth/auth0.ts`.
- Otherwise, the default Auth0 Universal Login is shown with all enabled social connections.
- Password-path users verify email before being redirected back to `acceptInvitation`.

### 6.4 Default role + team assignment

- Default role on acceptance: `member`. (The customer admin's invite in Funnel B uses `intended_role='owner'` explicitly — see §5.4.)
- Team assignment: if the invite includes a `team_id` (the inviter can pre-select), the accepted member is added to that team. If not, the member is unassigned (org-level only).
- Existing `MemberService` logic (`src/org/member-service.ts`) handles the actual insert. This PRD adds only the team hint.

### 6.5 Files touched (Funnel C)

- Modified: `src/org/routes/invitations.ts` — render branded page using the **target org's** brand, not Wyre's. Add post-accept welcome interstitial.
- Modified: `src/auth/auth0.ts` — support `connection` hint in `/authorize` redirect.
- Modified: `src/org/invitation-service.ts` — accept optional `teamId` on create, apply on accept.
- Modified migration 003 — adds `org_invitations.team_id` and `org_invitations.intended_role`.

---

## 7. Technical Building Blocks (shared)

### 7.1 Invitation tokens

- Generation: `nanoid(32)` (current behavior in `src/org/invitation-service.ts`).
- Storage: **hashed** at rest with SHA-256, matching upstream `fix/hash-invitation-tokens`. The plaintext is returned once to the caller (for the email) and discarded.
- Expiry: default 7 days (168 hours), configurable per-invite.
- One-time use: `max_uses=1` for Funnel B customer-admin invites; Funnel A/C team invites default to single-use but support multi-use with `max_uses=null` (open invite links — used sparingly).
- Lookup: caller passes plaintext token, server hashes, compares. Indexed on the hash column.
- Revocation: `InvitationService.revokeInvitation()` deletes the row; lookups naturally fail.

### 7.2 Wizard framework

- **Reuse, don't rebuild.** The existing `src/web/templates` use inline-HTML rendering. We add a thin wizard helper — `src/web/wizard.ts` — that renders step UI from a declarative config:
  ```ts
  type WizardStep = {
    id: string;
    title: string;
    path: string;
    render: (ctx) => string;
    validate: (body) => { ok: true } | { ok: false; error: string };
    onComplete: (body, ctx) => Promise<void>;
  };
  ```
- Progress persisted in `onboarding_progress` (see §7.5) rather than cookies — survives device switches.
- No client-side framework. Server-rendered, form-POST per step.

### 7.3 Transactional email templates

- Three new templates (reseller-branded):
  - `customer-admin-invite.ts` — §5.5.
  - `team-member-invite.ts` — refactor existing invite email to accept brand.
  - `password-reset-branded.ts` — passthrough into Auth0's reset with custom From + logo via the Auth0 tenant's email provider configuration.
- All templates take a `brand: BrandConfig` param and fall back to the platform default from `src/brand/index.ts`.
- Plain-text alternates required for deliverability.
- `List-Unsubscribe` header on every non-security email.

### 7.4 Custom subdomains (Funnel A step 3)

- Reseller picks a slug; server checks availability against `reseller_subdomains` table.
- DNS verification runs as an async job (CNAME target published in the wizard UI).
- Until verified, emails and invite links fall back to `conduit.wyre.<tld>`.
- Verification status shown in the reseller admin dashboard; re-checkable on demand.

### 7.5 Progress persistence

New table (migration 002):

```sql
CREATE TABLE onboarding_progress (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  funnel      TEXT NOT NULL CHECK (funnel IN ('reseller','customer','end_user')),
  step        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, org_id, funnel)
);
CREATE INDEX idx_onboarding_progress_open
  ON onboarding_progress (user_id) WHERE completed_at IS NULL;
```

Writes happen at each step boundary. Resume logic loads the row and jumps the user to the last-incomplete step.

---

## 8. Abuse & Security

### 8.1 Rate limits

- `/signup` — 10 requests/min per IP; 3/min per email domain (Fastify `@fastify/rate-limit`, already in the dep list).
- `/onboarding/reseller/*` — 30/min per authenticated user.
- `/admin/customers/new` — 20 creations/hour per reseller org.
- `/invite/<token>` — 30/min per IP (prevents token brute-forcing; hashing already makes enumeration impractical).

### 8.2 Customer sub-org self-service boundary

- `POST /orgs/:resellerId/customers` requires reseller-scoped `owner` or `admin` role.
- No public route creates a customer sub-org. Direct Stripe webhook hits (e.g. a rogue Checkout Session) do not create orgs — org creation precedes checkout.
- Every `customer_org.created` event is audited with IP, UA, and reseller admin user ID.

### 8.3 Email verification before billing

- Auth0 email verification is the gate: `/onboarding/reseller/billing` renders a "please verify your email" screen if `email_verified=false`, with a resend button (rate-limited 1/min).
- Federated accounts (Google / Microsoft) are considered verified.

### 8.4 Invite security

- Tokens hashed at rest.
- Single-use invites flip to `accepted_by` on success — later reuse fails.
- Expired invites return a generic error page (no info leak about whether the token ever existed).

### 8.5 CSRF

- All state-changing onboarding forms include a CSRF token bound to the session cookie, validated on POST.
- Auth0 OAuth callbacks use `state` param to carry the `invite` hint across federation.

### 8.6 Multi-tenant isolation

- `OrgService` is the single choke point that joins `parent_org_id`. All queries that list a reseller's customers filter by `parent_org_id=<reseller_id>`.
- Sub-org admins cannot escalate to reseller scope even by crafted requests — the role check in `src/org/routes/helpers.ts` is scoped per org.

---

## 9. Analytics & Activation

### 9.1 Events

All emitted via the existing audit channel (`src/audit/*`) plus a lightweight analytics sink (Segment-compatible payload — destination wiring is out of scope for this PRD).

| Event | Properties | Funnel |
| --- | --- | --- |
| `signup.page_viewed` | utm, ref, ip_country | A |
| `signup.submitted` | method=password/google/microsoft | A |
| `signup.verified_email` | seconds_since_submit | A |
| `reseller.plan_selected` | plan_id, trial | A |
| `reseller.billing_completed` | plan_id | A |
| `reseller.wizard_step_completed` | step | A |
| `reseller.wizard_skipped` | step | A |
| `reseller.activated` | seconds_since_signup | A |
| `customer.create_form_submitted` | has_brand_override | B |
| `customer.provisioned` | reseller_id, plan_id | B |
| `customer.invite_sent` | reseller_id | B |
| `customer.invite_delivered` | reseller_id | B |
| `customer.invite_opened` | reseller_id | B |
| `customer.admin_accepted` | seconds_since_invite | B |
| `customer.first_vendor_connected` | vendor | B |
| `customer.activated` | seconds_since_admin_accepted | B |
| `end_user.invite_accepted` | org_id | C |
| `end_user.first_tool_call` | seconds_since_accept | C |

### 9.2 Activation definitions

- **Reseller activated** = first customer sub-org provisioned AND billing method on file.
- **Customer activated** = customer admin has accepted AND first vendor connected AND at least one other team member invited (not required to have accepted).
- **End user activated** = first successful tool call.

### 9.3 Time-to-first-value (TTFV)

Primary metric for each funnel:

- Funnel A TTFV: seconds from `signup.submitted` to `reseller.activated`. **Target p50 < 12 min, p90 < 30 min.**
- Funnel B TTFV: seconds from `customer.create_form_submitted` to `customer.activated`. **Target p50 < 1 hour (depends on human delay), p90 < 24 hours.**
- Funnel C TTFV: seconds from `end_user.invite_accepted` to `end_user.first_tool_call`. **Target p50 < 120 sec.**

### 9.4 Dashboards

- One internal-only dashboard per funnel showing step-by-step retention and TTFV percentiles. Not in PRD scope to implement; the events above are the contract.

---

## 10. Acceptance Criteria

Numbered, testable, grouped by funnel.

### Funnel A

1. Anonymous GET `/signup` returns 200 with a form containing email, password, org name, and the three auth buttons.
2. POST `/signup` with a valid body and a valid Auth0 response creates an `orgs` row with `kind='reseller'` and an `org_members` row with `role='owner'` in a single transaction.
3. A failure to create the Auth0 user rolls back any DB writes.
4. `/onboarding/reseller/billing` refuses to render until `email_verified=true` or the user authenticated via a federated provider.
5. Reseller plan selection persists `plan_id` on the `orgs` row and triggers a Stripe Checkout session whose successful webhook marks `trial_ends_at=NOW()+14 days`.
6. Closing the tab mid-wizard and returning to `/onboarding/reseller` resumes on the last-incomplete step.
7. Skipping the "first customer" prompt at the end leaves a dismissible banner on `/dashboard` until either dismissed or a customer is added.
8. Signup rate limit triggers at 11 requests/min per IP — 11th returns 429.

### Funnel B

9. `POST /orgs/:resellerId/customers` with reseller-owner auth creates a child org with `parent_org_id=<reseller_id>`, `kind='customer'`, and the selected plan.
10. The same call creates a single-use `org_invitations` row with `intended_role='owner'` and dispatches an email whose From display is the reseller's name.
11. The provisioning transaction rolls back fully on any failure (no orphan orgs, invitations, or allowlists).
12. A non-owner/non-admin reseller member receives 403 on the create-customer route.
13. Rate limit caps customer creation at 20/hour per reseller.
14. Brand override fields, when blank, inherit from the reseller brand at render time (confirmed by server-rendered email preview test).
15. Customer admin tour completion flips `onboarding_progress.step='activated'` and emits `customer.activated`.

### Funnel C

16. GET `/invite/<valid_token>` renders the target org's brand (not Wyre) for customer sub-org invites.
17. GET `/invite/<expired_token>` and `/invite/<unknown_token>` both return the same generic error page.
18. POST `/invite/<token>` after Auth0 login creates an `org_members` row with the `intended_role` from the invite (default `member`).
19. Invite tokens are stored only as SHA-256 hashes — a DB snapshot contains no plaintext token.
20. Federation hint is applied when the invitee's email domain matches the customer org's `domain` and domain trust is enabled.

### Cross-funnel

21. Every new state-changing endpoint introduced by this PRD requires authentication (except `/signup`, `/invite/<token>`, and Auth0 callbacks).
22. Every funnel state change emits a matching analytics event per §9.1.
23. No PII appears in analytics event payloads beyond `user_id`, `org_id`, `email_domain` (hashed where appropriate).

---

## 11. Out of Scope

- Customer-direct signup without an MSP sponsor.
- SSO JIT / SCIM provisioning from the MSP's own IdP.
- Affiliate / referral tracking beyond a single `?ref=` UTM.
- In-product chat / Intercom-style widgets.
- Localization — English only for v1.
- Manual reseller application review queue (auto-approve only for v1).
- Custom email domain DKIM/SPF setup UI (custom subdomains in v1 only; custom sender domains in v2).
- Usage metering alerts during onboarding (owned by billing PRD).

---

## 12. Open Questions

1. **Reseller plan pricing**: Launch / Growth / Scale price points not finalized. Blocker for Funnel A step 4. Owner: Product.
2. **Channel discount structure**: Flat % off customer plans or tiered by volume? Impacts copy in Funnel A plan picker. Owner: Finance.
3. **Trial length**: 14 days proposed; sales wants 30. Data point: no Conduit data yet; inherit mcp-gateway billing norms?
4. **Customer plan defaults**: Do resellers publish their own plans to their customers, or do they resell Wyre's plans with a markup? Affects the plan picker in Funnel B.
5. **Email delivery provider**: Inherits from mcp-gateway. Confirm Postmark/SES choice is stable before investing in branded templates.
6. **Auto-approve fraud thresholds**: What triggers `review_required=true`? Needs a starter heuristic list from Security.
7. **Custom subdomain UX if DNS takes > 1 hour**: Show a spinner? Send an email? Let the reseller proceed and switch later? Proposal: proceed, switch later.
8. **Funnel B domain trust default**: On or off for new customer orgs? Leaning off for v1 (opt-in per customer).
9. **CLI parity**: Should `conduit customer add` ship day one or 30 days later? Jamie persona asks for it; likely v1.1.
10. **Wyre co-branding toggle**: Is "Powered by Wyre" visible by default on reseller-branded surfaces, and can resellers pay to remove? Needs positioning call.

---

## 13. References to existing code

- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/invitation-service.ts` — token generation (needs hash-at-rest change, add `intended_role`, `team_id`).
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/routes/invitations.ts` — invite landing pages, templates, accept route.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/routes/org-crud.ts` — org CRUD; add `createCustomerSubOrg` route.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/org-service.ts` — add parent/child org methods.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/member-service.ts` — already handles membership inserts; no change required for C.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/org/tool-allowlist-service.ts` — vendor allowlist inheritance target.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/auth/auth0.ts` — Auth0 login/redirect; add `connection` hint.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/auth/azure-ad.ts` — Microsoft federation path referenced by signup.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/brand/index.ts` — brand resolution used by all rendered templates.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/brand/customers.ts` — per-customer brand registry (template for reseller-specific brand overrides).
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/billing/plan-catalog.ts` — extend with `resellerPlans` and customer-plan resale metadata.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/billing/checkout.ts` — reseller-tier Stripe Checkout.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/billing/gate.ts` — billing gates extend to cover reseller-kind orgs.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/landing/page.ts` — add CTA to `/signup`.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/web/helpers.ts`, `src/web/layout.ts`, `src/web/styles.ts` — shared web chrome.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/src/waitlist/routes.ts` — prior art for rate-limited public signup surface.
- `/Users/asachs/work/wyre/engineering/projects/gateway/conduit/migrations/001_customer_tenants.sql` — existing migration numbering; next migration is `002_onboarding_progress.sql`, then `003_customer_suborg.sql`.

---

## 14. Rollout plan

1. **Phase 1 — foundations** (week 1–2): migrations 002 + 003 merged, `org_invitations` hash-at-rest rebased from upstream, `OrgService.createCustomerSubOrg` shipped behind a feature flag.
2. **Phase 2 — Funnel B** (week 2–3): reseller admin UI to add a customer + customer-admin invite email. Internal dogfood: Wyre's own Conduit org provisions a test customer.
3. **Phase 3 — Funnel A** (week 3–5): public `/signup`, wizard, billing integration. Gated launch to 10 hand-picked MSP partners.
4. **Phase 4 — Funnel C polish** (week 4): branded invite page, federation hint, welcome interstitial. Ships in parallel with Phase 3.
5. **Phase 5 — GA** (week 6): remove feature flag, open marketing page, enable analytics dashboards.

Every phase ends with a changelog entry per `https://keepachangelog.com/en/1.1.0/`.

---

## 15. Proposed task list

Sized to fit 12–18 taskmaster tickets in the `onboarding` tag.

1. **Migration: onboarding_progress table + `orgs.kind`/`trial_ends_at` columns** — foundation for all funnels.
2. **Migration: customer sub-org schema** — `orgs.parent_org_id`, `org_invitations.intended_role`, `org_invitations.team_id`.
3. **Rebase invitation token hash-at-rest from upstream `fix/hash-invitation-tokens`** — security prerequisite.
4. **Server: `OrgService.createCustomerSubOrg` transaction + unit tests** — single entry point for Funnel B provisioning.
5. **Server: `POST /orgs/:resellerId/customers` route with role + rate-limit guards** — Funnel B API surface.
6. **Email: branded `customer-admin-invite` template + delivery pipeline** — Funnel B invite email.
7. **UI: reseller "Add Customer" form + confirmation screen** — Funnel B front-end.
8. **UI: customer admin welcome tour (team invite, first vendor connect)** — Funnel B activation steps.
9. **Server: public `/signup` route (Auth0 integration, rate limit, CSRF)** — Funnel A entry.
10. **Billing: reseller plan catalog entries + Stripe checkout integration** — Funnel A plan + trial.
11. **UI: reseller onboarding wizard framework + 3-step tour (industry, vendors, brand)** — Funnel A interstitial.
12. **UI: reseller first-customer inline launch + dismissible banner** — Funnel A → Funnel B bridge.
13. **Subdomain verification job + reseller brand setup UI** — Funnel A step 3 custom domain.
14. **Funnel C: branded `/invite/<token>` page + post-accept welcome interstitial** — extends existing `src/org/routes/invitations.ts`.
15. **Funnel C: Auth0 `connection` hint for domain federation** — `src/auth/auth0.ts` change + tests.
16. **Analytics: event emission wiring for all 18 onboarding events** — instrumentation across the three funnels.
17. **Auto-approve fraud heuristics + `review_required` block on `addCustomer`** — abuse guardrail for Funnel A.
18. **End-to-end integration test: full A → B → C happy path** — acceptance gate before GA.

---

*End of PRD — prd-onboarding.md*
