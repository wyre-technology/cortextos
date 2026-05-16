import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../lib/admin-auth.js';
import { escapeHtml } from '../web/helpers.js';
import { renderAdminPage } from './layout.js';
import { getSql, runAsSystem } from '../db/context.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Email domains excluded from "real user" reports. Treated as staff/internal.
// Keep this list short and explicit — add via PR, not env var, so changes are
// reviewable and auditable.
const EXCLUDED_DOMAINS = ['wyretechnology.com', 'sachshaus.net'];

// Outreach bucket thresholds (days since signup). Users landing in each bucket
// get a distinct badge on the inactive-users report so the Loops operator can
// prioritize quickly. These are display-only — they do NOT filter rows.
//
// TODO(learning-mode): tune these to match how we actually stage outreach.
// See renderOutreachBadge() below — that's where these get applied.
const BUCKETS = {
  hotMaxDays: 7,      // 🔥 recently signed up, still warm
  stalledMaxDays: 30, // ⚡ stalled — nudge required
  // anything older => 🧊 cold
} as const;

// ---------------------------------------------------------------------------
// Catalog — add new reports here. Rendered on /admin/reports.
// ---------------------------------------------------------------------------

interface ReportDescriptor {
  slug: string;
  title: string;
  description: string;
  href: string;
}

const REPORTS: ReportDescriptor[] = [
  {
    slug: 'inactive-users',
    title: 'Inactive Users',
    description:
      'Users who signed up but never joined an org (Tier B) or have an org with zero vendor credentials (Tier C). Used for Loops outreach.',
    href: '/admin/reports/inactive-users',
  },
];

// ---------------------------------------------------------------------------
// Inactive users query
// ---------------------------------------------------------------------------

interface InactiveUserRow {
  email: string;
  name: string | null;
  signed_up: string;
  days_since_signup: string;
  last_login: string | null;
  never_returned: boolean;
  status: 'B_no_org' | 'C_no_creds';
  org_count: string;
  org_cred_count: string;
  has_personal_creds: boolean;
}

interface InactiveUsersFilter {
  status?: 'B_no_org' | 'C_no_creds' | 'all';
  minDays?: number;
  maxDays?: number;
}

async function fetchInactiveUsers(
  filter: InactiveUsersFilter,
): Promise<InactiveUserRow[]> {
  const status = filter.status ?? 'all';
  const minDays = filter.minDays ?? 0;
  const maxDays = filter.maxDays ?? 3650;

  return getSql()<InactiveUserRow[]>`
    WITH user_orgs AS (
      SELECT
        u.id         AS user_id,
        u.email,
        COALESCE(u.display_name, u.name) AS name,
        u.created_at,
        u.last_login,
        array_agg(DISTINCT om.org_id) FILTER (WHERE om.org_id IS NOT NULL) AS org_ids
      FROM users u
      LEFT JOIN org_members om ON om.user_id = u.id
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest(${getSql().array(EXCLUDED_DOMAINS)}::text[]) d
        WHERE u.email ILIKE '%@' || d
      )
      GROUP BY u.id
    ),
    user_creds AS (
      SELECT
        uo.user_id,
        EXISTS (SELECT 1 FROM credentials c WHERE c.user_id = uo.user_id) AS has_personal_creds,
        COALESCE((
          SELECT COUNT(*)::int FROM (
            SELECT 1 FROM org_credentials oc WHERE oc.org_id = ANY(uo.org_ids)
            UNION ALL
            SELECT 1 FROM org_team_credentials otc WHERE otc.org_id = ANY(uo.org_ids)
            UNION ALL
            SELECT 1 FROM service_client_credentials scc WHERE scc.org_id = ANY(uo.org_ids)
          ) x
        ), 0) AS org_cred_count
      FROM user_orgs uo
    )
    SELECT
      uo.email,
      uo.name,
      uo.created_at::date::text AS signed_up,
      EXTRACT(DAY FROM NOW() - uo.created_at)::int::text AS days_since_signup,
      CASE
        WHEN (uo.last_login - uo.created_at) < INTERVAL '5 minutes' THEN NULL
        ELSE uo.last_login::date::text
      END AS last_login,
      (uo.last_login - uo.created_at) < INTERVAL '5 minutes' AS never_returned,
      CASE
        WHEN uo.org_ids IS NULL THEN 'B_no_org'
        ELSE 'C_no_creds'
      END AS status,
      COALESCE(array_length(uo.org_ids, 1), 0)::text AS org_count,
      uc.org_cred_count::text,
      uc.has_personal_creds
    FROM user_orgs uo
    JOIN user_creds uc ON uc.user_id = uo.user_id
    WHERE (uo.org_ids IS NULL OR (uc.org_cred_count = 0 AND NOT uc.has_personal_creds))
      AND (${status} = 'all' OR CASE WHEN uo.org_ids IS NULL THEN 'B_no_org' ELSE 'C_no_creds' END = ${status})
      AND EXTRACT(DAY FROM NOW() - uo.created_at)::int BETWEEN ${minDays} AND ${maxDays}
    ORDER BY uo.created_at DESC
  `;
}

