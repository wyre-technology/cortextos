import type { Organization } from '../../org/org-service.js';
import type { PlanDefinition } from '../../billing/plan-catalog.js';
import { escapeHtml } from '../helpers.js';

// Track-B IA shell. Render contract is the swap-in target for Hank's
// Track-A Stripe foundation: when real customer/subscription/invoice
// data lands, routes.ts replaces the mock builders with service calls
// and this template renders unchanged.
//
// Sections (top-to-bottom) telegraph the four surfaces Aaron can pick
// from for deepening: current plan + plan-change, seats, payment
// method, invoice history. Each section is independently fillable.

export interface PaymentMethodView {
  brand: string;          // 'visa' | 'mastercard' | 'amex' | ...
  last4: string;
  expMonth: number;       // 1-12
  expYear: number;        // 4-digit
}

export interface NextInvoiceView {
  amountCents: number;
  currency: string;       // ISO 4217 (lowercase per Stripe convention)
  dueDate: string;        // ISO 8601 date
}

export type InvoiceStatus = 'paid' | 'open' | 'void' | 'uncollectible';

export interface InvoiceView {
  id: string;
  number: string;
  date: string;           // ISO 8601 date
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  pdfUrl: string | null;
}

export interface TeamBillingData {
  org: Organization;
  plan: PlanDefinition;
  memberCount: number;
  creditsUsed: number;
  creditsAllocated: number;
  paymentMethod: PaymentMethodView | null;
  nextInvoice: NextInvoiceView | null;
  invoices: InvoiceView[];
}

