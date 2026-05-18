import type { Organization } from '../../org/org-service.js';
import type { PlanDefinition } from '../../billing/plan-catalog.js';
import { escapeHtml } from '../helpers.js';
import {
  ICON_INFO,
  ICON_WARN,
  ICON_URGENT,
  ICON_PAUSE,
  ICON_CHECK,
  ICON_DISMISS,
} from '../icons.js';

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
  /** Always present, defaults to `{ state: 'none' }`. */
  dunning: DunningView;
  /** First name for personalised copy; null falls back to "there". */
  firstName: string | null;
  /**
   * One-off credit-pack sizes purchasable right now — only the packs with a
   * configured Stripe price ID. Empty => the Buy-credits section is hidden.
   */
  availableCreditPacks: number[];
}

// =============================================================================
// Dunning state — discriminated union per Ruby's checkpoint-5 spec.
// Each state carries only the fields it needs; switching against `.state`
// gives the type system enough info to enforce exhaustiveness via
// assertNever() defaults.
// =============================================================================

export type DunningStateName =
  | 'none'
  | 'payment-failing'
  | 'past-due'
  | 'final-warning'
  | 'suspended'
  | 'recovered';

export interface DunningStateNone { state: 'none'; }

export interface DunningStateActive {
  state: 'payment-failing' | 'past-due';
  firstFailDate: string;
  attemptCount: number;
  nextRetryDate: string | null;
  cardBrand: string;
  cardLast4: string;
  amountCents: number;
  currency: string;
}

export interface DunningStateFinalWarning {
  state: 'final-warning';
  firstFailDate: string;
  attemptCount: number;
  /** Derived from stripe_final_retry + 7 WYRE-grace days. */
  serviceEndDate: string;
  cardBrand: string;
  cardLast4: string;
  amountCents: number;
  currency: string;
}

export interface DunningStateSuspended {
  state: 'suspended';
  firstFailDate: string;
  attemptCount: number;
  suspendedAt: string;
  cardBrand: string;
  cardLast4: string;
}

export interface DunningStateRecovered {
  state: 'recovered';
  /** Route handler collapses to `none` if older than 1h. */
  recoveredAt: string;
  amountCents: number;
  currency: string;
  nextChargeDate: string;
}

export type DunningView =
  | DunningStateNone
  | DunningStateActive
  | DunningStateFinalWarning
  | DunningStateSuspended
  | DunningStateRecovered;

function assertNever(x: never): never {
  throw new Error('Unhandled dunning state: ' + JSON.stringify(x));
}

// =============================================================================
// Dunning helpers
// =============================================================================

function hoursUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return Infinity;
  return Math.max(0, (target - Date.now()) / (60 * 60 * 1000));
}

function formatCountdown(serviceEndDate: string): string {
  const hours = hoursUntil(serviceEndDate);
  if (hours <= 48) return `${Math.ceil(hours)}h`;
  const days = Math.floor(hours / 24);
  const remHours = Math.floor(hours % 24);
  return `${days}d ${remHours}h`;
}

/** 0 at start of WYRE-grace (day 7), 100 at the suspension moment. */
function computeCountdownFillPct(serviceEndDate: string): number {
  const totalGraceHours = 7 * 24;
  const remaining = hoursUntil(serviceEndDate);
  const consumed = Math.max(0, totalGraceHours - remaining);
  return Math.min(100, Math.round((consumed / totalGraceHours) * 100));
}

interface DunningBannerCopy { line1: string; line2: string; }

function dunningBannerCopy(
  d: DunningStateActive | DunningStateFinalWarning,
): DunningBannerCopy {
  const last4 = d.cardLast4;
  switch (d.state) {
    case 'payment-failing':
      return {
        line1: `We weren't able to charge your card ending •• ${last4}.`,
        line2: d.nextRetryDate
          ? `We'll try again on ${formatDate(d.nextRetryDate)} — your service is still on.`
          : `Your service is still on.`,
      };
    case 'past-due':
      return {
        line1: `Your card on file is still being declined.`,
        line2: `Service stays on while we keep trying — many cards recover within a few days.`,
      };
    case 'final-warning': {
      const remaining = formatCountdown(d.serviceEndDate);
      return {
        line1: `Service pauses in ${remaining} unless your card updates.`,
        line2: `Your data, team, and settings stay preserved — turning service back on just needs a working card.`,
      };
    }
  }
}

