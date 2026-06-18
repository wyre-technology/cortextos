/**
 * Shared harness for SCIM integration tests.
 *
 * Boots a throwaway Postgres 15 container via testcontainers, applies every
 * migration in `migrations/*.sql`, and hands back a postgres.js client.
 *
 * The auth0 plugin's user-table bootstrap (src/auth/auth0.ts:82) creates the
 * users table at request time; we apply that here too so SCIM's column ALTERs
 * land on a populated schema.
 *
 * Container start-up runs once per test file (`beforeAll` in the test) — not
 * per test — so the cost amortizes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

export interface IntegrationDb {
  sql: postgres.Sql;
  container: StartedPostgreSqlContainer;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Apply the bootstrap tables that the application normally creates at startup
 * (auth0 plugin, org-service, team-service, etc.). The migrations rely on
 * these tables existing before they ALTER them.
 */
async function applyBootstrap(sql: postgres.Sql): Promise<void> {
  // Mirrors src/auth/auth0.ts:82 plus first_name/last_name/display_name ALTERs.
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_name  TEXT,
      last_name   TEXT,
      display_name TEXT
    )
  `;

  // Mirrors src/org/org-service.ts initTables (organizations + org_members + org_invitations).
  // Keep this in lockstep with OrgService.initTables — drift here is a silent
  // landmine: migration 017's seat-billing backfill (UPDATE … WHERE
  // stripe_subscription_id IS NOT NULL) failed cryptically when this mirror
  // omitted stripe_subscription_id.
  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      slug                   TEXT UNIQUE,
      owner_id               TEXT REFERENCES users(id),
      plan                   TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      created_by             TEXT REFERENCES users(id),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS org_members (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      joined_at  TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, user_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS org_invitations (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_by TEXT,
      accepted_at TIMESTAMPTZ,
      max_uses   INT,
      use_count  INT NOT NULL DEFAULT 0,
      intended_role TEXT,
      team_id    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Mirrors src/org/team-service.ts initTables.
  await sql`
    CREATE TABLE IF NOT EXISTS org_teams (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, name)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS org_team_members (
      id       TEXT PRIMARY KEY,
      team_id  TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
      org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by TEXT NOT NULL REFERENCES users(id),
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(team_id, user_id)
    )
  `;
  // Reseller members table — mirrors migration 003.
  await sql`
    CREATE TABLE IF NOT EXISTS reseller_members (
      id              TEXT PRIMARY KEY,
      reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      invited_by      TEXT REFERENCES users(id),
      joined_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(reseller_org_id, user_id)
    )
  `;
  // Mirrors migration 054 — per-org discount primitive (EAP slice (b),
  // annual-prepay slice (c)). The mig adds CHECK constraints + an RLS
  // SELECT policy; this bootstrap only needs the table shape so the
  // schema-harness-drift gate (the one that caught mig 052) sees mig 054
  // as structurally in sync. SCIM tests don't exercise discounts, so
  // CHECK constraints + RLS are intentionally omitted here.
  await sql`
    CREATE TABLE IF NOT EXISTS org_discounts (
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      reason      TEXT NOT NULL,
      applies_to  TEXT NOT NULL,
      percent     INTEGER NOT NULL,
      granted_by  TEXT NOT NULL REFERENCES users(id),
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, reason)
    )
  `;
}

/**
 * Migrations the SCIM integration harness deliberately skips on first
 * "does not exist" error. Each entry names the file AND a short reason
 * the harness is allowed to skip it; the reason is part of the
 * skip-event log line so future-Hank reading test output sees WHY a
 * skip is permitted, not just THAT it happened.
 *
 * To allow a new skip: add an entry here. Any skip-event without a
 * matching entry is a hard failure — the harness has drifted from the
 * test's bootstrap and needs either the bootstrap updated or the
 * allowlist explicitly extended.
 */
const ALLOWED_SKIPS: ReadonlyArray<{ file: string; reason: string }> = [
  // The list is empirically derived: each entry is a migration that
  // ACTUALLY trips the skip path on the current SCIM bootstrap. New
  // migrations that error here without a matching entry fail the
  // harness loudly. Updating this list is a deliberate choice, not a
  // drive-by silencing.
  { file: '006_audit_actor_org_id.sql',           reason: 'admin_audit_log not in SCIM bootstrap' },
  { file: '007_rls_enable.sql',                   reason: 'RLS not relevant to SCIM business-logic tests' },
  { file: '014_rls_with_check_clauses.sql',       reason: 'RLS not relevant to SCIM business-logic tests' },
  { file: '018_rls_security_definer_helpers.sql', reason: 'RLS not relevant to SCIM business-logic tests' },
  { file: '020_rls_helper_context_fix_and_update_using.sql', reason: 'RLS helper-context fix + UPDATE-policy USING repair; SCIM tests do not exercise RLS policies' },
  { file: '022_bug_b_update_using_sweep.sql', reason: 'Bug B sweep — adds USING to 9 remaining UPDATE policies; SCIM tests do not exercise RLS policies' },
  { file: '025_reseller_pricing_config.sql', reason: 'reseller-channel-billing foundation; RLS policy references conduit_is_member_of_org from mig 018 which SCIM already skips. SCIM tests do not exercise reseller-channel RLS.' },
  { file: '026_reseller_pricing_config_dp_e_and_created_by_strip.sql', reason: 'mig 025 follow-up: DP-E current-only + created_by column-strip; operates on reseller_pricing_config which SCIM skips. SCIM tests do not exercise reseller-channel RLS.' },
  { file: '027_reseller_invoices.sql', reason: 'Track C PR-B foundation: reseller_invoices + line_items; RLS depends on mig 018 helpers SCIM already skips. SCIM tests do not exercise reseller-channel RLS.' },
  { file: '030_widen_request_log_reseller_read.sql', reason: 'Track C S2 reconcile: DROP/CREATE request_log_select to widen the reseller read to any reseller role; request_log is not in the SCIM bootstrap — same class as 007/014/018/020/022. SCIM tests do not exercise RLS policies.' },
  { file: '031_organization_domains.sql', reason: 'GAP-1 domain-claim port: organization_domains RLS policies reference conduit_is_member_of_org from mig 018 which SCIM already skips. SCIM tests do not exercise domain-claim or its RLS.' },
  { file: '033_onprem_tunnels_select_policy.sql', reason: 'On-prem stream PR #2: onprem_tunnels_select policy references conduit_is_member_of_org + conduit_is_reseller_member_of_parent from migs 018+030 which SCIM already skips. SCIM tests do not exercise on-prem-tunnel RLS. Same class as 030/031.' },
  { file: '035_vendor_registry.sql', reason: 'Vendor-registry Phase 1: vendor_enablement RLS policy references conduit_is_member_of_org from mig 018 which SCIM already skips. SCIM tests do not exercise the vendor registry or its RLS. Same class as 025/027/031/033.' },
  { file: '036_org_memory_schema.sql', reason: 'Phase-3 org-memory schema floor; orgmem_entities/edges/facts RLS uses (app.org_id, app.subtenant_id) GUC pattern + pgvector. SCIM tests do not exercise org-memory.' },
  { file: '037_flat_pricing.sql', reason: 'Flat-pricing data side: collapses organizations.plan to conduit (organizations IS bootstrapped) + DROP TABLE IF EXISTS credit_blocks. credit_blocks is the customer credit-overage table — not in the SCIM bootstrap (SCIM tests exercise neither customer credits nor billing). The plan-collapse UPDATE is harmless on the SCIM org rows; the DROP is what trips the skip path. credit_ledger is KEPT and untouched.' },
  { file: '038_request_log_retention.sql', reason: 'Compliance D2 retention sweep: CREATE INDEX + SECURITY DEFINER function + pg_cron schedule on request_log; request_log is not in the SCIM bootstrap — same class as 007/014/018/020/022/030/033. SCIM tests do not exercise MCP request-log retention or its pg_cron schedule.' },
  { file: '039_drip_emails_sent.sql', reason: 'Drip-scheduler idempotency tracker (WYREAI-94, E3 sub-issue 76.2): drip_emails_sent FKs users(id), which IS in the SCIM bootstrap, BUT the scheduler is a system-context background process (runAsSystem-wrapped per the cleanupExpired pattern) — SCIM integration tests do not exercise the drip-scheduler. The FK to users.id resolves cleanly under the SCIM bootstrap; the migration skip path here is conservative: drip-scheduler outbound-email orchestration is orthogonal to SCIM identity-provisioning business logic.' },
  { file: '040_ai_msa_consent.sql', reason: 'WYREAI-98 AI MSA accept-at-signup: org_consents + user_consent_acknowledgments tables + ALTER TABLE signup_intents (consent_* columns). signup_intents is NOT in the SCIM bootstrap (it is a Funnel-A reseller-signup primitive, plugin-init created at signup-routes registration time, not a SCIM-provisioned table), so the ALTER trips the skip path. org_consents + user_consent_acknowledgments FK to organizations + users (both ARE in bootstrap) but SCIM tests do not exercise the consent surface. Same class as 039 (FK-resolvable but orthogonal to SCIM identity-provisioning business logic).' },
  { file: '050_org_tool_allowlist_admin_write.sql', reason: 'WYREAI-66: DROP/CREATE POLICY on org_tool_allowlist (admin-write gate via conduit_is_org_admin SECURITY DEFINER helper). org_tool_allowlist is not in the SCIM bootstrap — same class as 014/022/030. SCIM tests do not exercise RLS policies.' },
  { file: '051_org_tool_allowlist_delete_policy.sql', reason: 'WYREAI-67: CREATE POLICY org_tool_allowlist_delete on org_tool_allowlist (was missing — no RLS DELETE coverage). org_tool_allowlist is not in the SCIM bootstrap — same class as 014/022/030/050. SCIM tests do not exercise RLS policies.' },
  { file: '052_widen_reseller_member_clause_all_customer_tables.sql', reason: 'LAYER-B subtenant-RLS fix (boss msg-1781725590563): widens reseller-clause from admin-only to member-of-parent across 7 customer-facing tables (organizations + org_members + org_credentials + org_invitations + org_tool_allowlist + org_server_access + admin_audit_log), mirroring mig 030 pattern for the broader read+write substrate. org_credentials + org_tool_allowlist + org_server_access + admin_audit_log are NOT in the SCIM bootstrap (same class as 014/022/030/050/051 — they are the subtenant read/write substrate for the reseller-on-customer customer-detail flow, NOT SCIM-provisioned tables). SCIM tests do not exercise the customer-detail reseller-flow nor the RLS-widening for it; mig 052 is orthogonal to SCIM identity-provisioning business logic.' },
  { file: '054_org_discounts.sql', reason: 'WYREAI-25 (b) EAP slice: org_discounts CREATE POLICY for SELECT references conduit_is_member_of_org + conduit_is_reseller_admin_of_parent + conduit_is_reseller_member_of_parent + conduit_is_reseller_member_of from mig 018 (which SCIM already skips). Same class as 025/027/030/031/033/035/050/051/052. The table itself IS in the bootstrap (applyBootstrap above) so any test that referenced org_discounts would work; SCIM tests do not exercise the EAP/discount surface or its reseller-clause RLS — discount math is orthogonal to SCIM identity-provisioning business logic.' },
  { file: '055_byo_mcp_servers.sql', reason: 'WYREAI-188 (BYOMCP): CREATE TABLE byo_mcp_servers + FORCE RLS + owner-only policies scoped to conduit.current_user_id. byo_mcp_servers is a new user-scoped table not in the SCIM bootstrap (same class as 050/051) — SCIM tests do not exercise BYO MCP storage or its RLS.' },
  { file: '056_byo_oauth_states.sql', reason: 'WYREAI-187 (BYOMCP): CREATE TABLE byo_oauth_states + FORCE RLS + owner-only policies scoped to conduit.current_user_id. The in-flight BYO OAuth PKCE flow state — a new user-scoped table not in the SCIM bootstrap (same class as 055) — SCIM tests do not exercise BYO OAuth.' },
  { file: '057_byo_tool_tier_overrides.sql', reason: 'WYREAI-191 (BYOMCP): CREATE TABLE byo_tool_tier_overrides + FORCE RLS + owner-only policies scoped to conduit.current_user_id. Per-tool manual permission-tier pins — a new user-scoped table not in the SCIM bootstrap (same class as 055/056) — SCIM tests do not exercise BYO tool tiering.' },
];

const SKIP_LOG_PREFIX = 'HARNESS_SKIP';

async function applyMigrations(sql: postgres.Sql): Promise<void> {
  const dir = join(REPO_ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    // Strip the migration's own BEGIN/COMMIT — postgres.js refuses
    // multi-statement scripts unless max:1, and our pool is max:4. We
    // wrap in our own sql.begin() to get one logical transaction.
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    try {
      await sql.begin((tx) => tx.unsafe(body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only "does not exist" errors are candidates for the skip
      // allowlist. Other errors (syntax, FK violation, etc) always
      // propagate — the migration content is broken and the harness
      // wouldn't be papering over it usefully by skipping.
      if (msg.includes('does not exist')) {
        const allowed = ALLOWED_SKIPS.find((s) => s.file === file);
        if (allowed) {
          // Visible skip event. Per-skip log line so the test output
          // shows the operator exactly which migrations the SCIM
          // integration suite is structurally bypassing today.
          // eslint-disable-next-line no-console
          console.warn(`${SKIP_LOG_PREFIX} file=${file} reason="${allowed.reason}"`);
          continue;
        }
        // Unallowed skip = the harness has drifted from the bootstrap.
        // Fail loudly with the actionable choice surfaced in the
        // error message rather than silently bypass.
        throw new Error(
          `Migration ${file} failed with "does not exist" but is not in ALLOWED_SKIPS. ` +
            'Either add the missing tables/columns to the harness bootstrap (preferred — ' +
            'see harness-drift.test.ts) or, if the migration is genuinely irrelevant to ' +
            'SCIM business-logic tests, add { file: \'' + file + '\', reason: <why> } to ' +
            'ALLOWED_SKIPS in this file. Underlying error: ' + msg,
        );
      }
      throw new Error(`Migration ${file} failed: ${msg}`);
    }
  }
}

export async function startIntegrationDb(): Promise<IntegrationDb> {
  // Use pgvector/pgvector:pg15 — a drop-in superset of postgres:15-alpine
  // that ships with the `vector` extension binaries. Required by migration
  // 036_org_memory_schema.sql's `CREATE EXTENSION IF NOT EXISTS vector` and
  // the `vector(1536)` column types on orgmem_entities / orgmem_facts.
  // (Plain postgres:15-alpine works for every other migration but cannot
  // satisfy the vector extension dependency, which is otherwise installed
  // on Azure FS PG via the `azure.extensions` allowlist.)
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg15').start();
  const connStr = container.getConnectionUri();
  const sql = postgres(connStr, { max: 4, onnotice: () => {} });

  await applyBootstrap(sql);
  await applyMigrations(sql);

  return {
    sql,
    container,
    async reset() {
      // Truncate all SCIM-relevant tables in dependency order.
      await sql`
        TRUNCATE TABLE
          scim_connections,
          org_team_members,
          org_teams,
          org_members,
          reseller_members,
          org_invitations,
          organizations,
          users
        RESTART IDENTITY CASCADE
      `;
    },
    async stop() {
      await sql.end({ timeout: 5 });
      await container.stop();
    },
  };
}

/**
 * Insert a SCIM connection row matching the synthetic ScimConnection used
 * in tests. Required because org_teams.scim_connection_id has a FK to
 * scim_connections(id).
 */
export async function seedConnection(
  sql: postgres.Sql,
  opts: { id: string; orgId: string; scope: 'tenant' | 'reseller'; createdBy: string; defaultRole?: string },
): Promise<void> {
  await sql`
    INSERT INTO scim_connections
      (id, org_id, scope, idp_type, token_hash, default_role, status, created_by)
    VALUES
      (${opts.id}, ${opts.orgId}, ${opts.scope}, 'entra',
       ${'test-hash-' + opts.id}, ${opts.defaultRole ?? 'member'}, 'active',
       ${opts.createdBy})
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Convenience: insert a user + organization + put the user as owner.
 * Used by tests to set up the actor that creates SCIM connections.
 */
