import type { Organization } from "../../org/org-service.js";
import { escapeHtml } from "../helpers.js";

// Track C Surface 2 — Reseller Customer Detail (/org/customers/:id).
// Figma design-of-record: tbaRrzQQqZTNZu2AelcIID node 4:2.
//
// A reseller drilled into one customer org. S2's analytics are wired
// LIVE: the page renders a server-side shell, then fetches the
// reseller-scoped customer-dashboard endpoints client-side and populates
// — the same pattern as the customer's own /dashboard (see
// team-dashboard.ts). Endpoints live in main:
//   GET /admin/reseller/:resellerId/customers/:customerId/dashboard/usage
//   …/savings
//   …/vendors
// The four stat cards each pull /usage at a FIXED trailing window
// (30d / 7d / 24h) per Track C design Rule 2 — a window-labeled card
// always means its label's window, independent of any range param.
//
// The client-side populate uses createElement + textContent (never
// innerHTML): vendor names and user emails flow from request logs and
// must not be trusted as markup.
//
// What is NOT live yet, and why (each is a documented swap-in seam).
// SWAP-IN CONTRACT for every gap below: the new endpoint MUST be
// reseller-scoped and :id-ownership-checked via requireResellerOrCustomerAccess
// (warden Finding 2) — never a bare requireResellerAccess once real customer
// data flows. The first-instance pattern is the Usage/Audit tabs already shipped.
//
//   - Customer identity (name / plan / userCount / mcpCount / subdomain) —
//     no reseller-scoped single-customer-detail endpoint exists yet (the
//     reseller customers LIST endpoint has shipped — see
//     `getCustomersOfReseller` in src/reseller/routes.ts — but not a
//     `GET /admin/reseller/:resellerId/customers/:customerId` returning
//     the CustomerSummary shape). Passed as mock `customer` here until
//     that endpoint lands.
//   - MCP wiring-type, per-connection status dot, last-call — the
//     OWNER-scoped vendor-health read model exists
//     (`/api/orgs/:orgId/vendor-health`, `assembleOrgVendorHealth`); a
//     RESELLER-SCOPED variant (`requireResellerOrCustomerAccess`-gated)
//     does not. Wiring this surface needs that variant + a
//     connection-config read for per-connection wiring-type + last-call.
//   - Per-user role / department / tool-access — no reseller-scoped
//     customer-org-member read endpoint exists yet.
//
// The Figma frame surfaces those; v1 ships the live-analytics subset and
// flags the rest rather than mocking a whole page silently.
//
// NOTE: errorRate IS now live (UsageSummary aggregate, src/dashboard/
// dashboard-service.ts:24 — guarded by usage-summary-error-rate.integration
// .test.ts). The client correctly consumes it at the 7d card; the
// em-dash fallback is defensive, not a placeholder.

export interface CustomerSummary {
  id: string;
  name: string;
  plan: string;
  userCount: number;
  mcpCount: number;
  subdomain: string;
}

export interface ResellerCustomerDetailData {
  /** The reseller org (the caller). */
  org: Organization;
  /**
   * The customer org being viewed — mock until a reseller-scoped
   * single-customer-detail endpoint (`requireResellerOrCustomerAccess`-gated)
   * lands. The reseller customers LIST is wired; per-customer detail is not.
   */
  customer: CustomerSummary;
}

/**
 * Client-side loader. Fetches the three reseller-scoped dashboard
 * endpoints and populates the shell with createElement + textContent
 * (never innerHTML — request-log-sourced strings are untrusted).
 * Mirrors team-dashboard.ts: server rendering stays simple.
 */
