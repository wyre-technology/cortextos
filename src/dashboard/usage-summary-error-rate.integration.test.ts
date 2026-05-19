/**
 * UsageSummary.errorRate aggregate — regression guard.
 *
 * Track C S2's stat-card frame includes an "Error Rate (7d)" card, but
 * getUsageSummary() shipped without an errorRate aggregate (task_1779210830012).
 * This adds it: errorRate is the fraction of request_log rows whose HTTP
 * status_code is an error (>= 400), over the same org/date window every other
 * UsageSummary aggregate uses.
 *
 * Real Postgres, no mocks — seeds request_log with mixed status codes and
 * asserts the computed rate. Runs on the system path (runAsSystem) — the
 * aggregate logic is what's under test, not RLS (RLS read paths are covered
 * by rls-reseller-dashboard-widen.integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { initPools, runAsSystem, closePools } from '../db/context.js';
import { DashboardService } from './dashboard-service.js';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
const dashboard = new DashboardService();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const uri = container.getConnectionUri();
  admin = postgres(uri, { max: 4, onnotice: () => undefined });

  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
  await admin`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, UNIQUE (org_id, user_id)
    )`;
  await admin`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      vendor_slug TEXT NOT NULL, tool_name TEXT, status_code INTEGER NOT NULL,
      response_time_ms INTEGER, source TEXT DEFAULT 'mcp',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await admin`INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`;
  await admin`INSERT INTO organizations (id, name) VALUES
    ('busy-org', 'Busy Org'), ('quiet-org', 'Quiet Org')`;
  await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m1', 'busy-org', 'u1', 'owner'), ('m2', 'quiet-org', 'u1', 'owner')`;

  // busy-org: 10 rows — 6×200, 1×302, 1×404, 2×500.
  // Errors (status_code >= 400) = 3; the 302 must NOT count. errorRate = 0.3.
  const codes = [200, 200, 200, 200, 200, 200, 302, 404, 500, 500];
  for (let i = 0; i < codes.length; i++) {
    await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
      VALUES (${'rl-' + i}, 'u1', 'busy-org', 'datto-rmm', 'devices.list', ${codes[i]}, 100)`;
  }
  // quiet-org: no request_log rows at all.

  initPools({ systemUrl: uri, requestUrl: uri });
}, 120_000);

afterAll(async () => {
  await closePools();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

describe('UsageSummary.errorRate', () => {
  it('is the fraction of requests with status_code >= 400', async () => {
    const summary = await runAsSystem(() => dashboard.getUsageSummary('busy-org'));
    expect(summary.totalCalls).toBe(10);
    // 3 errors (404 + 500 + 500) of 10 — the 302 is not an error.
    expect(summary.errorRate).toBeCloseTo(0.3, 5);
  });

  it('is 0 for an org with no traffic — no divide-by-zero', async () => {
    const summary = await runAsSystem(() => dashboard.getUsageSummary('quiet-org'));
    expect(summary.totalCalls).toBe(0);
    expect(summary.errorRate).toBe(0);
  });
});
