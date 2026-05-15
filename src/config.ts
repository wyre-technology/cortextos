import { randomBytes } from 'node:crypto';

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

function resolveKey(envVar: string, label: string): string {
  const value = process.env[envVar];
  if (!value) {
    const generated = randomBytes(32).toString('hex');
    console.warn(
      `WARNING: ${envVar} not set — using random ${label}. ` +
        'All tokens/credentials will be invalidated on restart.',
    );
    return generated;
  }
  if (!HEX_64_RE.test(value)) {
    throw new Error(
      `${envVar} must be exactly 64 hex characters (32 bytes). Got ${value.length} chars.`,
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:8080',

  // Allowlist of hostnames the gateway is reachable on. Used by
  // getRequestBaseUrl() to derive per-request base URLs for OAuth callbacks,
  // discovery metadata, and cookie scoping. Override via ALLOWED_HOSTS env
  // (comma-separated). The first entry is the canonical fallback.
  allowedHosts: (process.env.ALLOWED_HOSTS ?? 'mcp.wyre.ai,staging.conduit.wyre.ai,mcp.wyretechnology.com,localhost:8080')
    .split(',').map((h) => h.trim()).filter(Boolean),

  // Master encryption key (32 bytes hex). MUST be set in production.
  masterKey: resolveKey('MASTER_KEY', 'master key'),

  // PostgreSQL connection URL
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://gateway:gateway@localhost:5432/gateway',

  // JWT signing key (separate from encryption master key)
  jwtSecret: resolveKey('JWT_SECRET', 'JWT secret'),

  // Token lifetimes
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL ?? 3600), // 1 hour
  refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL ?? 2592000), // 30 days
  authCodeTtlSeconds: Number(process.env.AUTH_CODE_TTL ?? 300), // 5 minutes

  // Log level
  logLevel: (process.env.LOG_LEVEL ?? 'info') as
    | 'debug'
    | 'info'
    | 'warn'
    | 'error',

  // Auth provider selection:
  //   'auth0'    — Auth0 only
  //   'azure-ad' — Microsoft Entra ID only
  //   'both'     — both providers active, chooser at /login picks one
  //   'auto'     — enable whichever credential sets are present (default)
  authProvider: (process.env.AUTH_PROVIDER || 'auto') as 'auth0' | 'azure-ad' | 'both' | 'auto',

  // Auth0 OIDC configuration
  auth0Domain: process.env.AUTH0_DOMAIN ?? '',       // e.g. "wyre.us.auth0.com"
  auth0ClientId: process.env.AUTH0_CLIENT_ID ?? '',
  auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET ?? '',
  auth0CallbackUrl: process.env.AUTH0_CALLBACK_URL ?? '',  // e.g. "https://gateway.example.com/auth/callback"

  // Azure AD OIDC configuration (multi-tenant).
  // MICROSOFT_CLIENT_ID/SECRET are accepted as fallbacks for the legacy
  // env-naming convention used by mcp-gateway. Deployments that predate
  // the AZURE_AD_* naming (notably the existing staging Container App)
  // still set MICROSOFT_* — the fallback keeps the Microsoft sign-in
  // flow live without requiring a coordinated env rename. Drop the
  // fallback once all envs are migrated to AZURE_AD_*.
  azureTenantId: process.env.AZURE_AD_TENANT_ID ?? '',
  azureClientId: process.env.AZURE_AD_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID ?? '',
  azureClientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET ?? '',
  azureCallbackUrl: process.env.AZURE_AD_CALLBACK_URL ?? '',

  // Stripe billing
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  stripeProPriceId: process.env.STRIPE_PRO_PRICE_ID ?? '',

  // Vendor health monitor
  monitorWebhookUrl: process.env.MONITOR_WEBHOOK_URL ?? '',
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS ?? 60_000),

  // Alpha invite codes (comma-separated) — orgs created with a valid code get pro plan
  alphaInviteCodes: new Set(
    (process.env.ALPHA_INVITE_CODES ?? '').split(',').map(c => c.trim()).filter(Boolean)
  ),

  // Entra ID tenant IDs we trust to attest the user's email is verified.
  // Microsoft tokens don't include an email_verified claim, so we treat
  // email from a token whose `tid` is on this allowlist as verified. Empty
  // (default) means we trust no Entra tenant for verification — every
  // Entra-issued session arrives with emailVerified=false. Override via
  // ENTRA_TRUSTED_TENANT_IDS=<comma-separated GUID list>.
  entraTrustedTenantIds: new Set(
    (process.env.ENTRA_TRUSTED_TENANT_IDS ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),

  // Comma-separated email addresses allowed to access /admin/* via a logged-in
  // browser session. Bearer-token auth (ADMIN_API_KEY) still works for scripts
  // and CI. Browser-session admin gate ALSO requires emailVerified=true on the
  // session — see src/lib/admin-auth.ts. Empty (default) means no email-based
  // admin path; only ADMIN_API_KEY works.
  adminEmails: new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),

  // Comma-separated public-facing Stripe coupon codes that customers may
  // apply at checkout. Empty means no client-supplied coupons are honored —
  // internal/sales-driven discounts must be applied server-side. Without
  // this allowlist any owner could submit any active coupon code in the
  // Stripe account, including internal/sales codes.
  stripePublicCouponCodes: new Set(
    (process.env.STRIPE_PUBLIC_COUPON_CODES ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  ),

  // Admin API key — protects internal admin endpoints (e.g. waitlist export)
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  // Webhook URL for waitlist signup notifications (Discord or Slack)
  waitlistNotifyUrl: process.env.WAITLIST_NOTIFY_URL ?? '',

  // Slack incoming-webhook URL for #conduit-sales notifications (billing
  // anomalies — webhook customer-mismatch, etc.). Empty (default) makes
  // every notifier in src/billing/sales-notifier.ts a no-op so local dev
  // and pre-rollout deploys don't crash the Stripe webhook handler.
  slackSalesWebhookUrl: process.env.SLACK_SALES_WEBHOOK_URL ?? '',

  // Loops.so marketing automation
  loopsApiKey: process.env.LOOPS_API_KEY ?? '',

  // Dunning lifecycle (Track A — Ruby's checkpoint 3 design, Aaron-acked).
  // Grace period in days that elapses BEFORE service suspension after the
  // FIRST invoice.payment_failed. Stripe's smart-retries run during the
  // first ~7 days; WYRE adds this grace AFTER retries exhaust before the
  // org's gates flip to suspended. v1 is a global constant per Aaron's
  // flat policy; per-org configurability deferred to v2 if reseller-channel
  // surface needs it.
  dunningGraceDays: Number(process.env.WYRE_DUNNING_GRACE_DAYS ?? '7'),

  // Feature flags — derived from config or explicit env vars
  features: {
    waitlist: !!process.env.WAITLIST_NOTIFY_URL,
    billing: !!process.env.STRIPE_SECRET_KEY,
    dashboard: process.env.FEATURE_DASHBOARD !== 'false',   // on by default
    promptCapture: process.env.FEATURE_PROMPT_CAPTURE !== 'false', // on by default
    // MSP Admin Console — ships dark, opt-in per reseller deploy.
    // See .taskmaster/docs/prd-msp-admin.md.
    resellerConsole: process.env.RESELLER_CONSOLE_ENABLED === 'true',
    // Public reseller signup (Funnel A, PRD prd-onboarding.md §4).
    // Dark by default — flip after legal/ops sign off on ToS + DPA links.
    signup: process.env.SIGNUP_ENABLED === 'true',
  },
};