// ---------------------------------------------------------------------------
// Outreach priority bucket (display-only)
// ---------------------------------------------------------------------------

interface Bucket {
  emoji: string;
  label: string;
  cssClass: string;
}

function outreachBucket(row: InactiveUserRow): Bucket {
  const days = parseInt(row.days_since_signup, 10);
  if (row.status === 'B_no_org' && row.has_personal_creds) {
    return { emoji: '🔥', label: 'hot', cssClass: 'badge-pro' };
  }
  if (days <= BUCKETS.hotMaxDays) {
    return { emoji: '⚡', label: 'fresh', cssClass: 'badge-business' };
  }
  if (days <= BUCKETS.stalledMaxDays) {
    return { emoji: '⏳', label: 'stalled', cssClass: 'badge-B' };
  }
  return { emoji: '🧊', label: 'cold', cssClass: 'badge-free' };
}

// ---------------------------------------------------------------------------
// Reports index HTML
// ---------------------------------------------------------------------------

function renderReportsIndex(): string {
  const cards = REPORTS.map(
    (r) => `
      <a class="report-card" href="${r.href}">
        <h2>${escapeHtml(r.title)}</h2>
        <p>${escapeHtml(r.description)}</p>
      </a>
    `,
  ).join('');

  const body = `
    <div class="header">
      <div>
        <h1>Reports</h1>
        <div class="subtitle">Ad-hoc queries for ops, growth, and customer success.</div>
      </div>
    </div>
    <div class="report-grid">${cards}</div>
  `;

  return renderAdminPage({ title: 'Reports', activePath: '/admin/reports', body });
}

// ---------------------------------------------------------------------------
// Inactive users HTML
// ---------------------------------------------------------------------------

