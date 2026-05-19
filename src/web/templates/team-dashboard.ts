/**
 * Team dashboard page — usage analytics and token savings overview.
 *
 * Data is loaded client-side from the dashboard API endpoints
 * to keep server rendering simple and avoid blocking page load.
 */

import { escapeHtml } from '../helpers.js';

export interface TeamDashboardData {
  orgId: string;
  orgName: string;
}

const DASHBOARD_STYLES = `
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 20px;
  }
  .stat-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .stat-value.accent { color: var(--accent); }
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-bottom: 24px;
  }
  .data-table th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid var(--border-subtle);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .data-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 24px 0 12px;
  }
  .loading { color: var(--text-muted); font-style: italic; }
`;

const DASHBOARD_SCRIPT = `
  async function loadDashboard() {
    try {
      const [usageRes, savingsRes, vendorsRes] = await Promise.all([
        fetch('/api/dashboard/usage'),
        fetch('/api/dashboard/savings'),
        fetch('/api/dashboard/vendors'),
      ]);

      if (!usageRes.ok || !savingsRes.ok || !vendorsRes.ok) {
        document.getElementById('dashboardLoading').textContent = 'Failed to load dashboard data.';
        return;
      }

      const usage = await usageRes.json();
      const savings = await savingsRes.json();
      const vendors = await vendorsRes.json();

      // Summary cards
      document.getElementById('totalCalls').textContent = usage.totalCalls.toLocaleString();
      document.getElementById('activeUsers').textContent = usage.uniqueUsers.toLocaleString();
      document.getElementById('avgLatency').textContent = usage.avgResponseTimeMs + 'ms';
      // errorRate is a 0–1 fraction; render as a percentage. Fall back to 0
      // if the field is absent (older API responses).
      document.getElementById('errorRate').textContent = ((usage.errorRate ?? 0) * 100).toFixed(1) + '%';
      document.getElementById('tokensSaved').textContent = savings.estimatedTokensSaved.toLocaleString();
      document.getElementById('costSaved').textContent = '$' + savings.estimatedCostSavedUsd.toFixed(2);
      document.getElementById('cliCalls').textContent = savings.totalCliCalls.toLocaleString();

      // Vendor table
      let vendorHtml = '';
      for (const v of vendors.vendors || []) {
        vendorHtml += '<tr><td>' + v.vendor + '</td><td>' + v.totalCalls +
          '</td><td>' + v.uniqueUsers + '</td><td>' + v.avgResponseTimeMs +
          'ms</td><td>' + (v.topTools[0]?.tool || '-') + '</td></tr>';
      }
      document.getElementById('vendorBody').innerHTML = vendorHtml || '<tr><td colspan="5">No data yet</td></tr>';

      // Source breakdown
      let sourceHtml = '';
      for (const s of usage.bySource || []) {
        sourceHtml += '<tr><td>' + s.source + '</td><td>' + s.count + '</td></tr>';
      }
      document.getElementById('sourceBody').innerHTML = sourceHtml || '<tr><td colspan="2">No data yet</td></tr>';

      document.getElementById('dashboardLoading').style.display = 'none';
      document.getElementById('dashboardContent').style.display = 'block';
    } catch (err) {
      document.getElementById('dashboardLoading').textContent = 'Error loading dashboard: ' + err.message;
    }
  }
  loadDashboard();
`;

export function renderTeamDashboard(data: TeamDashboardData): { body: string; pageStyles: string; pageScripts: string } {
  const body = `
    <h1>Dashboard</h1>
    <p class="section-desc">Usage analytics and token savings for ${escapeHtml(data.orgName)}.</p>

    <div id="dashboardLoading" class="loading">Loading dashboard data...</div>

    <div id="dashboardContent" style="display:none">
      <div class="dashboard-grid">
        <div class="stat-card">
          <div class="stat-label">Total Calls</div>
          <div class="stat-value" id="totalCalls">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Users</div>
          <div class="stat-value" id="activeUsers">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Latency</div>
          <div class="stat-value" id="avgLatency">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Error Rate</div>
          <div class="stat-value" id="errorRate">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tokens Saved</div>
          <div class="stat-value accent" id="tokensSaved">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cost Saved</div>
          <div class="stat-value accent" id="costSaved">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">CLI Calls</div>
          <div class="stat-value" id="cliCalls">-</div>
        </div>
      </div>

      <h2 class="section-title">Vendor Breakdown</h2>
      <table class="data-table">
        <thead><tr><th>Vendor</th><th>Calls</th><th>Users</th><th>Avg Latency</th><th>Top Tool</th></tr></thead>
        <tbody id="vendorBody"></tbody>
      </table>

      <h2 class="section-title">Source Breakdown</h2>
      <table class="data-table">
        <thead><tr><th>Source</th><th>Calls</th></tr></thead>
        <tbody id="sourceBody"></tbody>
      </table>
    </div>`;

  return {
    body,
    pageStyles: DASHBOARD_STYLES,
    pageScripts: `<script>${DASHBOARD_SCRIPT}</script>`,
  };
}
