/**
 * Phase 4 — mcp-gateway → Conduit data migration.
 *
 * Reads from mcp-gateway (DATABASE_URL_SRC, SELECT-only) and writes into
 * Conduit (DATABASE_URL_DST). Idempotent (ON CONFLICT DO NOTHING). Each table
 * runs inside its own dst.begin(...) so a partial failure leaves a clean
 * boundary. Slug rename `connectwise-manage` → `connectwise-psa` is applied
 * to credential rows on the way in. After credential migration a decrypt
 * canary is run per migrated org using src/credentials/crypto.ts to confirm
 * the destination MASTER_KEY can read what we just moved.
 *
 * Usage:
 *   MASTER_KEY=... DATABASE_URL_SRC=... DATABASE_URL_DST=... \
 *     npm run migrate:from-mcp-gateway -- [--dry-run]
 */
import postgres from 'postgres';
import { decrypt } from '../src/credentials/crypto.js';

type Sql = ReturnType<typeof postgres>;
type TableResult = { read: number; inserted: number; skipped: number };

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function preflight(): { masterKey: Buffer; srcUrl: string; dstUrl: string } {
  const masterKeyHex = process.env.MASTER_KEY;
  if (!masterKeyHex) {
    console.error(
      '[migrate] MASTER_KEY missing. Set MASTER_KEY to the source deployment\'s ' +
        'value or every credential row will be unreadable after migration.',
    );
    process.exit(1);
  }
  const srcUrl = process.env.DATABASE_URL_SRC;
  const dstUrl = process.env.DATABASE_URL_DST;
  if (!srcUrl || !dstUrl) {
    console.error('[migrate] DATABASE_URL_SRC and DATABASE_URL_DST must both be set.');
    process.exit(1);
  }
  // The source MASTER_KEY in mcp-gateway is hex-encoded; decrypt() expects
  // a Buffer. Accept either hex or raw passthrough (length 32+ bytes).
  let masterKey: Buffer;
  try {
    masterKey = /^[0-9a-fA-F]+$/.test(masterKeyHex) && masterKeyHex.length % 2 === 0
      ? Buffer.from(masterKeyHex, 'hex')
      : Buffer.from(masterKeyHex, 'utf8');
  } catch {
    console.error('[migrate] MASTER_KEY could not be decoded as hex or utf8.');
    process.exit(1);
  }
  return { masterKey, srcUrl, dstUrl };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logTable(name: string, r: TableResult): void {
  console.log(
    `[migrate] ${name}: read=${r.read} inserted=${r.inserted} skipped=${r.skipped}`,
  );
}

function logDryCount(name: string, read: number): void {
  console.log(`[migrate] ${name}: read=${read}`);
}

function renameSlug(slug: string): string {
  return slug === 'connectwise-manage' ? 'connectwise-psa' : slug;
}

/** Best-effort SELECT — if the source table/column is missing, warn and return []. */
async function safeSelect<T>(
  src: Sql,
  label: string,
  fn: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[migrate] ${label}: source query failed (${msg}); skipping.`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-table migrations
//
// Each function runs its own dst.begin(...) so a partial failure leaves a
// clean transactional boundary. SELECTs against `src` happen outside that
// transaction — they're read-only.
// ---------------------------------------------------------------------------

async function migrateUsers(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<
    { id: string; email: string; name: string | null; created_at: Date; last_login: Date | null }[]
  >`SELECT id, email, name, created_at, last_login FROM users`;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO users (id, email, name, created_at, last_login, active)
        VALUES (${r.id}, ${r.email}, ${r.name ?? ''}, ${r.created_at}, ${r.last_login}, true)
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrganizations(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'organizations', () => src<any[]>`
    SELECT id, name, owner_id, plan, stripe_customer_id, stripe_subscription_id,
           trial_ends_at, seat_billing_grandfathered_until, created_at, updated_at
      FROM organizations
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO organizations (
          id, name, owner_id, plan,
          stripe_customer_id, stripe_subscription_id,
          trial_ends_at, seat_billing_grandfathered_until,
          type, parent_org_id, default_server_access,
          created_at, updated_at
        ) VALUES (
          ${r.id}, ${r.name}, ${r.owner_id}, ${r.plan ?? 'free'},
          ${r.stripe_customer_id ?? null}, ${r.stripe_subscription_id ?? null},
          ${r.trial_ends_at ?? null}, ${r.seat_billing_grandfathered_until ?? null},
          'standalone', NULL, 'all',
          ${r.created_at}, ${r.updated_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgMembers(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, user_id, role, joined_at, created_at FROM org_members
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_members (id, org_id, user_id, role, joined_at, created_at)
        VALUES (${r.id}, ${r.org_id}, ${r.user_id}, ${r.role}, ${r.joined_at}, ${r.created_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgInvitations(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, invited_by, token, token_hash, token_hash_algo,
           expires_at, accepted_by, accepted_at, max_uses, use_count, created_at
      FROM org_invitations
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_invitations (
          id, org_id, invited_by, token, token_hash, token_hash_algo,
          expires_at, accepted_by, accepted_at, max_uses, use_count, created_at
        ) VALUES (
          ${r.id}, ${r.org_id}, ${r.invited_by}, ${r.token},
          ${r.token_hash ?? null}, ${r.token_hash_algo ?? 'sha256'},
          ${r.expires_at}, ${r.accepted_by ?? null}, ${r.accepted_at ?? null},
          ${r.max_uses ?? 1}, ${r.use_count ?? 0}, ${r.created_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateCredentials(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, user_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
           created_at, updated_at
      FROM credentials
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO credentials (
          id, user_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
          created_at, updated_at
        ) VALUES (
          ${r.id}, ${r.user_id}, ${renameSlug(r.vendor_slug)},
          ${r.encrypted_data}, ${r.iv}, ${r.auth_tag}, ${r.salt},
          ${r.created_at}, ${r.updated_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgCredentials(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
           created_by, created_at, updated_at
      FROM org_credentials
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_credentials (
          id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
          created_by, created_at, updated_at
        ) VALUES (
          ${r.id}, ${r.org_id}, ${renameSlug(r.vendor_slug)},
          ${r.encrypted_data}, ${r.iv}, ${r.auth_tag}, ${r.salt},
          ${r.created_by}, ${r.created_at}, ${r.updated_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgTeamCredentials(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, team_id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
           created_by, created_at, updated_at
      FROM org_team_credentials
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_team_credentials (
          id, team_id, org_id, vendor_slug,
          encrypted_data, iv, auth_tag, salt,
          created_by, created_at, updated_at
        ) VALUES (
          ${r.id}, ${r.team_id}, ${r.org_id}, ${renameSlug(r.vendor_slug)},
          ${r.encrypted_data}, ${r.iv}, ${r.auth_tag}, ${r.salt},
          ${r.created_by}, ${r.created_at}, ${r.updated_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateServiceClients(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, name, client_id, client_secret_hash, created_by,
           last_used_at, expires_at, created_at, allowed_vendors
      FROM service_clients
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO service_clients (
          id, org_id, name, client_id, client_secret_hash, created_by,
          last_used_at, expires_at, created_at, allowed_vendors
        ) VALUES (
          ${r.id}, ${r.org_id}, ${r.name}, ${r.client_id}, ${r.client_secret_hash},
          ${r.created_by}, ${r.last_used_at ?? null}, ${r.expires_at ?? null},
          ${r.created_at}, ${r.allowed_vendors ?? null}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateServiceClientCredentials(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, client_id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt,
           created_by, created_at, updated_at
      FROM service_client_credentials
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO service_client_credentials (
          id, client_id, org_id, vendor_slug,
          encrypted_data, iv, auth_tag, salt,
          created_by, created_at, updated_at
        ) VALUES (
          ${r.id}, ${r.client_id}, ${r.org_id}, ${renameSlug(r.vendor_slug)},
          ${r.encrypted_data}, ${r.iv}, ${r.auth_tag}, ${r.salt},
          ${r.created_by}, ${r.created_at}, ${r.updated_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgTeams(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, name, created_by, created_at FROM org_teams
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_teams (id, org_id, name, created_by, created_at)
        VALUES (${r.id}, ${r.org_id}, ${r.name}, ${r.created_by}, ${r.created_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgTeamMembers(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, team_id, org_id, user_id, added_by, added_at FROM org_team_members
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_team_members (id, team_id, org_id, user_id, added_by, added_at)
        VALUES (${r.id}, ${r.team_id}, ${r.org_id}, ${r.user_id}, ${r.added_by}, ${r.added_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgTeamServerAccess(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, team_id, vendor_slug, granted_by, granted_at
      FROM org_team_server_access
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_team_server_access (id, org_id, team_id, vendor_slug, granted_by, granted_at)
        VALUES (${r.id}, ${r.org_id}, ${r.team_id}, ${renameSlug(r.vendor_slug)},
                ${r.granted_by}, ${r.granted_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgToolAllowlist(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, vendor_slug, role, tool_name, granted_by, created_at
      FROM org_tool_allowlist
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, role, tool_name, granted_by, created_at)
        VALUES (${r.id}, ${r.org_id}, ${renameSlug(r.vendor_slug)}, ${r.role},
                ${r.tool_name}, ${r.granted_by}, ${r.created_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgServerAccess(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT id, org_id, user_id, vendor_slug, granted_by, granted_at
      FROM org_server_access
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_server_access (id, org_id, user_id, vendor_slug, granted_by, granted_at)
        VALUES (${r.id}, ${r.org_id}, ${r.user_id}, ${renameSlug(r.vendor_slug)},
                ${r.granted_by}, ${r.granted_at})
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOrgFeatureOverrides(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'org_feature_overrides', () => src<any[]>`
    SELECT org_id, feature_key, enabled, created_at, updated_at
      FROM org_feature_overrides
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO org_feature_overrides (org_id, feature_key, enabled, created_at, updated_at)
        VALUES (${r.org_id}, ${r.feature_key}, ${r.enabled},
                ${r.created_at ?? new Date()}, ${r.updated_at ?? new Date()})
        ON CONFLICT (org_id, feature_key) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateWaitlist(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'waitlist', () => src<any[]>`SELECT * FROM waitlist`);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      // Pull common columns; let unknown columns fall through as NULL via defaults.
      const res = await tx`
        INSERT INTO waitlist ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateWaitlistInvitations(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'waitlist_invitations', () => src<any[]>`
    SELECT * FROM waitlist_invitations
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO waitlist_invitations ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateClients(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT client_id, client_name, redirect_uris, created_at FROM clients
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO clients (client_id, client_name, redirect_uris, created_at)
        VALUES (${r.client_id}, ${r.client_name}, ${r.redirect_uris}, ${r.created_at})
        ON CONFLICT (client_id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateRefreshTokens(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await src<any[]>`
    SELECT token, client_id, user_id, scope, expires_at
      FROM refresh_tokens
     WHERE expires_at > NOW()
  `;
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO refresh_tokens (token, client_id, user_id, scope, expires_at)
        VALUES (${r.token}, ${r.client_id}, ${r.user_id}, ${r.scope}, ${r.expires_at})
        ON CONFLICT (token) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateOauthSessions(src: Sql, dst: Sql): Promise<TableResult> {
  // Sessions don't have an explicit expires_at column, but they're short-lived
  // anyway. We filter to those created within the last 24h as a proxy.
  const rows = await safeSelect(src, 'oauth_sessions', () => src<any[]>`
    SELECT session_id, client_id, redirect_uri, state, code_challenge,
           code_challenge_method, scope, vendor, created_at
      FROM oauth_sessions
     WHERE created_at > NOW() - INTERVAL '24 hours'
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO oauth_sessions (
          session_id, client_id, redirect_uri, state,
          code_challenge, code_challenge_method, scope, vendor, created_at
        ) VALUES (
          ${r.session_id}, ${r.client_id}, ${r.redirect_uri}, ${r.state},
          ${r.code_challenge}, ${r.code_challenge_method}, ${r.scope},
          ${r.vendor ?? ''}, ${r.created_at}
        )
        ON CONFLICT (session_id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateRequestLog(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'request_log', () => src<any[]>`
    SELECT id, user_id, org_id, vendor_slug, tool_name, status_code,
           response_time_ms, created_at, tool_arguments, prompt_context, source
      FROM request_log
     WHERE created_at >= NOW() - INTERVAL '90 days'
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO request_log (
          id, user_id, org_id, vendor_slug, tool_name, status_code,
          response_time_ms, created_at, tool_arguments, prompt_context, source
        ) VALUES (
          ${r.id}, ${r.user_id}, ${r.org_id ?? null},
          ${renameSlug(r.vendor_slug)}, ${r.tool_name ?? null},
          ${r.status_code}, ${r.response_time_ms ?? null}, ${r.created_at},
          ${r.tool_arguments ?? null}, ${r.prompt_context ?? null},
          ${r.source ?? 'mcp'}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateLogShippingDestinations(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'log_shipping_destinations', () => src<any[]>`
    SELECT * FROM log_shipping_destinations
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO log_shipping_destinations ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateSubscriptions(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'subscriptions', () => src<any[]>`SELECT * FROM subscriptions`);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO subscriptions ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateDeletedOrgs(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'deleted_orgs', () => src<any[]>`SELECT * FROM deleted_orgs`);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO deleted_orgs ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateEntityMappings(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'entity_mappings', () => src<any[]>`
    SELECT * FROM entity_mappings
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO entity_mappings ${tx(r)}
        ON CONFLICT (id) DO NOTHING
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateCreditLedger(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'credit_ledger', () => src<any[]>`
    SELECT org_id, user_id, vendor_slug, credits_used, recorded_at
      FROM credit_ledger
     WHERE recorded_at >= NOW() - INTERVAL '90 days'
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      // No stable PK to conflict on (id is BIGSERIAL on dst); destination is
      // expected empty at migration time so a plain INSERT is fine.
      const res = await tx`
        INSERT INTO credit_ledger (org_id, user_id, vendor_slug, credits_used, recorded_at)
        VALUES (${r.org_id}, ${r.user_id}, ${renameSlug(r.vendor_slug)},
                ${r.credits_used ?? 1}, ${r.recorded_at})
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

async function migrateCreditBlocks(src: Sql, dst: Sql): Promise<TableResult> {
  const rows = await safeSelect(src, 'credit_blocks', () => src<any[]>`
    SELECT org_id, credits, remaining, purchased_at, stripe_payment_intent_id,
           granted_by, reason
      FROM credit_blocks
  `);
  if (DRY_RUN) return { read: rows.length, inserted: 0, skipped: 0 };
  if (rows.length === 0) return { read: 0, inserted: 0, skipped: 0 };
  let inserted = 0;
  await dst.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        INSERT INTO credit_blocks (
          org_id, credits, remaining, purchased_at,
          stripe_payment_intent_id, granted_by, reason
        ) VALUES (
          ${r.org_id}, ${r.credits}, ${r.remaining}, ${r.purchased_at},
          ${r.stripe_payment_intent_id ?? null},
          ${r.granted_by ?? null}, ${r.reason ?? null}
        )
      `;
      inserted += res.count;
    }
  });
  return { read: rows.length, inserted, skipped: rows.length - inserted };
}

// ---------------------------------------------------------------------------
// Decrypt canary
//
// For every org that ended up with at least one migrated credential row, pull
// a single representative row and confirm decrypt() can read it with the
// destination MASTER_KEY scoped to (org_id | team_id | client_id | user_id).
// We attempt org_credentials first, fall back to team / service-client /
// personal credentials so an org that only has team-scoped creds is still
// covered.
// ---------------------------------------------------------------------------

async function runDecryptCanary(
  dst: Sql,
  masterKey: Buffer,
): Promise<{ ok: number; total: number; failures: string[] }> {
  // Distinct orgs touched by any credential migration.
  const orgs = await dst<{ org_id: string }[]>`
    SELECT DISTINCT org_id FROM org_credentials
    UNION SELECT DISTINCT org_id FROM org_team_credentials
    UNION SELECT DISTINCT org_id FROM service_client_credentials
  `;

  const failures: string[] = [];
  let ok = 0;

  for (const { org_id } of orgs) {
    const sample = await pickCanaryRow(dst, org_id);
    if (!sample) continue; // org has no credentials we can canary
    try {
      decrypt(masterKey, sample.scopeId, {
        ciphertext: sample.encrypted_data,
        iv: sample.iv,
        authTag: sample.auth_tag,
        salt: sample.salt,
      });
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`org=${org_id} table=${sample.table} id=${sample.id}: ${msg}`);
    }
  }
  return { ok, total: orgs.length, failures };
}

interface CanaryRow {
  table: string;
  id: string;
  scopeId: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
}

async function pickCanaryRow(dst: Sql, orgId: string): Promise<CanaryRow | null> {
  const orgCred = await dst<any[]>`
    SELECT id, org_id, encrypted_data, iv, auth_tag, salt
      FROM org_credentials
     WHERE org_id = ${orgId}
     LIMIT 1
  `;
  if (orgCred.length > 0) {
    const r = orgCred[0];
    return { table: 'org_credentials', id: r.id, scopeId: r.org_id,
      encrypted_data: r.encrypted_data, iv: r.iv, auth_tag: r.auth_tag, salt: r.salt };
  }

  const teamCred = await dst<any[]>`
    SELECT id, team_id, encrypted_data, iv, auth_tag, salt
      FROM org_team_credentials
     WHERE org_id = ${orgId}
     LIMIT 1
  `;
  if (teamCred.length > 0) {
    const r = teamCred[0];
    return { table: 'org_team_credentials', id: r.id, scopeId: r.team_id,
      encrypted_data: r.encrypted_data, iv: r.iv, auth_tag: r.auth_tag, salt: r.salt };
  }

  const svcCred = await dst<any[]>`
    SELECT id, client_id, encrypted_data, iv, auth_tag, salt
      FROM service_client_credentials
     WHERE org_id = ${orgId}
     LIMIT 1
  `;
  if (svcCred.length > 0) {
    const r = svcCred[0];
    return { table: 'service_client_credentials', id: r.id, scopeId: r.client_id,
      encrypted_data: r.encrypted_data, iv: r.iv, auth_tag: r.auth_tag, salt: r.salt };
  }

  // Personal creds aren't org-scoped; pick one for any user that's a member of
  // this org as a best-effort fallback.
  const personal = await dst<any[]>`
    SELECT c.id, c.user_id, c.encrypted_data, c.iv, c.auth_tag, c.salt
      FROM credentials c
      JOIN org_members m ON m.user_id = c.user_id
     WHERE m.org_id = ${orgId}
     LIMIT 1
  `;
  if (personal.length > 0) {
    const r = personal[0];
    return { table: 'credentials', id: r.id, scopeId: r.user_id,
      encrypted_data: r.encrypted_data, iv: r.iv, auth_tag: r.auth_tag, salt: r.salt };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dry-run FK spot check
// ---------------------------------------------------------------------------

async function dryRunFkSpotCheck(src: Sql): Promise<void> {
  const sample = await src<{ id: string; org_id: string; user_id: string }[]>`
    SELECT id, org_id, user_id FROM org_members LIMIT 5
  `;
  for (const row of sample) {
    const u = await src<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM users WHERE id = ${row.user_id}) AS exists
    `;
    const o = await src<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM organizations WHERE id = ${row.org_id}) AS exists
    `;
    console.log(
      `[migrate] fk-check org_member=${row.id} user_exists=${u[0].exists} org_exists=${o[0].exists}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { masterKey, srcUrl, dstUrl } = preflight();

  const src = postgres(srcUrl, { max: 4, idle_timeout: 10 });
  const dst = postgres(dstUrl, { max: 4, idle_timeout: 10 });

  if (DRY_RUN) console.log('[migrate] DRY RUN — no writes will occur');
  else console.log('[migrate] EXECUTING migration to DST');

  // Each entry is { name, fn }. The body is intentionally a flat list.
  const tables: { name: string; fn: () => Promise<TableResult> }[] = [
    { name: 'users',                       fn: () => migrateUsers(src, dst) },
    { name: 'organizations',               fn: () => migrateOrganizations(src, dst) },
    { name: 'org_members',                 fn: () => migrateOrgMembers(src, dst) },
    { name: 'org_invitations',             fn: () => migrateOrgInvitations(src, dst) },
    { name: 'credentials',                 fn: () => migrateCredentials(src, dst) },
    { name: 'org_credentials',             fn: () => migrateOrgCredentials(src, dst) },
    { name: 'org_teams',                   fn: () => migrateOrgTeams(src, dst) },
    { name: 'org_team_members',            fn: () => migrateOrgTeamMembers(src, dst) },
    { name: 'org_team_credentials',        fn: () => migrateOrgTeamCredentials(src, dst) },
    { name: 'service_clients',             fn: () => migrateServiceClients(src, dst) },
    { name: 'service_client_credentials',  fn: () => migrateServiceClientCredentials(src, dst) },
    { name: 'org_team_server_access',      fn: () => migrateOrgTeamServerAccess(src, dst) },
    { name: 'org_tool_allowlist',          fn: () => migrateOrgToolAllowlist(src, dst) },
    { name: 'org_server_access',           fn: () => migrateOrgServerAccess(src, dst) },
    { name: 'org_feature_overrides',       fn: () => migrateOrgFeatureOverrides(src, dst) },
    { name: 'waitlist',                    fn: () => migrateWaitlist(src, dst) },
    { name: 'waitlist_invitations',        fn: () => migrateWaitlistInvitations(src, dst) },
    { name: 'clients',                     fn: () => migrateClients(src, dst) },
    { name: 'refresh_tokens',              fn: () => migrateRefreshTokens(src, dst) },
    { name: 'oauth_sessions',              fn: () => migrateOauthSessions(src, dst) },
    { name: 'request_log',                 fn: () => migrateRequestLog(src, dst) },
    { name: 'log_shipping_destinations',   fn: () => migrateLogShippingDestinations(src, dst) },
    { name: 'subscriptions',               fn: () => migrateSubscriptions(src, dst) },
    { name: 'deleted_orgs',                fn: () => migrateDeletedOrgs(src, dst) },
    { name: 'entity_mappings',             fn: () => migrateEntityMappings(src, dst) },
    { name: 'credit_ledger',               fn: () => migrateCreditLedger(src, dst) },
    { name: 'credit_blocks',               fn: () => migrateCreditBlocks(src, dst) },
  ];

  let exitCode = 0;
  try {
    for (const t of tables) {
      try {
        const r = await t.fn();
        if (DRY_RUN) logDryCount(t.name, r.read);
        else logTable(t.name, r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[migrate] FAILED at ${t.name}: ${msg}`);
        throw err;
      }
    }

    if (DRY_RUN) {
      await dryRunFkSpotCheck(src);
      console.log('[migrate] DRY RUN complete.');
    } else {
      const canary = await runDecryptCanary(dst, masterKey);
      if (canary.failures.length > 0) {
        console.error(
          `[migrate] decrypt canary FAILED: ${canary.failures.length} of ${canary.total}`,
        );
        for (const f of canary.failures) console.error(`  - ${f}`);
        exitCode = 1;
      } else {
        console.log(
          `[migrate] decrypt canary: ${canary.ok}/${canary.total} orgs OK`,
        );
        console.log('[migrate] DONE.');
      }
    }
  } catch {
    exitCode = 1;
  } finally {
    await src.end({ timeout: 5 });
    await dst.end({ timeout: 5 });
  }

  process.exit(exitCode);
}

void main();
