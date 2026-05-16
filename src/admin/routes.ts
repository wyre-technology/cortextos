import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../lib/admin-auth.js';
import { escapeHtml } from '../web/helpers.js';
import { THEME_VARS } from '../web/styles.js';
import { getSql, runAsSystem } from '../db/context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveOrg {
  org_id: string;
  org_name: string;
  plan: string;
  tool_calls: string;
}

interface TopTool {
  vendor_slug: string;
  tool_name: string;
  call_count: string;
}

interface CreditBurnDay {
  day: string;
  plan: string;
  credits: string;
}

interface NewOrgDay {
  day: string;
  signups: string;
}

interface NewOrgRecent {
  org_id: string;
  org_name: string;
  plan: string;
  owner_email: string | null;
  owner_name: string | null;
  created_at: string;
}

interface PlanDistribution {
  plan: string;
  count: string;
}

interface MetricsResponse {
  generated_at: string;
  active_orgs: {
    count: number;
    orgs: Array<{ org_id: string; org_name: string; plan: string; tool_calls: number }>;
  };
  top_tools: Array<{ vendor_slug: string; tool_name: string; call_count: number }>;
  credit_burn_rate: Array<{ day: string; plan: string; credits: number }>;
  new_orgs: Array<{ day: string; signups: number }>;
  new_orgs_recent: Array<{
    org_id: string;
    org_name: string;
    plan: string;
    owner_email: string | null;
    owner_name: string | null;
    created_at: string;
  }>;
  plan_distribution: Array<{ plan: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Queries — all run concurrently, no N+1
// ---------------------------------------------------------------------------

async function fetchMetrics(): Promise<MetricsResponse> {
  const [activeOrgs, topTools, creditBurn, newOrgs, newOrgsRecent, planDist] = await Promise.all([
    // 1. Active orgs — at least one tool call in the last 30 days
    getSql()<ActiveOrg[]>`
      SELECT
        o.id          AS org_id,
        o.name        AS org_name,
        o.plan,
        COUNT(*)::text AS tool_calls
      FROM request_log rl
      JOIN organizations o ON o.id = rl.org_id
      WHERE rl.created_at >= NOW() - INTERVAL '30 days'
        AND rl.tool_name IS NOT NULL
        AND rl.vendor_slug NOT IN ('_unified', '_gateway')
      GROUP BY o.id, o.name, o.plan
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `,

    // 2. Top tools — most-called vendor+tool combinations (last 30 days)
    getSql()<TopTool[]>`
      SELECT
        vendor_slug,
        tool_name,
        COUNT(*)::text AS call_count
      FROM request_log
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND tool_name IS NOT NULL
        AND vendor_slug NOT IN ('_unified', '_gateway')
      GROUP BY vendor_slug, tool_name
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `,

    // 3. Credit burn rate — credits per day per plan (last 30 days)
    getSql()<CreditBurnDay[]>`
      SELECT
        date_trunc('day', cl.recorded_at)::date::text AS day,
        o.plan,
        SUM(cl.credits_used)::text AS credits
      FROM credit_ledger cl
      JOIN organizations o ON o.id = cl.org_id
      WHERE cl.recorded_at >= NOW() - INTERVAL '30 days'
      GROUP BY date_trunc('day', cl.recorded_at), o.plan
      ORDER BY day ASC, o.plan
    `,

    // 4. New org signups per day (last 14 days) — for the trend chart
    getSql()<NewOrgDay[]>`
      SELECT
        date_trunc('day', created_at)::date::text AS day,
        COUNT(*)::text AS signups
      FROM organizations
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY day ASC
    `,

    // 4b. New org signups (per-org, last 14 days) — for the "who signed up" list
    getSql()<NewOrgRecent[]>`
      SELECT
        o.id   AS org_id,
        o.name AS org_name,
        o.plan,
        u.email AS owner_email,
        u.name  AS owner_name,
        to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_at
      FROM organizations o
      LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.created_at >= NOW() - INTERVAL '14 days'
      ORDER BY o.created_at DESC
      LIMIT 50
    `,

    // 5. Plan distribution — count of orgs per plan
    getSql()<PlanDistribution[]>`
      SELECT plan, COUNT(*)::text AS count
      FROM organizations
      GROUP BY plan
      ORDER BY plan
    `,
  ]);

  const n = (s: string) => parseInt(s, 10);
  return {
    generated_at: new Date().toISOString(),
    active_orgs: {
      count: activeOrgs.length,
      orgs: activeOrgs.map((r) => ({ org_id: r.org_id, org_name: r.org_name, plan: r.plan, tool_calls: n(r.tool_calls) })),
    },
    top_tools: topTools.map((r) => ({ vendor_slug: r.vendor_slug, tool_name: r.tool_name, call_count: n(r.call_count) })),
    credit_burn_rate: creditBurn.map((r) => ({ day: r.day, plan: r.plan, credits: n(r.credits) })),
    new_orgs: newOrgs.map((r) => ({ day: r.day, signups: n(r.signups) })),
    new_orgs_recent: newOrgsRecent.map((r) => ({
      org_id: r.org_id,
      org_name: r.org_name,
      plan: r.plan,
      owner_email: r.owner_email,
      owner_name: r.owner_name,
      created_at: r.created_at,
    })),
    plan_distribution: planDist.map((r) => ({ plan: r.plan, count: n(r.count) })),
  };
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function renderDashboard(metrics: MetricsResponse): string {
  const planDistRows = metrics.plan_distribution
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.plan)}</td><td class="num">${p.count.toLocaleString()}</td></tr>`,
    )
    .join('');

  const activeOrgRows = metrics.active_orgs.orgs
    .map(
      (o) =>
        `<tr>
          <td>${escapeHtml(o.org_name)}</td>
          <td><span class="badge badge-${escapeHtml(o.plan)}">${escapeHtml(o.plan)}</span></td>
          <td class="num">${o.tool_calls.toLocaleString()}</td>
        </tr>`,
    )
    .join('');

  const topToolRows = metrics.top_tools
    .map(
      (t, i) =>
        `<tr>
          <td class="num muted">${i + 1}</td>
          <td><span class="vendor-tag">${escapeHtml(t.vendor_slug)}</span></td>
          <td>${escapeHtml(t.tool_name)}</td>
          <td class="num">${t.call_count.toLocaleString()}</td>
        </tr>`,
    )
    .join('');

  const newOrgRows = metrics.new_orgs_recent
    .map((o) => {
      const planClass = o.plan === 'business' || o.plan === 'pro' || o.plan === 'free' ? `badge-${o.plan}` : 'badge-free';
      const owner = o.owner_email
        ? `${escapeHtml(o.owner_email)}${o.owner_name && o.owner_name !== o.owner_email ? ` <span class="muted">(${escapeHtml(o.owner_name)})</span>` : ''}`
        : '<span class="muted">—</span>';
      const day = String(o.created_at).replace('T', ' ').replace(/\.\d+Z$/, '');
      return `
        <tr>
          <td class="muted">${escapeHtml(day)}</td>
          <td><a class="mono" href="/admin/orgs/${o.org_id}">${escapeHtml(o.org_name)}</a></td>
          <td>${owner}</td>
          <td><span class="badge ${planClass}">${escapeHtml(o.plan)}</span></td>
        </tr>`;
    })
    .join('');

  const burnByDay: Record<string, number> = {};
  for (const row of metrics.credit_burn_rate) {
    burnByDay[row.day] = (burnByDay[row.day] ?? 0) + row.credits;
  }
  const burnDays = Object.keys(burnByDay).sort();
  const burnValues = burnDays.map((d) => burnByDay[d]);

  const newOrgDays = metrics.new_orgs.map((d) => d.day);
  const newOrgCounts = metrics.new_orgs.map((d) => d.signups);

  const totalCredits30d = burnValues.reduce((a, b) => a + b, 0);
  const totalNewOrgs14d = metrics.new_orgs.reduce((a, d) => a + d.signups, 0);
  const totalOrgs = metrics.plan_distribution.reduce((a, p) => a + p.count, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Dashboard — Wyre Technology</title>
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    ${THEME_VARS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-body);
      background: var(--bg-body);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 32px 24px 64px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .page { max-width: 1100px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 32px;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand {
      font-family: var(--font-heading);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }
    h1 {
      font-family: var(--font-heading);
      font-size: 24px;
      font-weight: 600;
      color: var(--text-heading);
      margin-top: 4px;
    }
    .generated-at {
      font-size: 12px;
      color: var(--text-muted);
    }
    .refresh-btn {
      font-size: 12px;
      color: var(--accent-text);
      background: none;
      border: 1px solid rgba(0,201,219,0.3);
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .refresh-btn:hover { border-color: var(--accent); }

    /* KPI cards */
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .kpi {
      background: var(--bg-card);
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      padding: 18px 20px;
    }
    .kpi-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .kpi-value {
      font-family: var(--font-heading);
      font-size: 28px;
      font-weight: 600;
      color: var(--text-heading);
      line-height: 1;
    }
    .kpi-sub {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 4px;
    }

    /* Sections */
    .section { margin-bottom: 36px; }
    .section-title {
      font-family: var(--font-heading);
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-heading);
      margin-bottom: 12px;
    }

    /* Charts side by side */
    .charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 36px;
    }
    @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
    .chart-card {
      background: var(--bg-card);
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      padding: 16px 20px 12px;
    }
    .chart-card-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .chart-wrap { position: relative; height: 180px; }

    /* Tables */
    .table-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th {
      background: var(--bg-sidebar);
      padding: 10px 14px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      position: sticky;
      top: 0;
    }
    tbody tr { border-top: 1px solid var(--border-subtle); }
    tbody tr:hover { background: var(--bg-hover); }
    tbody td { padding: 9px 14px; color: var(--text-primary); }
    .num { text-align: right; font-family: var(--font-mono); font-size: 12px; }
    .muted { color: var(--text-muted); }
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .badge-free { background: var(--border-tertiary); color: var(--text-tertiary); }
    .badge-pro { background: rgba(0,201,219,0.15); color: var(--accent-text); }
    .badge-business { background: rgba(34,197,94,0.12); color: var(--success-text); }
    .vendor-tag {
      display: inline-block;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--accent-text);
      background: rgba(0,201,219,0.08);
      border-radius: 3px;
      padding: 1px 5px;
    }
    .empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }

    /* Layout helpers */
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand">Wyre Technology · Admin</div>
        <h1>Operations Dashboard</h1>
        <div class="generated-at">Generated ${escapeHtml(metrics.generated_at)} · auto-refreshes every 60s</div>
      </div>
      <button class="refresh-btn" onclick="location.reload()">Refresh now</button>
    </div>

    <!-- KPI cards -->
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Active Orgs</div>
        <div class="kpi-value">${metrics.active_orgs.count.toLocaleString()}</div>
        <div class="kpi-sub">tool calls in last 30d</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total Orgs</div>
        <div class="kpi-value">${totalOrgs.toLocaleString()}</div>
        <div class="kpi-sub">all time</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">New Orgs</div>
        <div class="kpi-value">${totalNewOrgs14d.toLocaleString()}</div>
        <div class="kpi-sub">signups in last 14d</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Credits Used</div>
        <div class="kpi-value">${totalCredits30d.toLocaleString()}</div>
        <div class="kpi-sub">last 30d (all plans)</div>
      </div>
    </div>

    <!-- Charts -->
    <div class="charts">
      <div class="chart-card">
        <div class="chart-card-title">Credit Burn — last 30 days</div>
        <div class="chart-wrap"><canvas id="burnChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">New Orgs — last 14 days</div>
        <div class="chart-wrap"><canvas id="newOrgsChart"></canvas></div>
      </div>
    </div>

    <!-- Active orgs + Plan distribution -->
    <div class="two-col" style="margin-bottom:36px">
      <div class="section">
        <div class="section-title">Plan Distribution</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Plan</th><th class="num">Orgs</th></tr></thead>
            <tbody>
              ${planDistRows || '<tr><td colspan="2" class="empty">No data</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Active Orgs (last 30d)</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Org</th><th>Plan</th><th class="num">Calls</th></tr></thead>
            <tbody>
              ${activeOrgRows || '<tr><td colspan="3" class="empty">No activity</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Top tools -->
    <div class="section">
      <div class="section-title">Top Tools — last 30 days</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:40px">#</th>
              <th>Vendor</th>
              <th>Tool</th>
              <th class="num">Calls</th>
            </tr>
          </thead>
          <tbody>
            ${topToolRows || '<tr><td colspan="4" class="empty">No tool calls recorded</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- New org signups (per-org list) -->
    <div class="section">
      <div class="section-title">New org signups — last 14 days</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Org</th><th>Owner</th><th>Plan</th></tr></thead>
          <tbody>
            ${newOrgRows || '<tr><td colspan="4" class="empty">No signups in this period</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    // Chart.js — use CSS vars via getComputedStyle for theme-awareness
    var root = document.documentElement;
    function cssVar(name) {
      return getComputedStyle(root).getPropertyValue(name).trim();
    }

    var burnDays   = ${JSON.stringify(burnDays)};
    var burnValues = ${JSON.stringify(burnValues)};
    var newOrgDays = ${JSON.stringify(newOrgDays)};
    var newOrgCounts = ${JSON.stringify(newOrgCounts)};

    var accent = cssVar('--accent') || '#00C9DB';
    var success = cssVar('--success') || '#22c55e';
    var textMuted = cssVar('--text-muted') || '#525252';
    var borderColor = cssVar('--border-secondary') || '#2a2a2a';

    var sharedOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.parsed.y.toLocaleString(); } } }
      },
      scales: {
        x: {
          ticks: { color: textMuted, font: { size: 10 }, maxRotation: 45 },
          grid: { color: borderColor }
        },
        y: {
          ticks: { color: textMuted, font: { size: 10 } },
          grid: { color: borderColor },
          beginAtZero: true
        }
      }
    };

    new Chart(document.getElementById('burnChart'), {
      type: 'bar',
      data: {
        labels: burnDays,
        datasets: [{
          data: burnValues,
          backgroundColor: accent + '66',
          borderColor: accent,
          borderWidth: 1,
          borderRadius: 3
        }]
      },
      options: sharedOptions
    });

    new Chart(document.getElementById('newOrgsChart'), {
      type: 'bar',
      data: {
        labels: newOrgDays,
        datasets: [{
          data: newOrgCounts,
          backgroundColor: success + '55',
          borderColor: success,
          borderWidth: 1,
          borderRadius: 3
        }]
      },
      options: sharedOptions
    });

    setTimeout(function() { location.reload(); }, 60000);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export function adminMetricsRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // -------------------------------------------------------------------------
    // GET /api/admin/metrics — JSON metrics payload
    // -------------------------------------------------------------------------
    app.get('/api/admin/metrics', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      // fetchMetrics aggregates platform-wide across all orgs — it must run
      // system-path (BYPASSRLS). On the request-path connection RLS scopes it
      // to the caller's own org memberships (and to nothing at all for an
      // ADMIN_API_KEY caller, which has no session user). requireAdmin above
      // is the gate; runAsSystem wraps only the data access.
      const metrics = await runAsSystem(() => fetchMetrics());
      return reply.send(metrics);
    });

    // -------------------------------------------------------------------------
    // GET /admin/dashboard — HTML dashboard page
    // -------------------------------------------------------------------------
    app.get('/admin/dashboard', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      // Platform-wide aggregate — system-path, same as /api/admin/metrics.
      const metrics = await runAsSystem(() => fetchMetrics());
      return reply.type('text/html').send(renderDashboard(metrics));
    });
  };
}
