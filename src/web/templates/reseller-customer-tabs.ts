import type { Organization } from '../../org/org-service.js';
import type { CustomerSummary } from './reseller-customer-detail.js';
import { escapeHtml } from '../helpers.js';

// Track C step 5 — per-org management tabs (Aaron "ship it all").
// The 7 working customer-detail sub-tabs at /org/customers/:id/<slug>:
// MCPs · Users · Usage · Tool Access · Audit Log · Billing · Settings.
//
// Usage is LIVE — it client-fetches the reseller-scoped customer
// dashboard endpoint, whose requireResellerOrCustomerAccess + RLS is the
// real reseller-owns-:id boundary (warden Finding 2, enforced — same as
// S2 Overview). The other six are mock-data-first; each carries a
// documented SWAP-IN CONTRACT: the real query MUST be reseller-scoped
// and :id-ownership-checked.
//
// All routes sit behind requireResellerAccess + customer-detail navMode.

export type CustomerTabId =
  | 'mcps' | 'users' | 'usage' | 'tools' | 'audit' | 'billing' | 'settings';

export interface McpRow {
  vendor: string;
  pattern: string;
  seats: string;
  status: 'healthy' | 'degraded' | 'down';
}
export interface MemberRow {
  name: string;
  email: string;
  role: string;
  department: string;
  toolAccess: string;
  lastActive: string;
}
export interface ToolGroup {
  name: string;
  tools: Array<{ name: string; enabled: boolean }>;
}
export interface AuditRow {
  when: string;
  actor: string;
  action: string;
  target: string;
}
// InvoiceRow + cdt-inv-* CSS removed alongside the Billing tab's fabricated
// data block (F3 lesson applied to the reseller-viewing-customer direction:
// no fabricated financial data on a customer-billing surface, regardless of
// render direction). Restore alongside the reseller customer-billing read
// route — see the Billing tab seam comment.

export interface CustomerTabData {
  org: Organization;
  customer: CustomerSummary;
  tab: CustomerTabId;
  mcps: McpRow[];
  members: MemberRow[];
  memberTotal: number;
  toolDepartment: string;
  toolDepartments: string[];
  toolGroups: ToolGroup[];
  audit: AuditRow[];
}

const TAB_TITLE: Record<CustomerTabId, string> = {
  mcps: 'MCPs',
  users: 'Users',
  usage: 'Usage',
  tools: 'Tool Access',
  audit: 'Audit Log',
  billing: 'Billing',
  settings: 'Settings',
};

// ---- shared chrome -------------------------------------------------------

function renderChrome(data: CustomerTabData, body: string): string {
  const { org, customer, tab } = data;
  const name = escapeHtml(customer.name);
  const base = `/org/customers/${encodeURIComponent(customer.id)}`;
  const title = escapeHtml(TAB_TITLE[tab] ?? 'Customer');
  return `
    <nav class="cdt-breadcrumb" aria-label="Breadcrumb">
      <span>${escapeHtml(org.name)}</span>
      <span class="cdt-crumb-sep">/</span>
      <a href="/org/customers">Customers</a>
      <span class="cdt-crumb-sep">/</span>
      <a href="${base}">${name}</a>
      <span class="cdt-crumb-sep">/</span>
      <span class="cdt-crumb-current">${title}</span>
    </nav>
    <h1 class="cdt-title">${title}</h1>
    <p class="section-desc">${name} · ${escapeHtml(customer.plan)} plan</p>
    ${body}
  `;
}

function seam(text: string): string {
  return `<p class="ia-shell-note">${escapeHtml(text)}</p>`;
}

// ---- tab: MCPs -----------------------------------------------------------