// =============================================================================
// Dunning render functions
// =============================================================================

const UPDATE_PAYMENT_URL = '/org/billing/update-payment-method';

export function renderDunningChip(dunning: DunningView): string {
  switch (dunning.state) {
    case 'none':
    case 'suspended':
    case 'recovered':
      return '';
    case 'payment-failing':
      return `<span class="dunning-chip dunning-chip--info">Charge didn't go through</span>`;
    case 'past-due':
      return `<span class="dunning-chip dunning-chip--warn">Past due</span>`;
    case 'final-warning':
      return `<span class="dunning-chip dunning-chip--warn">Service pausing soon</span>`;
    default:
      return assertNever(dunning);
  }
}

export function renderCountdownWidget(serviceEndDate: string, urgent: boolean): string {
  const fillPct = computeCountdownFillPct(serviceEndDate);
  const display = formatCountdown(serviceEndDate);
  const variant = urgent ? 'urgent' : 'warn';
  return `
    <div class="dunning-countdown dunning-countdown--${variant}"
         data-service-end="${escapeHtml(serviceEndDate)}">
      <div class="dunning-countdown__track">
        <div class="dunning-countdown__fill" style="width:${fillPct}%"></div>
      </div>
      <div class="dunning-countdown__digits">${escapeHtml('Service pauses in ' + display)}</div>
    </div>
  `;
}

export function renderDunningBanner(
  dunning: DunningView,
  _firstName: string | null,
): string {
  if (dunning.state === 'none' || dunning.state === 'suspended' || dunning.state === 'recovered') {
    return '';
  }

  const isLastFortyEight =
    dunning.state === 'final-warning' && hoursUntil(dunning.serviceEndDate) <= 48;

  let surface: 'info' | 'warn' | 'urgent';
  let icon: string;
  if (dunning.state === 'payment-failing') {
    surface = 'info';
    icon = ICON_INFO;
  } else if (dunning.state === 'past-due') {
    surface = 'warn';
    icon = ICON_WARN;
  } else {
    surface = isLastFortyEight ? 'urgent' : 'warn';
    icon = isLastFortyEight ? ICON_URGENT : ICON_WARN;
  }

  const copy = dunningBannerCopy(dunning);
  const cta = `<a href="${UPDATE_PAYMENT_URL}" class="btn-primary dunning-banner__cta-link">Update payment method →</a>`;
  const countdown = dunning.state === 'final-warning'
    ? renderCountdownWidget(dunning.serviceEndDate, isLastFortyEight)
    : '';

  return `
    <div class="dunning-banner dunning-banner--${surface}" role="status" aria-live="polite">
      <div class="dunning-banner__body">
        <span class="dunning-banner__icon">${icon}</span>
        <div class="dunning-banner__copy">
          <div class="dunning-banner__line1">${escapeHtml(copy.line1)}</div>
          <div class="dunning-banner__line2">${escapeHtml(copy.line2)}</div>
        </div>
        <div class="dunning-banner__cta">${cta}</div>
      </div>
      ${countdown}
    </div>
  `;
}

export function renderSuspendedView(
  dunning: DunningStateSuspended,
  _firstName: string | null,
): string {
  return `
    <div class="suspended-card">
      <div class="suspended-card__icon">${ICON_PAUSE}</div>
      <h1 class="suspended-card__title">Your service is paused</h1>
      <p class="suspended-card__subhead">
        Updating your card on file will turn it back on right away.
      </p>
      <p class="suspended-card__body">
        We weren't able to charge your ${escapeHtml(dunning.cardBrand)} ending •• ${escapeHtml(dunning.cardLast4)} after ${dunning.attemptCount} attempts. Your data, your team, and your settings are all preserved — we just need a working card to resume.
      </p>
      <a href="${UPDATE_PAYMENT_URL}" class="btn-primary suspended-card__cta">
        Update payment method
      </a>
      <a href="#invoice-history" class="link-secondary suspended-card__secondary">
        View invoice history →
      </a>
      <p class="suspended-card__footnote">
        Need help? <a href="/contact-support">Contact support →</a>
      </p>
    </div>
  `;
}

