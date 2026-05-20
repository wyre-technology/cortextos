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
export interface InvoiceRow {
  number: string;
  date: string;
  amount: string;
  status: 'paid' | 'open' | 'void';
}

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
  billingPlan: string;
  billingRate: string;
  invoices: InvoiceRow[];
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
  return `
    <nav class="cdt-breadcrumb" aria-label="Breadcrumb">
      <span>${escapeHtml(org.name)}</span>
      <span class="cdt-crumb-sep">/</span>
      <a href="/org/customers">Customers</a>
      <span class="cdt-crumb-sep">/</span>
      <a href="${base}">${name}</a>
      <span class="cdt-crumb-sep">/</span>
      <span class="cdt-crumb-current">${escapeHtml(TAB_TITLE[tab])}</span>
    </nav>
    <h1 class="cdt-title">${escapeHtml(TAB_TITLE[tab])}</h1>
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

// ---- tab: Audit Log ------------------------------------------------------

function renderAudit(data: CustomerTabData): string {
  const rows = data.audit.map((a) => `
    <tr>
      <td class="cdt-activity">${escapeHtml(a.when)}</td>
      <td>${escapeHtml(a.actor)}</td>
      <td class="cdt-strong">${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.target)}</td>
    </tr>`).join('');
  return renderChrome(data, `
    <table class="cdt-table">
      <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="cdt-empty">No audit events.</td></tr>`}</tbody>
    </table>
    ${seam('Mock-data-first. SWAP-IN CONTRACT: the audit query MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
}

// ---- tab: Billing --------------------------------------------------------

function renderBilling(data: CustomerTabData): string {
  const badge: Record<InvoiceRow['status'], string> = {
    paid: 'cdt-inv-paid', open: 'cdt-inv-open', void: 'cdt-inv-void',
  };
  const rows = data.invoices.map((i) => `
    <tr>
      <td class="cdt-strong">${escapeHtml(i.number)}</td>
      <td>${escapeHtml(i.date)}</td>
      <td class="cdt-num">${escapeHtml(i.amount)}</td>
      <td><span class="cdt-inv ${badge[i.status]}">${escapeHtml(i.status)}</span></td>
    </tr>`).join('');
  return renderChrome(data, `
    <div class="cdt-card">
      <div class="cdt-card-label">Current plan</div>
      <div class="cdt-card-value">${escapeHtml(data.billingPlan)}</div>
      <div class="cdt-sub">${escapeHtml(data.billingRate)}</div>
    </div>
    <h2 class="cdt-section-title">Invoices</h2>
    <table class="cdt-table">
      <thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th class="cdt-num" scope="col">Amount</th><th scope="col">Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="cdt-empty">No invoices yet.</td></tr>`}</tbody>
    </table>
    ${seam('Mock-data-first (reseller pricing/invoice migrations 025-027 exist; no read endpoint yet). SWAP-IN CONTRACT: the billing read MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).')}`);
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

  const pageScripts = data.tab === 'usage'
    ? usageScript(data.org.id, data.customer.id)
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

  .cdt-inv {
    display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 2px 8px; border-radius: 10px; border: 1px solid transparent;
  }
  .cdt-inv-paid { color: var(--success); border-color: var(--success); }
  .cdt-inv-open { color: var(--warning-text); border-color: var(--warning-text); }
  .cdt-inv-void { color: var(--text-tertiary); border-color: var(--border-secondary); }

  .cdt-card {
    background: var(--bg-card); border: 1px solid var(--border-subtle);
    border-radius: 8px; padding: 18px; margin-top: 16px; max-width: 320px;
  }
  .cdt-card-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-tertiary); margin-bottom: 8px;
  }
  .cdt-card-value { font-size: 20px; font-weight: 700; color: var(--text-primary); }

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