function renderMcps(data: CustomerTabData): string {
  const dot: Record<McpRow['status'], string> = {
    healthy: 'cdt-dot-healthy', degraded: 'cdt-dot-degraded', down: 'cdt-dot-down',
  };
  const rows = data.mcps.map((m) => `
    <tr>
      <td class="cdt-strong">${escapeHtml(m.vendor)}</td>
      <td>${escapeHtml(m.pattern)}</td>
      <td>${escapeHtml(m.seats)}</td>
      <td><span class="cdt-dot ${dot[m.status]}"></span>${escapeHtml(m.status)}</td>
    </tr>`).join('');
  return renderChrome(data, `
    <table class="cdt-table">
      <thead><tr><th scope="col">Vendor</th><th scope="col">Wiring</th><th scope="col">Seats</th><th scope="col">Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="cdt-empty">No MCPs connected.</td></tr>`}</tbody>
    </table>
    ${seam('Mock-data-first. SWAP-IN CONTRACT: the real MCP-connection query MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
}

// ---- tab: Users ----------------------------------------------------------

function renderUsers(data: CustomerTabData): string {
  const rows = data.members.map((u) => `
    <tr>
      <td><div class="cdt-strong">${escapeHtml(u.name)}</div><div class="cdt-sub">${escapeHtml(u.email)}</div></td>
      <td>${escapeHtml(u.role)}</td>
      <td>${escapeHtml(u.department)}</td>
      <td>${escapeHtml(u.toolAccess)}</td>
      <td class="cdt-activity">${escapeHtml(u.lastActive)}</td>
    </tr>`).join('');
  const more = data.memberTotal > data.members.length
    ? `<p class="cdt-more">+ ${data.memberTotal - data.members.length} more users</p>` : '';
  return renderChrome(data, `
    <table class="cdt-table">
      <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Department</th><th scope="col">Tool Access</th><th scope="col">Last Active</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="cdt-empty">No members yet.</td></tr>`}</tbody>
    </table>
    ${more}
    ${seam('Mock-data-first. SWAP-IN CONTRACT: the real org-member query MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
}

// ---- tab: Usage (LIVE) ---------------------------------------------------

function renderUsage(data: CustomerTabData): string {
  return renderChrome(data, `
    <p id="cdtUsageLoading" class="cdt-loading">Loading usage analytics…</p>
    <div id="cdtUsageContent" style="display:none">
      <div class="cdt-stat-grid">
        <div class="cdt-stat"><div class="cdt-stat-label">MCP Calls (30d)</div><div class="cdt-stat-value" id="cdtuCalls">—</div></div>
        <div class="cdt-stat"><div class="cdt-stat-label">Active Users (30d)</div><div class="cdt-stat-value" id="cdtuUsers">—</div></div>
        <div class="cdt-stat"><div class="cdt-stat-label">Avg Latency</div><div class="cdt-stat-value" id="cdtuLatency">—</div></div>
      </div>
      <h2 class="cdt-section-title">By vendor</h2>
      <table class="cdt-table">
        <thead><tr><th scope="col">Vendor</th><th class="cdt-num" scope="col">Calls</th></tr></thead>
        <tbody id="cdtuVendors"></tbody>
      </table>
      <h2 class="cdt-section-title">By source</h2>
      <table class="cdt-table">
        <thead><tr><th scope="col">Source</th><th class="cdt-num" scope="col">Calls</th></tr></thead>
        <tbody id="cdtuSources"></tbody>
      </table>
    </div>
    <p class="ia-shell-note">Live — sourced from the reseller-scoped customer-dashboard
      endpoint, which enforces reseller-owns-customer access.</p>`);
}

/** Live loader for the Usage tab — reseller-scoped, endpoint owns authz. */
function usageScript(resellerId: string, customerId: string): string {
  const base = `/admin/reseller/${encodeURIComponent(resellerId)}/customers/${encodeURIComponent(customerId)}/dashboard`;
  return `
<script>
  (function () {
    var BASE = ${JSON.stringify(base)};
    function num(n) { return (n == null ? 0 : n).toLocaleString(); }
    function set(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
    function cell(tag, cls, t) { var e = document.createElement(tag); if (cls) e.className = cls; e.textContent = t; return e; }
    var start = new Date(Date.now() - 30 * 86400000).toISOString();
    fetch(BASE + '/usage?start=' + encodeURIComponent(start)).then(function (r) {
      if (!r.ok) throw new Error('failed');
      return r.json();
    }).then(function (u) {
      set('cdtuCalls', num(u.totalCalls));
      set('cdtuUsers', num(u.uniqueUsers));
      set('cdtuLatency', num(u.avgResponseTimeMs) + 'ms');
      var vb = document.getElementById('cdtuVendors');
      (u.byVendor || []).forEach(function (v) {
        var tr = document.createElement('tr');
        tr.appendChild(cell('td', null, v.vendor));
        tr.appendChild(cell('td', 'cdt-num', num(v.count)));
        vb.appendChild(tr);
      });
      if (vb && !vb.children.length) { var e1 = cell('td', 'cdt-empty', 'No vendor activity.'); e1.colSpan = 2; var r1 = document.createElement('tr'); r1.appendChild(e1); vb.appendChild(r1); }
      var sb = document.getElementById('cdtuSources');
      (u.bySource || []).forEach(function (s) {
        var tr = document.createElement('tr');
        tr.appendChild(cell('td', null, s.source));
        tr.appendChild(cell('td', 'cdt-num', num(s.count)));
        sb.appendChild(tr);
      });
      if (sb && !sb.children.length) { var e2 = cell('td', 'cdt-empty', 'No source data.'); e2.colSpan = 2; var r2 = document.createElement('tr'); r2.appendChild(e2); sb.appendChild(r2); }
      var loading = document.getElementById('cdtUsageLoading');
      var content = document.getElementById('cdtUsageContent');
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'block';
    }).catch(function () {
      var l = document.getElementById('cdtUsageLoading');
      if (l) l.textContent = 'Could not load usage analytics. Retry shortly.';
    });
  })();
</script>`;
}

// ---- tab: Tool Access ----------------------------------------------------

function renderTools(data: CustomerTabData): string {
  const groups = data.toolGroups.map((g) => {
    const on = g.tools.filter((t) => t.enabled).length;
    const rows = g.tools.map((t) => `
      <div class="cdt-tool-row">
        <span class="cdt-box ${t.enabled ? 'cdt-box-on' : ''}" aria-hidden="true">${t.enabled ? '&#10003;' : ''}</span>
        <span class="${t.enabled ? '' : 'cdt-tool-off'}">${escapeHtml(t.name)}<span class="cdt-sr"> — ${t.enabled ? 'enabled' : 'disabled'}</span></span>
      </div>`).join('');
    return `
      <div class="cdt-tool-group">
        <div class="cdt-tool-head"><span class="cdt-strong">${escapeHtml(g.name)}</span>
          <span class="cdt-sub">${on} of ${g.tools.length} enabled</span></div>
        ${rows}
      </div>`;
  }).join('');
  return renderChrome(data, `
    <div class="cdt-toolbar">
      <span class="cdt-label">Department:</span>
      <span class="cdt-select">${escapeHtml(data.toolDepartment)} &#9662;</span>
    </div>
    ${groups}
    ${seam('Mock-data-first. SWAP-IN CONTRACT: tool-access reads/writes MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
}

// ---- tab: Audit Log (LIVE) -----------------------------------------------

function renderAudit(data: CustomerTabData): string {
  return renderChrome(data, `
    <p id="cdtAuditLoading" class="cdt-loading" role="status" aria-live="polite">Loading audit log…</p>
    <table class="cdt-table" id="cdtAuditTable" style="display:none">
      <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th></tr></thead>
      <tbody id="cdtAuditRows"></tbody>
    </table>
    <p class="ia-shell-note">Live — sourced from the reseller-scoped customer
      audit endpoint, which enforces reseller-owns-customer access.</p>`);
}

/** Live loader for the Audit Log tab — reseller-scoped, endpoint owns authz. */
function auditScript(resellerId: string, customerId: string): string {
  const url = `/admin/reseller/${encodeURIComponent(resellerId)}/customers/${encodeURIComponent(customerId)}/audit`;
  return `
<script>
  (function () {
    var URL = ${JSON.stringify(url)};
    // Compact relative-time — same idiom as the customer list.
    function rel(iso) {
      var t = new Date(iso).getTime();
      if (isNaN(t)) return '—';
      var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (s < 60) return 'just now';
      var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }
    function cell(cls, t) { var e = document.createElement('td'); if (cls) e.className = cls; e.textContent = t; return e; }
    fetch(URL).then(function (r) {
      if (!r.ok) throw new Error('failed');
      return r.json();
    }).then(function (d) {
      var tb = document.getElementById('cdtAuditRows');
      var rows = (d && d.entries) || [];
      rows.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.appendChild(cell('cdt-activity', rel(e.when)));
        tr.appendChild(cell(null, e.actor));
        tr.appendChild(cell('cdt-strong', e.action));
        tr.appendChild(cell(null, e.target));
        tb.appendChild(tr);
      });
      if (!rows.length) {
        var td = cell('cdt-empty', 'No audit events.'); td.colSpan = 4;
        var tr = document.createElement('tr'); tr.appendChild(td); tb.appendChild(tr);
      }
      var loading = document.getElementById('cdtAuditLoading');
      var table = document.getElementById('cdtAuditTable');
      if (loading) loading.style.display = 'none';
      if (table) table.style.display = '';
    }).catch(function () {
      var l = document.getElementById('cdtAuditLoading');
      if (!l) return;
      l.textContent = 'Could not load the audit log. ';
      l.classList.add('cdt-load-error');
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'cdt-retry';
      retry.textContent = 'Retry';
      retry.onclick = function () { location.reload(); };
      l.appendChild(retry);
    });
  })();
</script>`;
}

// ---- tab: Billing --------------------------------------------------------

function renderBilling(data: CustomerTabData): string {
  // F3 lesson applied to the reseller-viewing-customer direction: no
  // fabricated financial data on a customer-billing surface. The trust
  // class ("render a number that can disagree with the real source") is
  // INVARIANT under render direction — a reseller making decisions about
  // a customer based on fabricated $/seat/invoice numbers is the same
  // disagreement-with-source-of-truth class as the F3 fabricated-card
  // breach on /org/billing, just in operator-facing direction.
  //
  // Until the reseller customer-billing READ ROUTE lands (see seam below),
  // this tab renders an honest empty state naming the gate + the future
  // content shape, so a reseller reading it understands WHY it is empty
  // and what to coordinate against when the endpoint ships.
  return renderChrome(data, `
    <div class="cdt-empty-card">
      <h2 class="cdt-section-title">Customer billing</h2>
      <p class="cdt-empty-body">Live customer billing data lands when the
        reseller customer-billing endpoint ships. This tab will surface
        seat composition, monthly total, and invoice history scoped to
        this customer once that endpoint is wired.</p>
    </div>
    ${seam('Mock-data-first. SWAP-IN CONTRACT: requires a reseller-scoped customer-billing READ ROUTE (not yet built) that verifies the calling reseller owns :id and internally calls seatService.getSeatBilling(customerId) under the verified access context. Until that route lands, this tab renders an honest empty state — never fabricated financial data on a customer-billing surface (F3 discipline applied to the reseller-viewing-customer direction).')}`);
}

// ---- tab: Settings -------------------------------------------------------

function renderSettings(data: CustomerTabData): string {
  const c = data.customer;
  return renderChrome(data, `
    <div class="cdt-form">
      <label class="cdt-field">
        <span class="cdt-label">Organization name</span>
        <input type="text" class="cdt-input cdt-input-ro" value="${escapeHtml(c.name)}" readonly />
      </label>
      <label class="cdt-field">
        <span class="cdt-label">Subdomain</span>
        <input type="text" class="cdt-input cdt-input-ro" value="${escapeHtml(c.subdomain)}" readonly />
        <span class="cdt-sub">Path-based, collision-safe — fixed after creation.</span>
      </label>
      <label class="cdt-field">
        <span class="cdt-label">Plan tier</span>
        <input type="text" class="cdt-input cdt-input-ro" value="${escapeHtml(c.plan)}" readonly />
      </label>
      <p class="cdt-sub">Fields are read-only until the Track A reseller-settings
        endpoint lands — editing and Save activate together.</p>
    </div>
    <div class="cdt-danger">
      <div class="cdt-strong">Danger zone</div>
      <p class="cdt-sub">Suspending or removing a customer org is irreversible from here.</p>
      <button type="button" class="cdt-danger-btn" disabled
        title="Customer suspension lands with the Track A provisioning endpoint">Suspend customer</button>
    </div>
    <div class="cdt-actions">
      <button type="button" class="cdt-save" disabled
        title="Settings persistence lands with the Track A reseller-settings endpoint">Save changes</button>
    </div>
    ${seam('Mock-data-first. SWAP-IN CONTRACT: settings reads/writes MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
}

// ---- entrypoint ----------------------------------------------------------

export function renderCustomerTab(
  data: CustomerTabData,
): { body: string; pageScripts: string } {
  // Explicit per-tab dispatch — an unrecognized tab renders a neutral
  // "unknown tab" body rather than silently falling through to the
  // editable-looking Settings form.
  const body =
    data.tab === 'mcps' ? renderMcps(data)
    : data.tab === 'users' ? renderUsers(data)
    : data.tab === 'usage' ? renderUsage(data)
    : data.tab === 'tools' ? renderTools(data)
    : data.tab === 'audit' ? renderAudit(data)
    : data.tab === 'billing' ? renderBilling(data)
    : data.tab === 'settings' ? renderSettings(data)
    : renderChrome(data, '<p class="cdt-empty">Unknown tab.</p>');

  const pageScripts =
    data.tab === 'usage' ? usageScript(data.org.id, data.customer.id)
    : data.tab === 'audit' ? auditScript(data.org.id, data.customer.id)
    : '';

  return { body, pageScripts };
}

export const CUSTOMER_TAB_STYLES = `
  .cdt-breadcrumb {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: var(--text-tertiary); margin-bottom: 12px; flex-wrap: wrap;
  }
  .cdt-breadcrumb a { color: var(--text-tertiary); text-decoration: none; }
  .cdt-breadcrumb a:hover { color: var(--text-secondary); }
  .cdt-crumb-sep { color: var(--text-muted); }
  .cdt-crumb-current { color: var(--text-secondary); }
  .cdt-title { font-size: 24px; margin: 0 0 4px; }

  .cdt-section-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin: 28px 0 10px; }

  .cdt-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 16px; }
  .cdt-table th {
    text-align: left; padding: 8px 12px;
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-tertiary); border-bottom: 1px solid var(--border-secondary);
  }
  .cdt-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
  .cdt-strong { color: var(--text-primary); font-weight: 500; }
  .cdt-sub { font-size: 11px; color: var(--text-tertiary); }
  .cdt-num { text-align: right; font-variant-numeric: tabular-nums; }
  .cdt-activity { color: var(--text-tertiary); white-space: nowrap; }
  .cdt-empty { padding: 20px 12px; text-align: center; color: var(--text-tertiary); }
  .cdt-more { margin-top: 12px; font-size: 12px; color: var(--accent-text); }
  /* visually-hidden text — state cues for screen readers only */
  .cdt-sr {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }
  /* Narrow viewports: let wide tables scroll rather than overflow the page. */
  @media (max-width: 640px) {
    .cdt-table { display: block; overflow-x: auto; white-space: nowrap; }
  }

  .cdt-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .cdt-dot-healthy { background: var(--success); }
  .cdt-dot-degraded { background: var(--warning-text); }
  .cdt-dot-down { background: var(--error); }

  .cdt-loading { color: var(--text-tertiary); font-style: italic; padding: 16px 0; }
  .cdt-load-error { color: var(--error-text); font-style: normal; }
  .cdt-retry {
    margin-left: 4px; padding: 4px 12px;
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: 6px; color: var(--text-secondary);
    font-size: 12px; font-family: inherit; cursor: pointer;
  }
  .cdt-retry:hover { border-color: var(--accent); color: var(--accent-text); }
  .cdt-stat-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px; margin-top: 16px;
  }
  .cdt-stat { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px; }
  .cdt-stat-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-tertiary); margin-bottom: 8px;
  }
  .cdt-stat-value { font-size: 22px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }

  .cdt-toolbar { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
  .cdt-label { font-size: 12px; color: var(--text-tertiary); }
  .cdt-select {
    padding: 7px 12px; background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: 6px; color: var(--text-secondary); font-size: 12px;
  }
  .cdt-tool-group { margin-top: 18px; }
  .cdt-tool-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .cdt-tool-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; color: var(--text-primary); }
  .cdt-tool-off { color: var(--text-tertiary); }
  .cdt-box {
    width: 16px; height: 16px; border-radius: 3px; display: inline-flex;
    align-items: center; justify-content: center; font-size: 10px; color: #0a0a0a;
    border: 1px solid var(--border-secondary); background: var(--bg-card);
  }
  .cdt-box-on { background: var(--accent); border-color: var(--accent); }

  .cdt-empty-card {
    background: var(--bg-card); border: 1px solid var(--border-subtle);
    border-radius: 8px; padding: 24px; margin-top: 16px; max-width: 560px;
  }
  .cdt-empty-body {
    margin: 8px 0 0; color: var(--text-tertiary); font-size: 13px; line-height: 1.5;
  }

  .cdt-form { margin-top: 16px; max-width: 420px; }
  .cdt-field { display: block; margin-bottom: 16px; }
  .cdt-input {
    width: 100%; padding: 8px 12px; background: var(--bg-card);
    border: 1px solid var(--border-primary); border-radius: 6px;
    color: var(--text-primary); font-size: 13px; font-family: inherit;
  }
  .cdt-input-ro { color: var(--text-secondary); background: var(--border-subtle); cursor: default; }

  .cdt-danger {
    margin-top: 24px; padding: 16px; max-width: 420px;
    border: 1px solid var(--error); border-radius: 8px;
  }
  .cdt-danger-btn {
    margin-top: 10px; padding: 8px 14px; background: transparent;
    border: 1px solid var(--error); border-radius: 6px; color: var(--error);
    font-size: 12px; font-family: inherit; cursor: pointer;
  }
  .cdt-danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .cdt-actions { margin: 20px 0; }
  .cdt-save {
    padding: 9px 18px; background: var(--accent); color: #0a0a0a;
    font-size: 13px; font-weight: 600; font-family: inherit; border: none;
    border-radius: 6px; cursor: pointer;
  }
  .cdt-save:disabled { background: var(--border-secondary); color: var(--text-muted); cursor: not-allowed; }
`;