function buildScript(resellerId: string, customerId: string): string {
  const base = `/admin/reseller/${encodeURIComponent(resellerId)}/customers/${encodeURIComponent(customerId)}/dashboard`;
  return `
<script>
  (function () {
    var BASE = ${JSON.stringify(base)};
    var DAY_MS = 86400000;
    function num(n) { return (n == null ? 0 : n).toLocaleString(); }
    function set(id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    }
    function cell(tag, cls, text) {
      var el = document.createElement(tag);
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    }
    // Each stat card is a FIXED trailing window (Track C design Rule 2):
    // the card means its label's window always, independent of any range.
    function usageUrl(days) {
      var start = new Date(Date.now() - days * DAY_MS).toISOString();
      return BASE + '/usage?start=' + encodeURIComponent(start);
    }
    // errorRate is a 0–1 fraction (UsageSummary contract, conduit #187).
    // Until that aggregate ships the field is absent — degrade gracefully;
    // the card is correct the instant it lands, with zero UI change.
    function fmtErrorRate(r) {
      if (r == null || isNaN(r)) return '—';
      return (r * 100).toFixed(1) + '%';
    }

    Promise.all([
      fetch(usageUrl(30)),
      fetch(usageUrl(7)),
      fetch(usageUrl(1)),
      fetch(BASE + '/vendors'),
    ]).then(function (res) {
      if (res.some(function (r) { return !r.ok; })) throw new Error('request failed');
      return Promise.all(res.map(function (r) { return r.json(); }));
    }).then(function (out) {
      var u30 = out[0], u7 = out[1], u24 = out[2], vendors = out[3];

      set('cdMcpCalls', num(u30.totalCalls));
      set('cdActiveUsers', num(u7.uniqueUsers));
      set('cdToolCalls', num(u24.totalCalls));
      set('cdErrorRate', fmtErrorRate(u7.errorRate));

      var mcpGrid = document.getElementById('cdMcpGrid');
      if (mcpGrid) {
        var list = vendors.vendors || [];
        if (!list.length) {
          mcpGrid.appendChild(cell('p', 'cd-empty', 'No MCP activity in this window yet.'));
        }
        list.forEach(function (v) {
          var topTool = (v.topTools && v.topTools[0]) ? v.topTools[0].tool : '—';
          var card = document.createElement('div');
          card.className = 'cd-mcp-card';
          card.appendChild(cell('div', 'cd-mcp-name', v.vendor));
          card.appendChild(cell('div', 'cd-mcp-meta',
            num(v.totalCalls) + ' calls · ' + num(v.uniqueUsers) + ' users · '
            + num(v.avgResponseTimeMs) + 'ms avg'));
          card.appendChild(cell('div', 'cd-mcp-tool', 'Top tool: ' + topTool));
          mcpGrid.appendChild(card);
        });
      }

      var userBody = document.getElementById('cdUserBody');
      if (userBody) {
        var users = u30.byUser || [];
        if (!users.length) {
          var empty = document.createElement('tr');
          var td = cell('td', 'cd-empty', 'No user activity yet.');
          td.colSpan = 2;
          empty.appendChild(td);
          userBody.appendChild(empty);
        }
        users.forEach(function (u) {
          var row = document.createElement('tr');
          row.appendChild(cell('td', null, u.email || u.userId));
          row.appendChild(cell('td', 'cd-num', num(u.count)));
          userBody.appendChild(row);
        });
      }

      document.getElementById('cdLoading').style.display = 'none';
      document.getElementById('cdContent').style.display = 'block';
    }).catch(function () {
      var l = document.getElementById('cdLoading');
      if (!l) return;
      l.textContent = 'Could not load customer analytics. ';
      l.classList.add('cd-load-error');
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'cd-retry';
      retry.textContent = 'Retry';
      retry.onclick = function () { location.reload(); };
      l.appendChild(retry);
    });
  })();
</script>`;
}

