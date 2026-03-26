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

  // Auth0 OIDC configuration
  auth0Domain: process.env.AUTH0_DOMAIN ?? '',       // e.g. "wyre.us.auth0.com"
  auth0ClientId: process.env.AUTH0_CLIENT_ID ?? '',
  auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET ?? '',
  auth0CallbackUrl: process.env.AUTH0_CALLBACK_URL ?? '',  // e.g. "https://gateway.example.com/auth/callback"

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

  // Admin API key — protects internal admin endpoints (e.g. waitlist export)
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  // Webhook URL for waitlist signup notifications (Discord or Slack)
  waitlistNotifyUrl: process.env.WAITLIST_NOTIFY_URL ?? '',

  // Feature flags — derived from config or explicit env vars
  features: {
    waitlist: !!process.env.WAITLIST_NOTIFY_URL,
    billing: !!process.env.STRIPE_SECRET_KEY,
    dashboard: process.env.FEATURE_DASHBOARD !== 'false',   // on by default
    promptCapture: process.env.FEATURE_PROMPT_CAPTURE !== 'false', // on by default
  },
};