function renderInactiveUsersPage(
  rows: InactiveUserRow[],
  filter: InactiveUsersFilter,
  generatedAt: string,
): string {
  const tierBCount = rows.filter((r) => r.status === 'B_no_org').length;
  const tierCCount = rows.filter((r) => r.status === 'C_no_creds').length;
  const neverReturned = rows.filter((r) => r.never_returned).length;

  const currentStatus = filter.status ?? 'all';
  const currentMin = filter.minDays ?? 0;
  const currentMax = filter.maxDays ?? '';

  const statusOpt = (value: string, label: string) =>
    `<option value="${value}"${currentStatus === value ? ' selected' : ''}>${label}</option>`;

  const qs = new URLSearchParams();
  if (filter.status && filter.status !== 'all') qs.set('status', filter.status);
  if (filter.minDays) qs.set('min_days', String(filter.minDays));
  if (filter.maxDays) qs.set('max_days', String(filter.maxDays));
  const csvHref = `/admin/reports/inactive-users.csv${qs.toString() ? `?${qs.toString()}` : ''}`;

  const tableRows = rows
    .map((r) => {
      const bucket = outreachBucket(r);
      const statusLabel = r.status === 'B_no_org' ? 'B · no org' : 'C · no creds';
      const statusBadge = r.status === 'B_no_org' ? 'badge-B' : 'badge-C';
      const lastLogin = r.never_returned
        ? '<span class="muted">never returned</span>'
        : escapeHtml(r.last_login ?? '—');
      const name = r.name && r.name !== r.email ? escapeHtml(r.name) : '';
      return `
        <tr>
          <td><span class="badge ${bucket.cssClass}" title="${bucket.label}">${bucket.emoji} ${bucket.label}</span></td>
          <td class="mono">${escapeHtml(r.email)}</td>
          <td>${name}</td>
          <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
          <td class="num">${escapeHtml(r.signed_up)}</td>
          <td class="num">${escapeHtml(r.days_since_signup)}</td>
          <td>${lastLogin}</td>
          <td class="num">${escapeHtml(r.org_count)}</td>
          <td class="num">${escapeHtml(r.org_cred_count)}</td>
          <td>${r.has_personal_creds ? '<span class="mono" style="color:var(--accent-text)">yes</span>' : '<span class="muted">no</span>'}</td>
        </tr>`;
    })
    .join('');

  const body = `
    <div class="header">
      <div>
        <h1>Inactive Users</h1>
        <div class="subtitle">
          Tier B (signed up, no org) + Tier C (has org, no vendor creds). Excluding internal domains.
          · Generated ${escapeHtml(generatedAt)}
        </div>
      </div>
      <a class="btn" href="${csvHref}">Download CSV</a>
    </div>

    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Total</div>
        <div class="kpi-value">${rows.length.toLocaleString()}</div>
        <div class="kpi-sub">matching filter</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Tier B · no org</div>
        <div class="kpi-value">${tierBCount.toLocaleString()}</div>
        <div class="kpi-sub">signed up, never created/joined an org</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Tier C · no creds</div>
        <div class="kpi-value">${tierCCount.toLocaleString()}</div>
        <div class="kpi-sub">has an org, zero vendor credentials</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Never returned</div>
        <div class="kpi-value">${neverReturned.toLocaleString()}</div>
        <div class="kpi-sub">of the ${rows.length.toLocaleString()} above</div>
      </div>
    </div>

    <form class="filters" method="get">
      <label>
        Status
        <select name="status">
          ${statusOpt('all', 'All (B + C)')}
          ${statusOpt('B_no_org', 'B — signed up, no org')}
          ${statusOpt('C_no_creds', 'C — org, no vendor creds')}
        </select>
      </label>
      <label>
        Min days since signup
        <input type="number" name="min_days" min="0" value="${currentMin || ''}" placeholder="0" />
      </label>
      <label>
        Max days since signup
        <input type="number" name="max_days" min="0" value="${currentMax}" placeholder="no limit" />
      </label>
      <button class="btn" type="submit">Apply</button>
    </form>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Priority</th>
            <th>Email</th>
            <th>Name</th>
            <th>Status</th>
            <th class="num">Signed up</th>
            <th class="num">Days</th>
            <th>Last login</th>
            <th class="num">Orgs</th>
            <th class="num">Creds</th>
            <th>Personal creds</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="10" class="empty">No users match this filter. Nice — everyone\'s onboarded.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  return renderAdminPage({
    title: 'Inactive Users',
    activePath: '/admin/reports',
    body,
  });
}

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'email',
  'name',
  'status',
  'priority',
  'signed_up',
  'days_since_signup',
  'last_login',
  'never_returned',
  'org_count',
  'org_cred_count',
  'has_personal_creds',
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function rowsToCsv(rows: InactiveUserRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const body = rows
    .map((r) => {
      const bucket = outreachBucket(r);
      const fields: Record<(typeof CSV_COLUMNS)[number], string> = {
        email: r.email,
        name: r.name ?? '',
        status: r.status,
        priority: bucket.label,
        signed_up: r.signed_up,
        days_since_signup: r.days_since_signup,
        last_login: r.last_login ?? '',
        never_returned: r.never_returned ? 'true' : 'false',
        org_count: r.org_count,
        org_cred_count: r.org_cred_count,
        has_personal_creds: r.has_personal_creds ? 'true' : 'false',
      };
      return CSV_COLUMNS.map((c) => csvEscape(fields[c])).join(',');
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function sendCsv(reply: FastifyReply, filename: string, body: string): FastifyReply {
  return reply
    .type('text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(body);
}

// ---------------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------------

interface QueryString {
  status?: string;
  min_days?: string;
  max_days?: string;
}

function parseFilter(qs: QueryString): InactiveUsersFilter {
  const filter: InactiveUsersFilter = {};
  if (qs.status === 'B_no_org' || qs.status === 'C_no_creds' || qs.status === 'all') {
    filter.status = qs.status;
  }
  const min = qs.min_days ? parseInt(qs.min_days, 10) : NaN;
  const max = qs.max_days ? parseInt(qs.max_days, 10) : NaN;
  if (Number.isFinite(min) && min >= 0) filter.minDays = min;
  if (Number.isFinite(max) && max >= 0) filter.maxDays = max;
  return filter;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export function adminReportsRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/admin/reports', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      return reply.type('text/html').send(renderReportsIndex());
    });

    app.get<{ Querystring: QueryString }>('/admin/reports/inactive-users', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const filter = parseFilter(request.query);
      // Platform-wide report across all users/orgs — system-path (BYPASSRLS).
      // requireAdmin above is the gate.
      const rows = await runAsSystem(() => fetchInactiveUsers(filter));
      const html = renderInactiveUsersPage(rows, filter, new Date().toISOString());
      return reply.type('text/html').send(html);
    });

    app.get<{ Querystring: QueryString }>(
      '/admin/reports/inactive-users.csv',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const filter = parseFilter(request.query);
        // Platform-wide report across all users/orgs — system-path
        // (BYPASSRLS). requireAdmin above is the gate.
        const rows = await runAsSystem(() => fetchInactiveUsers(filter));
        const date = new Date().toISOString().slice(0, 10);
        return sendCsv(reply, `inactive-users-${date}.csv`, rowsToCsv(rows));
      },
    );

    app.get<{ Querystring: QueryString }>(
      '/api/admin/reports/inactive-users',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const filter = parseFilter(request.query);
        // Platform-wide report across all users/orgs — system-path
        // (BYPASSRLS). requireAdmin above is the gate.
        const rows = await runAsSystem(() => fetchInactiveUsers(filter));
        return reply.send({ generated_at: new Date().toISOString(), filter, rows });
      },
    );
  };
}
