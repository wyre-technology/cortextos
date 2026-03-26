# Copilot Code Review Instructions — MCP Gateway

## Review Philosophy
- Only comment when you have HIGH CONFIDENCE (>80%) that an issue exists
- Be concise: one sentence per comment when possible
- Focus on actionable feedback, not observations
- Do not suggest style changes unless they cause bugs or violate existing patterns
- Do not comment on import ordering, trailing whitespace, or formatting — that's the linter's job

## Project Context
- **Stack**: Fastify 5 + TypeScript (ESM), PostgreSQL (via `postgres` lib), Vitest
- **Auth**: Auth0 OIDC for login/sessions, OAuth 2.1 + PKCE for MCP client auth
- **Billing**: Stripe (Checkout Sessions, webhooks, Customer Portal)
- **Credentials**: AES-256-GCM encrypted, per-user and per-org, with PBKDF2 key derivation using `scopeId`
- **Deployment**: Azure Container Apps via Bicep IaC, auto-deploy on release
- **MCP proxy**: Reverse proxy at `/v1/:vendor/mcp` — authenticates, injects vendor credentials, forwards to MCP server containers

## Priority Areas (Review These)

### Security (HIGHEST PRIORITY)
- Credential exposure: encrypted data must never appear in logs, error messages, or API responses
- JWT validation: ensure `request.jwtVerify()` is called before accessing user identity
- SQL injection: all queries must use parameterized statements via `postgres` tagged templates (e.g., `sql\`...${value}\``)
- Header injection: vendor credential headers must be sanitized before proxy injection
- Stripe webhook signature verification: webhooks must validate `stripe-signature` header before processing
- AES-256-GCM: check for proper IV generation (random per encryption), auth tag handling, and salt usage
- Rate limiting: ensure rate-limit hooks use `resolveUserId()` for per-user limits, not IP-based

### Correctness
- Credential fallback order must be: personal → org → 403 (never skip to org without checking personal first)
- Async error handling: Fastify route handlers must propagate errors properly (return or throw, never swallow)
- Stripe webhook handlers must return 500 on failure (so Stripe retries), never 200
- Resource cleanup: database connections, HTTP replies must not leak on error paths
- Type narrowing: ensure TypeScript types are properly narrowed after null/undefined checks

### Architecture & Patterns
- Vendor config: each vendor entry in `vendor-config.ts` must have `name`, `slug`, `containerUrl`, `fields`, `headerMapping`, and `docsUrl`
- No duplicate vendor entries (this has caused bugs before)
- Fastify plugins must be registered in the correct order: webhooks before `@fastify/static`, auth before protected routes
- Rate limit `keyGenerator` and `max` must use async callbacks for per-plan dynamic limits
- Audit logging is fire-and-forget via `reply.raw.on('finish')` — it must never block the proxy response
- Bicep changes must include corresponding alert rules for new services

## Do NOT Comment On
- Test file structure or naming conventions (we follow Vitest defaults)
- Minor TypeScript type widening that doesn't affect correctness
- "Consider adding" suggestions for features not in the PR scope
- Comments that just restate what the code already shows
- Import grouping or ordering