export async function seedOwner(
  sql: postgres.Sql,
  opts: { orgId: string; orgType?: 'reseller' | 'customer' | 'standalone'; userId?: string; email?: string },
): Promise<{ orgId: string; userId: string }> {
  const userId = opts.userId ?? `auth0|owner-${opts.orgId}`;
  const email = opts.email ?? `owner-${opts.orgId}@example.com`;
  await sql`
    INSERT INTO users (id, email, name) VALUES (${userId}, ${email}, 'Owner')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organizations (id, name, type, parent_org_id)
    VALUES (${opts.orgId}, ${'Org ' + opts.orgId}, ${opts.orgType ?? 'standalone'}, NULL)
    ON CONFLICT (id) DO NOTHING
  `;
  if (opts.orgType === 'reseller') {
    await sql`
      INSERT INTO reseller_members (id, reseller_org_id, user_id, role, joined_at)
      VALUES (${`rm_${opts.orgId}`}, ${opts.orgId}, ${userId}, 'reseller_owner', NOW())
      ON CONFLICT (reseller_org_id, user_id) DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO org_members (id, org_id, user_id, role, joined_at)
      VALUES (${`m_${opts.orgId}`}, ${opts.orgId}, ${userId}, 'owner', NOW())
      ON CONFLICT (org_id, user_id) DO NOTHING
    `;
  }
  return { orgId: opts.orgId, userId };
}
