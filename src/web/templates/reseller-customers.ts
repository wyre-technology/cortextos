import type { Organization } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

// Track C Surface 1 — Reseller Dashboard ("Customers" list).
// Figma design-of-record: tbaRrzQQqZTNZu2AelcIID node 1:2.
//
// Lists the customer organizations nested under a reseller org. Built
// mock-data-first (same play as the billing IA shell): the route handler
// passes mock `customers` until Hank's Track C customer-list endpoint
// lands, then the data source swaps and this template renders unchanged.

export type CustomerPlan = 'free' | 'pro' | 'business';

export interface ResellerCustomer {
  id: string;
  name: string;
  /** White-label per-customer subdomain (Figma surfaces it inline). */
  subdomain: string;
  plan: CustomerPlan;
  userCount: number;
  /** Primary usage metric per the Figma — MCP calls over the last 30 days. */
  mcpCalls30d: number;
  /** ISO 8601 — last activity timestamp; rendered relative. */
  lastActivity: string;
}

export interface ResellerCustomersData {
  org: Organization;
  customers: ResellerCustomer[];
}

const PLAN_LABEL: Record<CustomerPlan, string> = {
  free: 'FREE',
  pro: 'PRO',
  business: 'BUSINESS',
};

function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffMs = Math.max(0, now.getTime() - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function renderPlanBadge(plan: CustomerPlan): string {
  return `<span class="rc-plan rc-plan-${escapeHtml(plan)}">${escapeHtml(PLAN_LABEL[plan])}</span>`;
}

/**
 * Per-row action triad (Figma open-question #3 resolved to inline-always).
 * Open (→) is a live link now that Surface 2 (Customer Detail) has
 * landed; impersonate and more-actions stay disabled — they route
 * through follow-up surfaces, so no dead-link.
 */
function renderRowActions(customer: ResellerCustomer): string {
  const name = escapeHtml(customer.name);
  const href = `/org/customers/${encodeURIComponent(customer.id)}`;
  return `
    <div class="rc-actions">
      <a class="rc-action" href="${escapeHtml(href)}" title="Open customer detail" aria-label="Open ${name}">→</a>
      <button type="button" class="rc-action" disabled title="Impersonate for support — lands in a follow-up" aria-label="Impersonate a user at ${name}">&#128100;</button>
      <button type="button" class="rc-action" disabled title="More actions — lands in a follow-up" aria-label="More actions for ${name}">&#8943;</button>
    </div>`;
}

function renderRow(c: ResellerCustomer): string {
  const name = escapeHtml(c.name);
  return `
    <tr class="rc-row" data-name="${escapeHtml(c.name.toLowerCase())}" data-plan="${escapeHtml(c.plan)}">
      <td class="rc-cell-customer">
        <div class="rc-name">${name}</div>
        <div class="rc-sub">${escapeHtml(formatRelativeTime(c.lastActivity))} · ${escapeHtml(c.subdomain)}</div>
      </td>
      <td data-label="Plan">${renderPlanBadge(c.plan)}</td>
      <td class="rc-num" data-label="Users">${c.userCount.toLocaleString()}</td>
      <td class="rc-num" data-label="MCP Calls (30d)">${c.mcpCalls30d.toLocaleString()}</td>
      <td class="rc-activity" data-label="Last Activity">${escapeHtml(formatRelativeTime(c.lastActivity))}</td>
      <td>${renderRowActions(c)}</td>
    </tr>`;
}

export function renderResellerCustomers(data: ResellerCustomersData): string {
  const { org, customers } = data;
  const orgName = escapeHtml(org.name);
  const count = customers.length;

  const rows = customers.length > 0
    ? customers.map(renderRow).join('')
    : `<tr><td colspan="6" class="rc-empty">No customer organizations yet.</td></tr>`;

  return `
    <div class="rc-header">
      <div>
        <h1 style="margin-bottom:4px">Customers</h1>
        <p class="section-desc">Customer organizations under ${orgName} · ${count} active</p>
      </div>
      <a class="rc-add-btn" href="/org/customers/new">+ Add Customer</a>
    </div>

    <div class="rc-toolbar">
      <input type="text" id="rcSearch" class="rc-search" placeholder="Search customers…"
        oninput="rcFilter()" aria-label="Search customers" />
      <select id="rcPlanFilter" class="rc-select" onchange="rcFilter()" aria-label="Filter by plan">
        <option value="all">Plan: All</option>
        <option value="business">Business</option>
        <option value="pro">Pro</option>
        <option value="free">Free</option>
      </select>
      <select id="rcStatusFilter" class="rc-select" aria-label="Filter by status" disabled
        title="Status filtering lands with the Track A customer-status field">
        <option value="active">Status: Active</option>
      </select>
    </div>

    <table class="rc-table">
      <thead>
        <tr>
          <th>Customer</th>
          <th>Plan</th>
          <th>Users</th>
          <th>MCP Calls (30d)</th>
          <th>Last Activity</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="rcRows">
        ${rows}
      </tbody>
    </table>
    <p class="rc-empty-filtered" id="rcNoMatch" role="status" aria-live="polite" hidden>No customers match your filters.</p>

    <p class="ia-shell-note">
      Customer detail, onboarding, and impersonation route through follow-up
      Track C surfaces. This dashboard renders mock data until the Track A
      customer-list endpoint lands.
    </p>
  `;
}

export const RESELLER_CUSTOMERS_SCRIPT = `
<script>
  function rcFilter() {
    var q = (document.getElementById('rcSearch').value || '').trim().toLowerCase();
    var plan = document.getElementById('rcPlanFilter').value;
    var rows = document.querySelectorAll('#rcRows .rc-row');
    var shown = 0;
    rows.forEach(function (row) {
      var matchName = !q || (row.getAttribute('data-name') || '').indexOf(q) !== -1;
      var matchPlan = plan === 'all' || row.getAttribute('data-plan') === plan;
      var visible = matchName && matchPlan;
      row.style.display = visible ? '' : 'none';
      if (visible) shown++;
    });
    var noMatch = document.getElementById('rcNoMatch');
    if (noMatch) noMatch.hidden = shown !== 0;
  }
</script>
`;

export const RESELLER_CUSTOMERS_STYLES = `
  .rc-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .rc-add-btn {
    flex-shrink: 0;
    display: inline-block;
    padding: 9px 16px;
    background: var(--accent);
    color: #0a0a0a;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-decoration: none;
  }

  .rc-toolbar {
    display: flex;
    gap: 12px;
    margin: 24px 0 16px;
    flex-wrap: wrap;
  }
  .rc-search {
    flex: 1;
    min-width: 220px;
    max-width: 360px;
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
  }
  .rc-search::placeholder { color: var(--text-muted); }
  .rc-select {
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
  }
  .rc-select:disabled { color: var(--text-muted); cursor: not-allowed; }

  .rc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .rc-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--border-secondary);
  }
  .rc-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    vertical-align: middle;
  }
  .rc-name {
    font-weight: 500;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .rc-sub {
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-tertiary);
  }
  .rc-num { font-variant-numeric: tabular-nums; }
  .rc-activity { color: var(--text-tertiary); white-space: nowrap; }
  .rc-empty, .rc-empty-filtered {
    padding: 24px 12px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .rc-plan {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 10px;
    border-radius: 11px;
    border: 1px solid transparent;
  }
  .rc-plan-business {
    border-color: var(--accent);
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.08);
  }
  .rc-plan-pro {
    border-color: var(--border-hover);
    color: var(--text-secondary);
  }
  .rc-plan-free {
    border-color: var(--border-tertiary);
    color: var(--text-tertiary);
  }

  .rc-actions { display: flex; gap: 6px; }
  .rc-action {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
  }
  a.rc-action:hover { border-color: var(--accent); color: var(--accent-text); }
  .rc-action:disabled { color: var(--text-muted); cursor: not-allowed; }

  @media (max-width: 720px) {
    .rc-table thead { display: none; }
    .rc-table tr { display: block; margin-bottom: 12px; border: 1px solid var(--border-subtle); border-radius: 8px; }
    .rc-table td { display: flex; justify-content: space-between; align-items: center; border: none; }
    /* Restore the column identity the hidden <thead> would have carried. */
    .rc-table td[data-label]::before {
      content: attr(data-label);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-tertiary);
    }
  }
`;