export function renderRecoveredToast(dunning: DunningStateRecovered): string {
  // Discriminator parameter is kept (vs ignored) so future copy can pivot on
  // amount/date without changing the function signature.
  void dunning;
  return `
    <div class="dunning-toast dunning-toast--success"
         data-auto-dismiss="8000"
         role="status"
         aria-live="polite">
      <div class="dunning-toast__icon">${ICON_CHECK}</div>
      <div class="dunning-toast__body">
        <div class="dunning-toast__title">You're set.</div>
        <div class="dunning-toast__subtitle">Card was charged successfully.</div>
      </div>
      <button type="button" class="dunning-toast__dismiss" aria-label="Dismiss">${ICON_DISMISS}</button>
    </div>
  `;
}

/** Tiny client script for the recovered toast: auto-dismiss + click-dismiss. */
export const DUNNING_TOAST_SCRIPT = `
<script>
  (function() {
    function dismiss(el) {
      el.classList.add('dunning-toast--dismissed');
      window.setTimeout(function () { el.remove(); }, 320);
    }
    document.querySelectorAll('.dunning-toast[data-auto-dismiss]').forEach(function (el) {
      var ms = parseInt(el.getAttribute('data-auto-dismiss') || '8000', 10);
      var btn = el.querySelector('.dunning-toast__dismiss');
      if (btn) btn.addEventListener('click', function () { dismiss(el); });
      window.setTimeout(function () { dismiss(el); }, ms);
    });
  })();
</script>
`;

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

/**
 * One-off credit-pack purchase cards (GAP-5). Each card POSTs the pack size
 * to /api/billing/checkout-credits and redirects to the returned Stripe
 * Checkout URL. Only packs with a configured price ID are passed in.
 */
