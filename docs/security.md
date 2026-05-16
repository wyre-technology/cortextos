# Security

> **MIGRATED — this file is no longer the source of truth.**
>
> The customer-facing version of this content lives at [`docs/src/content/docs/reference/security.mdx`](src/content/docs/reference/security.mdx) and is published at `https://conduit.wyre.ai/docs/reference/security`.
>
> This file is preserved as engineering reference until the legacy `docs/*.md` sweep-delete (planned once all customer-facing content has been migrated to Starlight). Do not extend this file — make changes in the Starlight `.mdx` version.

---

This page covers how Conduit protects vendor credentials, how it defends against prompt injection, how multi-tenant and subtenant isolation are enforced, and what security properties you should understand when deploying Conduit for your MSP.

> **Document status:** initial publication. Trust Model language is the org-standard anti-claim pattern (see [§ Trust Model](#trust-model)) and has been deliberately mirrored from the WYRE MCP Gateway security doc. Implementation specifics in this version were confirmed against current code by Engineering review (see PR #100). Auth0 flow names are pending PR #36's merge — wording may be tweaked at that point.

---

## Credential Security

### Encryption at Rest

All vendor credentials stored in Conduit are encrypted using **AES-256-GCM** with **per-record key derivation**. The key derivation uses PBKDF2-SHA512 with 100,000 iterations, seeded with a per-record 32-byte salt and a scope-binding string (user, team, or organization identifier). This means:

- Each credential record's encryption key is derived independently — compromising one record's derived key gives no information about any other record.
- Credentials encrypted for one scope cannot be decrypted using another scope's context.
- A database breach exposes ciphertext, not plaintext credentials.

Encryption is performed at the application layer before credentials reach the database. The database stores only encrypted blobs.

The reference implementation lives in [`src/credentials/crypto.ts`](../src/credentials/crypto.ts) (~100 lines). The cipher, KDF, and parameter sizes are byte-for-byte identical to the WYRE MCP Gateway. We're happy to walk through it on a call.

### Credential Resolution Hierarchy

Conduit resolves vendor credentials in the following order:

1. **Personal credential** — stored on the requesting user's account.
2. **Team credential** — if the user is a member of **exactly one** team that has the vendor configured. Multi-team ambiguity (the user is in two teams that both have credentials for the vendor) falls through to the org-level step rather than picking one arbitrarily.
3. **Organization credential** — resolved in two sub-steps: (a) the customer org's own credential, then (b) a reseller-shared vendor grant pointing at the reseller's credential. When a reseller-shared grant is used, the resolution is recorded in the audit log.
4. **403 Forbidden** if no credential is found at any scope.

This hierarchy lets MSPs centralize shared vendor accounts at the org level (or share credentials downstream from a reseller to a sub-customer) while allowing individual technicians to override with personal credentials when needed.

The reference implementation is documented inline in [`src/proxy/credential-injector.ts`](../src/proxy/credential-injector.ts).

### Credential Injection

Vendor credentials are **never** transmitted to Claude, the AI model, or the end-user's local workstation. The flow:

1. Claude (in the user's MCP client) calls a tool — for example, `autotask__list_tickets`.
2. Conduit receives the call, authenticates the request, and decrypts the relevant credentials for that user (resolved per the hierarchy above).
3. Conduit makes the upstream API call to the vendor using the decrypted credentials.
4. The upstream response is returned to Claude.

At no point do credentials leave Conduit's server-side environment. The MCP protocol carries only the tool name, arguments, and result — not credentials.

### Vendor OAuth Tokens

For vendors that use browser-based OAuth (Xero, QuickBooks Online, HubSpot, Microsoft 365), Conduit stores the OAuth access token and refresh token — encrypted using the same per-record AES-256-GCM scheme. Token refresh is handled automatically when access tokens expire.

---

## Trust Model

This section answers the question sophisticated buyers ask: *"If the operator of Conduit gets compromised, what's my exposure?"* It's the right question and we want to answer it precisely.

### The honest version

Conduit decrypts secrets in-process to proxy your API calls — that means whoever operates the deployment (you, if self-hosted; WYRE, if WYRE-managed) holds the trust dependency. With production access plus a database export, an operator could in principle decrypt customer credentials offline. This is a property of any vendor that handles your secrets to make API calls on your behalf — Conduit is in that category, as is every alternative tool that handles credentials.

We will not claim otherwise.

What matters is whether that trust dependency is **bounded**, **observable**, and **reversible**.

### Bounded — the blast radius

- Per-record key derivation means an attacker with master key + database has to do per-record cryptographic work for every credential they want to decrypt. There is no free mass dump.
- There is no admin "view credential" page, no support-tier reset path, and no export script in the codebase. Adding one would require new code visible in git history.
- Postgres Row-Level Security (RLS) is enabled across tenant tables (see [§ Multi-Tenant Isolation](#multi-tenant-isolation)). RLS predicates are written as `SECURITY DEFINER` helper functions to avoid recursive evaluation and to make policy intent reviewable.

### Observable — the audit trail

- Every tool call appears in the audit log within seconds.
- Every infrastructure-level access (secret read, database query) is logged in the cloud provider's activity logs **(verify retention)**.
- Every code change to credential-handling paths goes through code review.

### Reversible — the kill switch

- Rotate the credential at the vendor (ConnectWise, Autotask, etc.) at any time and what Conduit holds goes stale instantly. Conduit holds no persistent vendor sessions.
- Delete the credential from Conduit and the encrypted record is erased immediately.
- Remove a member from your org and their access to org credentials is gone with no cached tokens.
- Remove a sub-organization from a parent reseller and the subtenant relationship is severed (see [§ Subtenant Model](#subtenant-model)).

### What we're working on

The single biggest improvement to this trust model is **envelope encryption with a cloud-managed HSM-backed key encryption key (KEK)** that has `wrapKey`/`unwrapKey` permission only — no extract permission, even for operators. After that change ships, a person with full subscription RBAC can call online decryption (with audit trail) but cannot extract the key for offline mass decryption. This moves the trust boundary from "people with prod access" to "code running in the operator's managed identity context."

Design and migration plan: [`design-docs/master-key-envelope-encryption.md`](../design-docs/master-key-envelope-encryption.md) (in flight, see PR #55).

### What we won't claim

- **"Staff cannot decrypt your data."** Not true today.
- **"Hardware-secured master key."** Not true today. The master key is in a cloud secret, not a hardware module. It moves to HSM-backed KEK with the envelope-encryption work above.
- **"Zero-knowledge service."** Not true and not architecturally possible for a credential proxy.
- **"SOC 2 / ISO 27001 / CMMC certified."** Not certified. We'll claim it when we earn it.

### How to verify what we say

- Run a tool call and verify it appears in your audit log within seconds.
- Rotate a credential at the vendor side and observe Conduit's tool calls fail with the expected upstream auth error.
- Delete a credential and verify it is no longer reachable.
- Ask for a code walkthrough — `src/credentials/crypto.ts` is ~100 lines and explains itself.

---

## Authentication

### User Authentication (Auth0 OIDC)

Conduit users authenticate via Auth0 OIDC. The provider chooser routes new sign-ins through a provider selection screen; existing customers using the legacy Auth0-direct flow continue to work via the same backend. **(verify auth flow names against current routes after PR #36 lands)**

### MCP Client Authentication (OAuth 2.1 + PKCE)

MCP clients (Claude Desktop, Claude Code, third-party MCP clients) authenticate to Conduit via OAuth 2.1 with PKCE (Proof Key for Code Exchange):

1. The MCP client generates a random `code_verifier` and derives a `code_challenge` using SHA-256 (S256 method — plaintext challenge is not accepted).
2. The user is redirected to Conduit's authorization endpoint, including the `code_challenge`.
3. The user completes authentication via Auth0.
4. Conduit returns an `authorization_code` to the MCP client.
5. The MCP client exchanges the `authorization_code` for tokens by sending the `code_verifier` to the token endpoint — proving it is the same client that initiated the flow.
6. Conduit issues a JWT access token and a refresh token.

Conduit publishes OAuth 2.1 metadata at `/.well-known/oauth-authorization-server` in compliance with RFC 8414.

### JWT Access Tokens

Access tokens are HS256-signed JWTs (see [`src/oauth/authorization-server.ts`](../src/oauth/authorization-server.ts)) with a configurable TTL. The token includes the user's identity and organization context. Expired tokens are rejected; MCP clients automatically use the refresh token to obtain a new access token without requiring re-authorization.

### Refresh Token Rotation

Each time a refresh token is used, Conduit issues a new refresh token and invalidates the old one. This rotation pattern means:

- Stolen refresh tokens have a narrow window of usefulness before they are cycled out.
- Concurrent use of the same refresh token (e.g., if a token was intercepted and used by an attacker) is detectable — if the original client and the attacker both try to use it, one will fail with an invalid token error.

### Session Revocation

Owners and admins can revoke user sessions from the dashboard. Revoking a session invalidates all outstanding tokens for that user, requiring re-authentication on their next tool call.

### Invitation Token Hashing

Organization invitation tokens are stored as hashes, not plaintext (migration `015_drop_plaintext_invitation_tokens.sql`). Acceptance and creation paths are rate-limited (10/hr for creation, 5/15min for acceptance) to defeat brute-force enumeration.

---

## Multi-Tenant Isolation

### Database-Level Isolation (RLS)

Every record in Conduit is scoped to an organization ID (`org_id`). Postgres **Row-Level Security (RLS)** is enforced on tenant tables (migration `007_rls_enable.sql` and successors). RLS predicates are written as `SECURITY DEFINER` helper functions (migration `018_rls_security_definer_helpers.sql`) to:

1. Avoid recursive policy evaluation that could pessimize query plans.
2. Centralize tenant-context logic in named functions, making policy intent reviewable.

`WITH CHECK` clauses on `INSERT` and `UPDATE` policies prevent cross-tenant writes (migrations `014`, `020`, `022`).

An authenticated user from Organization A cannot retrieve credentials, audit logs, or member information belonging to Organization B — the RLS predicate is evaluated by Postgres for every query, regardless of how the query is constructed at the application layer.

### Credential Namespace Isolation

Credentials stored by one organization are encrypted using that organization's scope-bound derived keys. Even if two organizations' encrypted blobs were somehow co-mingled, they would be encrypted under different keys and would not be decryptable across organizations.

### Subtenant Model

Conduit supports a reseller hierarchy: an MSP (the reseller) may have multiple sub-organizations (their customers), each of which may itself have sub-organizations. The hierarchy is bounded to depth 3 (migration `021_relax_org_hierarchy_to_bounded_depth.sql`).

A reseller administrator can administer their direct customers and (transitively) their customers' sub-organizations. The transitive admin check is encapsulated in `conduit_is_reseller_admin_of_ancestor` (migration `023_reseller_admin_of_ancestor_helper.sql`). A customer administrator can administer only their own organization and direct sub-organizations.

Reseller-level pricing configuration is scoped to the reseller and not visible to sub-customers (migrations `025`/`026_reseller_pricing_config*.sql`).

### Vendor API Isolation

When Conduit makes upstream API calls, it uses credentials resolved from the requesting user's organization context. Conduit does not share vendor credentials across organizations.

### Container Architecture

Vendor MCP server containers run on an internal network and are not directly exposed to the public internet. All inbound traffic passes through Conduit's authentication and authorization layer before reaching vendor MCP servers. The mechanism varies by deployment topology — `docker-compose` deployments use container `expose:` (internal-only) rather than `ports:` (host-bound), and the production deployment on Azure Container Apps runs vendor containers as internal services reachable only through the gateway, with Azure's managed ingress fronting the single public endpoint.

---

## Prompt Injection Defense

### The Threat

Prompt injection is a class of attack in which malicious instructions are embedded in data returned to the LLM via a tool call — for example, in a ticket subject line, a document body, or an API response field — with the intent of hijacking the model's behavior. In an MSP context this could take the form of:

- A ticket created by an external party with a subject line containing instructions to exfiltrate other ticket data.
- A document in IT Glue containing hidden instructions to retrieve password records.
- An email subject line instructing the model to perform actions on behalf of the attacker.

### Conduit-Level Defenses

Conduit implements structural defenses against prompt injection at the tool response layer:

**Response envelope isolation.** Tool responses are returned to the MCP client as structured `tool_result` objects, not as raw text injected into the conversation. This structural separation makes it harder for injected text to be interpreted as top-level instructions, because the model receives it as data-typed content, not conversation flow.

**Tool result content type tagging.** Responses are tagged with their content type (structured data vs. text), giving the model context about the nature of what it is reading.

**Privileged tool separation.** Tools that access sensitive credential stores (password retrieval in IT Glue, Hudu, etc.) are namespaced and can be restricted to specific roles via tool allowlists. Restricting access to credential retrieval tools reduces the blast radius of a successful injection that attempts to exfiltrate passwords.

### Defensive Practices for MSP Teams

- **Restrict credential-access tools.** Use tool allowlists to limit which roles can call password and credential retrieval tools.
- **Apply least privilege.** Each team member should only reach the tools they need for their role.
- **Monitor anomalous patterns.** Periodically review the audit log for unusual tool usage sequences.

---

## Billing & Payment Security

### Stripe Integration

Subscription billing is handled by Stripe. Conduit never stores card data; it stores only the Stripe customer ID and subscription state.

### Webhook Verification

Stripe webhooks are verified via the Stripe-provided HMAC signature on every request. Webhook handlers return a non-2xx status on processing failure so Stripe will retry — this prevents silent loss of subscription state changes.

### Dunning Lifecycle

Subscription failures (failed renewals, expired cards) move the org through a dunning lifecycle with a configurable grace window before service is gated. The grace window defaults to **7 days** and is configurable via the `WYRE_DUNNING_GRACE_DAYS` environment variable (see [`src/config.ts`](../src/config.ts) and `BillingGate.canAccessPaidFeatures` / `isServiceActive` in [`src/billing/gate.ts`](../src/billing/gate.ts)). The first-failure timestamp is persisted (migration `024_dunning_first_failure_at.sql`) so the lifecycle is recoverable across service restarts.

During the grace window, customers retain access. After the grace window expires, plan-gated features are disabled at the service layer using the `isPaidPlan` helper, ensuring consistent behavior across all enforcement points (PRs #71, #72, #87 sweep).

---

## Audit Logging

Every tool call made through Conduit is recorded in the request log. Log entries are immutable — they cannot be modified or deleted by users. Each entry records:

- User identifier
- Organization identifier
- Tool called (vendor + tool name)
- Timestamp (UTC)
- HTTP response status
- Request duration

Administrative actions (team membership changes, credential updates, allowlist modifications, invitation sends, impersonation events) are separately recorded in the `admin_audit_log` table with the acting user and timestamp.

Admin audit log records are retained for **90 days** by default (see `cleanupAdminAuditLog` in [`src/audit/admin-audit-service.ts`](../src/audit/admin-audit-service.ts)). The retention window is configurable per cleanup invocation; tiered/plan-specific retention is not yet wired. Cleanup is opt-in — there is no scheduled cron job that runs it today.

Owners and admins can export logs as CSV from the dashboard.

---

## Security Recommendations

**For new organizations:**

1. Set default server access to `none` and explicitly grant vendor access via teams. This gives you a deny-by-default posture.
2. Configure tool allowlists for the member role to restrict sensitive operations (credential retrieval, delete operations).
3. Enable MFA on all user accounts via the account settings page.
4. Create service clients for automated workflows instead of sharing user credentials.

**For established organizations:**

1. Review admin audit logs monthly to confirm no unauthorized configuration changes have occurred.
2. Rotate service client secrets on a scheduled basis (quarterly recommended).
3. Remove deprovisioned employees from the organization promptly — an off-boarded employee's access persists until explicitly revoked.

**For organizations in regulated industries:**

1. Export audit logs to your SIEM or long-term storage on a scheduled basis — Conduit's retention may not satisfy your regulatory retention requirements.
2. Configure tool allowlists to prevent credential access tools from being called in automated workflows where they are not needed.