function formatMoney(amountCents: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
  return formatter.format(amountCents / 100);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderPlanBadge(planSlug: string, planName: string): string {
  // free/pro classes exist in shared styles.ts; business style is
  // scoped here until shared styles get a .plan-badge.business token.
  const label = escapeHtml(planName);
  return `<span class="plan-badge ${escapeHtml(planSlug)}">${label}</span>`;
}

function renderSeats(memberCount: number, maxMembers: number): string {
  const limit = maxMembers === Infinity ? 'unlimited' : String(maxMembers);
  const noun = memberCount === 1 ? 'member' : 'members';
  return `${memberCount} ${noun} <span class="seat-limit">/ ${escapeHtml(limit)}</span>`;
}

function renderCredits(used: number, allocated: number): string {
  const pct = allocated > 0 ? Math.min(100, Math.round((used / allocated) * 100)) : 0;
  return `
    <div class="usage-bar-track" aria-label="Credit usage">
      <div class="usage-bar-fill" style="width:${pct}%"></div>
    </div>
    <div class="usage-numbers">
      <strong>${used.toLocaleString()}</strong> of ${allocated.toLocaleString()} credits used this month
    </div>
  `;
}

function renderPaymentMethod(pm: PaymentMethodView | null): string {
  if (!pm) {
    return `
      <p class="section-desc">No payment method on file.</p>
      <button type="button" class="btn-upgrade" disabled title="Stripe portal redirect lands with Track A">
        Add payment method
      </button>
    `;
  }
  const exp = String(pm.expMonth).padStart(2, '0') + '/' + String(pm.expYear).slice(-2);
  return `
    <div class="pm-row">
      <span class="pm-brand">${escapeHtml(pm.brand.toUpperCase())}</span>
      <span class="pm-last4">•••• ${escapeHtml(pm.last4)}</span>
      <span class="pm-exp">exp ${escapeHtml(exp)}</span>
    </div>
    <button type="button" class="btn-text" disabled title="Stripe portal redirect lands with Track A">
      Update payment method
    </button>
  `;
}

function renderInvoiceRow(inv: InvoiceView): string {
  return `
    <tr>
      <td>${escapeHtml(inv.number)}</td>
      <td>${escapeHtml(formatDate(inv.date))}</td>
      <td class="invoice-amount">${escapeHtml(formatMoney(inv.amountCents, inv.currency))}</td>
      <td><span class="invoice-status invoice-status-${escapeHtml(inv.status)}">${escapeHtml(inv.status)}</span></td>
      <td>${inv.pdfUrl
        ? `<a href="${escapeHtml(inv.pdfUrl)}" target="_blank" rel="noopener noreferrer">PDF</a>`
        : '<span class="text-muted">—</span>'}</td>
    </tr>
  `;
}

function renderInvoices(invoices: InvoiceView[]): string {
  if (invoices.length === 0) {
    return `<p class="section-desc">No invoices yet.</p>`;
  }
  return `
    <table class="invoice-table">
      <thead>
        <tr>
          <th>Invoice</th>
          <th>Date</th>
          <th>Amount</th>
          <th>Status</th>
          <th>PDF</th>
        </tr>
      </thead>
      <tbody>
        ${invoices.map(renderInvoiceRow).join('')}
      </tbody>
    </table>
  `;
}

export function renderTeamBilling(data: TeamBillingData): string {
  const { org, plan, memberCount, creditsUsed, creditsAllocated, paymentMethod, nextInvoice, invoices } = data;
  const orgName = escapeHtml(org.name);
  const nextInvoiceBlock = nextInvoice
    ? `
      <div class="next-invoice">
        <div class="next-invoice-amount">${escapeHtml(formatMoney(nextInvoice.amountCents, nextInvoice.currency))}</div>
        <div class="next-invoice-due">due ${escapeHtml(formatDate(nextInvoice.dueDate))}</div>
      </div>`
    : `<p class="section-desc">No upcoming invoice.</p>`;

  return `
    <h1 style="margin-bottom:4px">Billing</h1>
    <p class="section-desc">${orgName} — ${renderPlanBadge(plan.slug, plan.name)}</p>

    <div class="billing-grid">
      <section class="billing-card">
        <h2 class="section-title">Current plan</h2>
        <p class="section-desc">${escapeHtml(plan.name)} plan, billed monthly.</p>
        <div class="plan-summary">
          <div class="plan-line"><span class="plan-line-label">Seats</span><span>${renderSeats(memberCount, plan.maxMembers)}</span></div>
          <div class="plan-line"><span class="plan-line-label">Credits</span><span>${creditsAllocated.toLocaleString()} / month</span></div>
          <div class="plan-line"><span class="plan-line-label">Rate limit</span><span>${plan.rateLimitPerHour.toLocaleString()} req/hr</span></div>
        </div>
        <button type="button" class="btn-upgrade" disabled title="Plan-change flow lands with Track A">
          Change plan
        </button>
      </section>

      <section class="billing-card">
        <h2 class="section-title">Next invoice</h2>
        ${nextInvoiceBlock}
      </section>

      <section class="billing-card">
        <h2 class="section-title">Usage this month</h2>
        ${renderCredits(creditsUsed, creditsAllocated)}
      </section>

      <section class="billing-card">
        <h2 class="section-title">Payment method</h2>
        ${renderPaymentMethod(paymentMethod)}
      </section>
    </div>

    <div class="org-section" style="margin-top:32px">
      <h2 class="section-title">Invoice history</h2>
      ${renderInvoices(invoices)}
    </div>

    <p class="ia-shell-note">
      Plan changes, payment-method updates, and invoice downloads route through Stripe Customer Portal — wiring lands with Track A.
    </p>
  `;
}

export const TEAM_BILLING_STYLES = `
  .billing-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-top: 24px;
  }
  @media (max-width: 720px) {
    .billing-grid { grid-template-columns: 1fr; }
  }
  .billing-card {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 20px;
  }
  .billing-card .section-title {
    margin-bottom: 8px;
  }
  .plan-badge.business {
    background: rgba(0, 201, 219, 0.22);
    color: var(--accent-text);
  }
  .plan-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 16px 0;
    font-size: 13px;
  }
  .plan-line {
    display: flex;
    justify-content: space-between;
    color: var(--text-secondary);
  }
  .plan-line-label {
    color: var(--text-tertiary);
  }
  .seat-limit { color: var(--text-tertiary); }
  .next-invoice-amount {
    font-family: var(--font-heading);
    font-size: 28px;
    font-weight: 600;
    color: var(--text-heading);
  }
  .next-invoice-due {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text-tertiary);
  }
  .usage-bar-track {
    width: 100%;
    height: 8px;
    background: var(--border-subtle);
    border-radius: 4px;
    overflow: hidden;
    margin: 12px 0 8px;
  }
  .usage-bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  .usage-numbers {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .pm-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin: 12px 0;
    font-size: 14px;
  }
  .pm-brand {
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: 0.04em;
  }
  .pm-last4 {
    color: var(--text-secondary);
    font-family: var(--font-body);
  }
  .pm-exp {
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .btn-text {
    background: none;
    border: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .btn-text:disabled {
    color: var(--text-muted);
    cursor: not-allowed;
    text-decoration: none;
  }
  .btn-upgrade:disabled {
    background: var(--border-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
  }
  .invoice-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 12px;
  }
  .invoice-table th {
    text-align: left;
    padding: 8px 12px;
    font-weight: 600;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--border-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 11px;
  }
  .invoice-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  .invoice-amount { font-variant-numeric: tabular-nums; }
  .invoice-status {
    display: inline-block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .invoice-status-paid { background: rgba(0, 201, 219, 0.15); color: var(--accent-text); }
  .invoice-status-open { background: var(--border-tertiary); color: var(--text-secondary); }
  .invoice-status-void,
  .invoice-status-uncollectible { background: var(--border-tertiary); color: var(--text-muted); }
  .text-muted { color: var(--text-muted); }
  .ia-shell-note {
    margin-top: 24px;
    padding: 12px 16px;
    background: var(--bg-card);
    border: 1px dashed var(--border-primary);
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-tertiary);
  }
`;