function renderCreditPacks(orgId: string, packs: number[]): string {
  if (packs.length === 0) return '';
  const cards = packs
    .map(
      (n) => `
      <button type="button" class="credit-pack-card" data-credits="${n}">
        <span class="credit-pack-amount">${n.toLocaleString()}</span>
        <span class="credit-pack-label">credits</span>
      </button>`,
    )
    .join('');
  return `
    <section class="billing-card">
      <h2 class="section-title">Buy credits</h2>
      <p class="section-desc">
        One-off credit packs carry over and are used after your monthly plan
        allocation runs out.
      </p>
      <div class="credit-pack-grid">${cards}</div>
      <div class="credit-pack-status" id="creditPackStatus" role="status"></div>
    </section>
    <script>
      (function () {
        var orgId = ${JSON.stringify(orgId)};
        var status = document.getElementById('creditPackStatus');
        var cards = document.querySelectorAll('.credit-pack-card');
        function lock(on) {
          cards.forEach(function (c) {
            c.disabled = on;
            c.style.opacity = on ? '0.6' : '';
          });
        }
        cards.forEach(function (card) {
          card.addEventListener('click', async function () {
            var credits = parseInt(card.getAttribute('data-credits') || '0', 10);
            lock(true);
            status.textContent = 'Opening checkout…';
            try {
              var res = await fetch('/api/billing/checkout-credits', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ org_id: orgId, credits: credits }),
              });
              var data = await res.json().catch(function () { return {}; });
              if (res.ok && data.url) {
                window.location.href = data.url;
                return;
              }
              status.textContent = data.error || 'Could not start checkout.';
            } catch (e) {
              status.textContent = 'Could not start checkout.';
            }
            lock(false);
          });
        });
      })();
    </script>
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

/**
 * Top-level template for /org/billing.
 *
 * Branches on dunning state:
 *   - `suspended` → primary content (current plan / next invoice / usage /
 *     payment method) is replaced by `renderSuspendedView`. Invoice history
 *     stays at the bottom.
 *   - all other states → normal four-card layout. Dunning banner above the
 *     H1 (empty string when not applicable). Recovered toast appended at
 *     body-end (empty string when not applicable).
 */
export function renderTeamBilling(data: TeamBillingData): string {
  const { org, plan, memberCount, creditsUsed, creditsAllocated, paymentMethod, nextInvoice, invoices, dunning, firstName, availableCreditPacks } = data;
  const orgName = escapeHtml(org.name);

  const banner = renderDunningBanner(dunning, firstName);
  const toast = dunning.state === 'recovered' ? renderRecoveredToast(dunning) : '';

  if (dunning.state === 'suspended') {
    return `
      ${renderSuspendedView(dunning, firstName)}

      <div class="org-section" id="invoice-history" style="margin-top:32px">
        <h2 class="section-title">Invoice history</h2>
        ${renderInvoices(invoices)}
      </div>
    `;
  }

  const chip = renderDunningChip(dunning);
  const chipSlot = chip ? ` ${chip}` : '';

  const nextInvoiceBlock = nextInvoice
    ? `
      <div class="next-invoice">
        <div class="next-invoice-amount">${escapeHtml(formatMoney(nextInvoice.amountCents, nextInvoice.currency))}</div>
        <div class="next-invoice-due">due ${escapeHtml(formatDate(nextInvoice.dueDate))}</div>
      </div>`
    : `<p class="section-desc">No upcoming invoice.</p>`;

  return `
    ${banner}

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
        <h2 class="section-title">Next invoice${chipSlot}</h2>
        ${nextInvoiceBlock}
      </section>

      <section class="billing-card">
        <h2 class="section-title">Usage this month</h2>
        ${renderCredits(creditsUsed, creditsAllocated)}
      </section>

      ${renderCreditPacks(org.id, availableCreditPacks)}

      <section class="billing-card">
        <h2 class="section-title">Payment method</h2>
        ${renderPaymentMethod(paymentMethod)}
      </section>
    </div>

    <div class="org-section" id="invoice-history" style="margin-top:32px">
      <h2 class="section-title">Invoice history</h2>
      ${renderInvoices(invoices)}
    </div>

    <p class="ia-shell-note">
      Plan changes, payment-method updates, and invoice downloads route through Stripe Customer Portal — wiring lands with Track A.
    </p>

    ${toast}
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

  /* ===== Dunning ===== */
  /* Per-state surface colors. Cyan (info) reaches into the existing
     --accent palette; amber (warn) and red-but-calm (urgent) are inline
     tokens tuned for both light + dark layouts. */
  .dunning-banner {
    margin-bottom: 16px;
    border-radius: 8px;
    overflow: hidden;
  }
  .dunning-banner--info {
    background: rgba(0, 201, 219, 0.10);
    border: 1px solid rgba(0, 201, 219, 0.30);
  }
  .dunning-banner--warn {
    background: rgba(245, 158, 11, 0.10);
    border: 1px solid rgba(245, 158, 11, 0.30);
  }
  .dunning-banner--urgent {
    background: rgba(220, 38, 38, 0.10);
    border: 1px solid rgba(220, 38, 38, 0.35);
  }
  .dunning-banner__body {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
  }
  .dunning-banner__icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: var(--text-primary);
  }
  .dunning-banner--info  .dunning-banner__icon { color: var(--accent-text); }
  .dunning-banner--warn  .dunning-banner__icon { color: #f59e0b; }
  .dunning-banner--urgent .dunning-banner__icon { color: #dc2626; }
  .dunning-banner__copy { flex: 1; min-width: 0; }
  .dunning-banner__line1 {
    font-size: 15px;
    font-weight: 500;
    color: var(--text-primary);
  }
  .dunning-banner__line2 {
    margin-top: 2px;
    font-size: 14px;
    color: var(--text-secondary);
  }
  .dunning-banner__cta { flex-shrink: 0; }
  .dunning-banner__cta-link {
    display: inline-flex;
    align-items: center;
    padding: 8px 14px;
    background: var(--accent);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
    white-space: nowrap;
  }
  .dunning-banner__cta-link:hover { background: var(--accent-hover); }

  .dunning-countdown {
    padding: 8px 16px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .dunning-countdown__track {
    flex: 1;
    height: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    overflow: hidden;
  }
  .dunning-countdown--warn .dunning-countdown__fill {
    height: 100%;
    background: #f59e0b;
    transition: width 0.3s ease;
  }
  .dunning-countdown--urgent .dunning-countdown__fill {
    height: 100%;
    background: #dc2626;
    transition: width 0.3s ease;
  }
  .dunning-countdown__digits {
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .dunning-chip {
    display: inline-block;
    margin-left: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    border-radius: 3px;
    vertical-align: middle;
  }
  .dunning-chip--info {
    background: rgba(0, 201, 219, 0.15);
    color: var(--accent-text);
  }
  .dunning-chip--warn {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  /* Suspended full-page card */
  .suspended-card {
    max-width: 480px;
    margin: 32px auto;
    padding: 32px 24px;
    text-align: center;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 12px;
  }
  .suspended-card__icon {
    display: inline-flex;
    margin-bottom: 16px;
    color: #f59e0b;
  }
  .suspended-card__title {
    font-family: var(--font-heading);
    font-size: 28px;
    font-weight: 600;
    color: var(--text-heading);
    margin: 0 0 8px;
  }
  .suspended-card__subhead {
    font-size: 16px;
    color: var(--text-primary);
    margin: 0 0 16px;
  }
  .suspended-card__body {
    font-size: 14px;
    line-height: 1.55;
    color: var(--text-secondary);
    margin: 0 0 20px;
  }
  .suspended-card__cta {
    display: inline-block;
    width: 100%;
    box-sizing: border-box;
    padding: 12px 16px;
    background: var(--accent);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
  }
  .suspended-card__cta:hover { background: var(--accent-hover); }
  .suspended-card__secondary {
    display: block;
    margin-top: 12px;
    font-size: 13px;
    color: var(--accent-text);
    text-decoration: none;
  }
  .suspended-card__secondary:hover { text-decoration: underline; }
  .suspended-card__footnote {
    margin: 20px 0 0;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .suspended-card__footnote a {
    color: var(--accent-text);
    text-decoration: none;
  }
  .suspended-card__footnote a:hover { text-decoration: underline; }
  .link-secondary { color: var(--accent-text); }

  /* Recovered toast */
  .dunning-toast {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 380px;
    padding: 12px 14px;
    background: var(--bg-card);
    border: 1px solid rgba(16, 185, 129, 0.35);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    transition: opacity 0.3s ease, transform 0.3s ease;
  }
  .dunning-toast--success .dunning-toast__icon {
    color: #10b981;
    display: flex;
  }
  .dunning-toast__body { flex: 1; min-width: 0; }
  .dunning-toast__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .dunning-toast__subtitle {
    font-size: 13px;
    color: var(--text-secondary);
    margin-top: 1px;
  }
  .dunning-toast__dismiss {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    border-radius: 4px;
  }
  .dunning-toast__dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .dunning-toast--dismissed {
    opacity: 0;
    transform: translateY(-8px);
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .dunning-toast { transition: opacity 0s, transform 0s; }
    .dunning-countdown__fill { transition: width 0s; }
  }

  @media (max-width: 640px) {
    .dunning-banner__body {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }
    .dunning-banner__cta-link { width: 100%; justify-content: center; }
    .dunning-toast {
      left: 16px;
      right: 16px;
      max-width: none;
    }
  }

  /* Credit-pack purchase cards (GAP-5) */
  .credit-pack-grid {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .credit-pack-card {
    flex: 1 1 120px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 16px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elevated, #fff);
    cursor: pointer;
    font: inherit;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .credit-pack-card:hover:not(:disabled) {
    border-color: var(--accent, #2563eb);
    background: var(--bg-muted, #f4f4f5);
  }
  .credit-pack-card:disabled { cursor: default; }
  .credit-pack-amount { font-size: 20px; font-weight: 700; }
  .credit-pack-label { font-size: 12px; color: var(--text-muted); }
  .credit-pack-status { font-size: 13px; color: var(--text-muted); margin-top: 8px; min-height: 18px; }
`;