export function renderResellerCustomerDetail(
  data: ResellerCustomerDetailData,
): { body: string; pageScripts: string } {
  const { org, customer } = data;
  const name = escapeHtml(customer.name);
  const orgName = escapeHtml(org.name);
  const onboardHref = `/org/customers/${encodeURIComponent(customer.id)}/onboard-mcp?step=1`;

  const body = `
    <nav class="cd-breadcrumb" aria-label="Breadcrumb">
      <span>${orgName}</span>
      <span class="cd-crumb-sep">/</span>
      <a href="/org/customers">Customers</a>
      <span class="cd-crumb-sep">/</span>
      <span class="cd-crumb-current">${name}</span>
    </nav>

    <div class="cd-header">
      <div>
        <h1 style="margin-bottom:4px">${name}</h1>
        <p class="section-desc">${
          // Omit any segment whose source value is empty, rather than
          // rendering a dangling " · " (omit-not-blank, Track C Rule 1).
          [
            // RC4 (ruby + Aaron 2026-06-05): plan removed from the
            // customer-detail header subtitle. Same OC1-class fix —
            // flat-pricing has one plan; the "BUSINESS plan" /
            // "FREE plan" labels were UX-misleading rather than
            // informative.
            `${customer.userCount.toLocaleString()} users`,
            `${customer.mcpCount.toLocaleString()} MCPs`,
            customer.subdomain ? escapeHtml(customer.subdomain) : "",
          ]
            .filter(Boolean)
            .join(" · ")
        }</p>
      </div>
      <div class="cd-actions">
        <a class="cd-btn-primary" href="${onboardHref}">+ Onboard MCP</a>
      </div>
    </div>

    <p id="cdLoading" class="cd-loading" role="status" aria-live="polite">Loading customer analytics…</p>

    <div id="cdContent" style="display:none">
      <div class="cd-stat-grid">
        <div class="cd-stat">
          <div class="cd-stat-label">MCP Calls (30d)</div>
          <div class="cd-stat-value" id="cdMcpCalls">—</div>
        </div>
        <div class="cd-stat">
          <div class="cd-stat-label">Active Users (7d)</div>
          <div class="cd-stat-value" id="cdActiveUsers">—</div>
        </div>
        <div class="cd-stat">
          <div class="cd-stat-label">Tool Calls (24h)</div>
          <div class="cd-stat-value" id="cdToolCalls">—</div>
        </div>
        <div class="cd-stat">
          <div class="cd-stat-label">Error Rate (7d)</div>
          <div class="cd-stat-value" id="cdErrorRate">—</div>
        </div>
      </div>

      <div class="cd-section-head">
        <div>
          <h2 class="cd-section-title">Connected MCPs</h2>
          <p class="section-desc">MCP servers ${name} reaches through Conduit, by usage.</p>
        </div>
        <a class="cd-section-link" href="${onboardHref}">+ Onboard</a>
      </div>
      <div class="cd-mcp-grid" id="cdMcpGrid"></div>

      <h2 class="cd-section-title" style="margin-top:28px">Users</h2>
      <p class="section-desc">${name} members by MCP activity in this window.</p>
      <table class="cd-table">
        <thead><tr><th>User</th><th class="cd-num">MCP Calls</th></tr></thead>
        <tbody id="cdUserBody"></tbody>
      </table>
    </div>

  `;

  return { body, pageScripts: buildScript(org.id, customer.id) };
}

export const RESELLER_CUSTOMER_DETAIL_STYLES = `
  .cd-breadcrumb {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-tertiary);
    margin-bottom: 12px;
  }
  .cd-breadcrumb a { color: var(--text-tertiary); text-decoration: none; }
  .cd-breadcrumb a:hover { color: var(--text-secondary); }
  .cd-crumb-sep { color: var(--text-muted); }
  .cd-crumb-current { color: var(--text-secondary); }

  .cd-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .cd-actions { display: flex; gap: 10px; flex-shrink: 0; }
  .cd-btn-primary {
    display: inline-block;
    padding: 9px 16px;
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
  }
  .cd-btn-secondary {
    padding: 9px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
  }
  .cd-btn-secondary:disabled { color: var(--text-muted); cursor: not-allowed; }

  .cd-loading { color: var(--text-tertiary); font-style: italic; padding: 16px 0; }
  .cd-load-error { color: var(--error-text); font-style: normal; }
  .cd-retry {
    margin-left: 4px;
    padding: 4px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .cd-retry:hover { border-color: var(--accent); color: var(--accent-text); }

  .cd-stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 28px;
  }
  .cd-stat {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 18px;
  }
  .cd-stat-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    margin-bottom: 8px;
  }
  .cd-stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .cd-section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .cd-section-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .cd-section-link {
    font-size: 12px;
    font-weight: 500;
    color: var(--accent-text);
    text-decoration: none;
    flex-shrink: 0;
  }

  .cd-mcp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
    margin-top: 14px;
  }
  .cd-mcp-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 16px;
  }
  .cd-mcp-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .cd-mcp-meta { margin-top: 6px; font-size: 11px; color: var(--text-tertiary); }
  .cd-mcp-tool { margin-top: 4px; font-size: 11px; color: var(--text-secondary); }

  .cd-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 14px;
  }
  .cd-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--border-secondary);
  }
  .cd-table td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  .cd-num { text-align: right; font-variant-numeric: tabular-nums; }
  .cd-empty { padding: 20px 12px; text-align: center; color: var(--text-tertiary); font-size: 13px; }
`;
