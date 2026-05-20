import type { Organization } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

// Track C Area 2 — Sub-customer onboarding / provisioning wizard
// (/org/customers/new). No Figma design-of-record — this surface was
// scoped in 2026-05-19-subtenant-uiux-scope-plan.md and designed here.
//
// A reseller admin creates a new customer org under their reseller:
// identity (name + collision-safe subdomain + plan), ownership (initial
// admin invite), and branding defaults. 3-step wizard, reusing the S3
// (reseller-onboard-mcp.ts) wizard chrome idiom — stepper, banner,
// Next/Back links — for console consistency.
//
// Mock-data-first, like S1/S3/S4/S5: `?step=1..3` selects the body, the
// fields render a coherent example draft, and the final "Create
// customer" CTA is DISABLED — there is no provisioning endpoint yet.
// That disabled CTA is the documented swap-in seam: when the Track A
// customer-provisioning endpoint lands, the wizard POSTs and the CTA
// activates, template otherwise unchanged.

export type NewCustomerStep = 1 | 2 | 3;

/** The customer-org being drafted — a fixed example for the mock-first flow. */
export interface NewCustomerDraft {
  name: string;
  /** Collision-safe path segment, derived from the name. */
  subdomain: string;
  plan: string;
  adminEmail: string;
  /** Inherit the reseller's white-label branding vs. set a custom accent. */
  inheritBranding: boolean;
  accent: string;
}

export interface NewCustomerData {
  /** The reseller org creating the customer. */
  org: Organization;
  step: NewCustomerStep;
  planTiers: string[];
  draft: NewCustomerDraft;
}

const STEP_LABELS: Record<NewCustomerStep, string> = {
  1: 'Customer',
  2: 'Admin',
  3: 'Review',
};

/**
 * Clamp a `?step=` query value to a valid step. Anything that is not
 * exactly "2" or "3" — including `parseInt`-salvageable garbage like
 * "3abc" or "2.9", arrays, and `undefined` — normalizes to step 1.
 */
export function coerceNewCustomerStep(raw: unknown): NewCustomerStep {
  if (typeof raw !== 'string') return 1;
  const s = raw.trim();
  if (s === '2') return 2;
  if (s === '3') return 3;
  return 1;
}

function stepPath(step: NewCustomerStep): string {
  return `/org/customers/new?step=${step}`;
}

function renderStepper(current: NewCustomerStep): string {
  const steps: NewCustomerStep[] = [1, 2, 3];
  return `
    <ol class="nc-stepper">
      ${steps.map((s) => {
        const state = s < current ? 'done' : s === current ? 'active' : 'pending';
        const marker = state === 'done' ? '&#10003;' : String(s);
        const aria = state === 'active' ? ' aria-current="step"' : '';
        const sr = state === 'done' ? ' (completed)' : state === 'active' ? ' (current step)' : '';
        return `
          <li class="nc-step nc-step-${state}"${aria}>
            <span class="nc-step-dot">${marker}</span>
            <span class="nc-step-label">${escapeHtml(STEP_LABELS[s])}<span class="nc-sr">${sr}</span></span>
          </li>`;
      }).join('')}
    </ol>`;
}

// ---- steps ---------------------------------------------------------------

function renderStep1(data: NewCustomerData): string {
  const { draft, planTiers } = data;
  const slug = escapeHtml(draft.subdomain);
  const resellerSlug = escapeHtml(
    data.org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
  );
  return `
    <h2 class="nc-q">Customer organization</h2>
    <p class="nc-q-sub">The new org's identity. The subdomain is path-based and
      collision-safe — derived from the name, editable.</p>

    <label class="nc-field">
      <span class="nc-label">Organization name</span>
      <input type="text" id="ncName" class="nc-input" value="${escapeHtml(draft.name)}"
        oninput="ncSyncSlug()" />
    </label>

    <label class="nc-field">
      <span class="nc-label">Subdomain</span>
      <input type="text" id="ncSlug" class="nc-input" value="${slug}" />
      <span class="nc-help">
        URL: conduit.wyre.ai/v1/mcp/${resellerSlug}/<span id="ncSlugEcho">${slug}</span>
      </span>
    </label>

    <label class="nc-field">
      <span class="nc-label">Plan tier</span>
      <select class="nc-select">
        ${planTiers.map((p) =>
          `<option${p === draft.plan ? ' selected' : ''}>${escapeHtml(p)}</option>`,
        ).join('')}
      </select>
    </label>

    <div class="nc-actions">
      <a class="nc-next" href="${stepPath(2)}">Next &rarr;</a>
    </div>`;
}

function renderStep2(data: NewCustomerData): string {
  const { draft } = data;
  return `
    <h2 class="nc-q">Initial admin</h2>
    <p class="nc-q-sub">Invite the first user — they become the owner of
      ${escapeHtml(draft.name)} and can invite the rest of the team.</p>

    <label class="nc-field">
      <span class="nc-label">Owner email</span>
      <input type="email" class="nc-input" value="${escapeHtml(draft.adminEmail)}"
        placeholder="admin@customer.com" />
      <span class="nc-help">An invite is sent on create; the owner sets their
        own password via the link.</span>
    </label>

    <div class="nc-actions nc-actions-split">
      <a class="nc-back" href="${stepPath(1)}">&larr; Back</a>
      <a class="nc-next" href="${stepPath(3)}">Next &rarr;</a>
    </div>`;
}

function renderStep3(data: NewCustomerData): string {
  const { draft, org } = data;
  const resellerSlug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const summary: Array<[string, string]> = [
    ['Organization', draft.name],
    ['Subdomain', `conduit.wyre.ai/v1/mcp/${resellerSlug}/${draft.subdomain}`],
    ['Plan', draft.plan],
    ['Owner invite', draft.adminEmail],
    ['Branding', draft.inheritBranding ? `Inherits ${org.name}` : `Custom accent ${draft.accent}`],
  ];
  return `
    <h2 class="nc-q">Branding &amp; review</h2>
    <p class="nc-q-sub">By default the customer inherits your white-label
      branding. Override the accent if they need their own.</p>

    <div class="nc-toggle-row">
      <label class="nc-switch">
        <input type="checkbox" ${draft.inheritBranding ? 'checked' : ''}
          aria-label="Inherit reseller branding" />
        <span class="nc-switch-track"><span class="nc-switch-thumb"></span></span>
      </label>
      <div>
        <span class="nc-toggle-label">Inherit ${escapeHtml(org.name)} branding</span>
        <span class="nc-help">Logo, colors, and email sender carry over from
          your white-label settings.</span>
      </div>
    </div>

    <label class="nc-field">
      <span class="nc-label">Accent override</span>
      <input type="text" class="nc-input nc-input-narrow" value="${escapeHtml(draft.accent)}"
        ${draft.inheritBranding ? 'disabled' : ''} />
      <span class="nc-help">Used only when inheritance is off.</span>
    </label>

    <div class="nc-summary">
      <div class="nc-summary-title">Review</div>
      <dl class="nc-summary-list">
        ${summary.map(([k, v]) => `
          <div class="nc-summary-row">
            <dt>${escapeHtml(k)}</dt>
            <dd>${escapeHtml(v)}</dd>
          </div>`).join('')}
      </dl>
    </div>

    <div class="nc-actions nc-actions-split">
      <a class="nc-back" href="${stepPath(2)}">&larr; Back</a>
      <button type="button" class="nc-create" disabled
        title="Customer provisioning lands with the Track A endpoint">
        Create customer
      </button>
    </div>`;
}

export function renderNewCustomer(data: NewCustomerData): { body: string; pageScripts: string } {
  const { org, step } = data;
  const orgName = escapeHtml(org.name);

  const stepBody =
    step === 1 ? renderStep1(data)
    : step === 2 ? renderStep2(data)
    : renderStep3(data);

  const body = `
    <div class="nc-wrap">
      <a class="nc-crumb" href="/org/customers">&larr; Back to customers</a>
      <h1 class="nc-title">New customer</h1>
      <div class="nc-banner">NEW CUSTOMER &middot; under ${orgName}</div>
      ${renderStepper(step)}
      ${stepBody}
      <p class="ia-shell-note">
        This wizard renders mock data until the Track A customer-provisioning
        endpoint lands. "Create customer" is disabled — provisioning writes a
        new org, sends an owner invite, and seeds branding, so it stays gated
        until that endpoint is live.
      </p>
    </div>`;

  // Live-derive the subdomain slug from the name on step 1. textContent
  // only — no innerHTML.
  const pageScripts = step === 1
    ? `
<script>
  function ncSyncSlug() {
    var name = document.getElementById('ncName');
    var slug = document.getElementById('ncSlug');
    var echo = document.getElementById('ncSlugEcho');
    if (!name || !slug) return;
    var derived = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    slug.value = derived;
    if (echo) echo.textContent = derived;
  }
</script>`
    : '';

  return { body, pageScripts };
}

export const NEW_CUSTOMER_STYLES = `
  .nc-wrap { max-width: 720px; }
  .nc-crumb {
    display: inline-block;
    font-size: 12px;
    color: var(--text-tertiary);
    text-decoration: none;
    margin-bottom: 12px;
  }
  .nc-crumb:hover { color: var(--text-secondary); }
  .nc-title { font-size: 26px; margin: 0 0 14px; }
  .nc-banner {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.10);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 8px 14px;
    margin-bottom: 24px;
  }

  .nc-stepper { display: flex; list-style: none; padding: 0; margin: 0 0 28px; }
  .nc-step { display: flex; align-items: center; gap: 8px; flex: 1; font-size: 12px; }
  .nc-step:not(:last-child)::after {
    content: '';
    flex: 1;
    height: 2px;
    background: var(--border-secondary);
    margin: 0 8px;
  }
  .nc-step-done:not(:last-child)::after { background: var(--success); }
  .nc-step-dot {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    background: var(--border-secondary);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .nc-step-label { color: var(--text-tertiary); white-space: nowrap; }
  .nc-step-active .nc-step-dot { background: var(--accent); color: #0a0a0a; }
  .nc-step-active .nc-step-label { color: var(--text-primary); font-weight: 600; }
  .nc-step-done .nc-step-dot { background: var(--success); color: #0a0a0a; }
  .nc-step-done .nc-step-label { color: var(--text-primary); }
  /* visually-hidden text — exposes step state to screen readers only */
  .nc-sr {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }
  @media (max-width: 480px) {
    .nc-step-label { display: none; }
    .nc-step:not(:last-child)::after { margin: 0 4px; }
  }

  .nc-q { font-size: 18px; margin: 0 0 6px; color: var(--text-primary); }
  .nc-q-sub { font-size: 13px; color: var(--text-tertiary); margin: 0 0 20px; line-height: 1.5; }

  .nc-field { display: block; margin-bottom: 18px; }
  .nc-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    margin-bottom: 6px;
  }
  .nc-input, .nc-select {
    width: 100%;
    max-width: 420px;
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
  }
  .nc-input-narrow { max-width: 160px; }
  .nc-input:disabled { color: var(--text-muted); cursor: not-allowed; }
  .nc-select { cursor: pointer; }
  .nc-help {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .nc-toggle-row { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
  .nc-toggle-label { display: block; font-size: 13px; color: var(--text-primary); font-weight: 500; }
  .nc-switch { flex-shrink: 0; }
  .nc-switch input { position: absolute; opacity: 0; pointer-events: none; }
  .nc-switch-track {
    display: inline-block;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: var(--border-secondary);
    position: relative;
    transition: background 0.15s;
  }
  .nc-switch-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: transform 0.15s;
  }
  .nc-switch input:checked + .nc-switch-track { background: var(--accent); }
  .nc-switch input:checked + .nc-switch-track .nc-switch-thumb {
    transform: translateX(16px);
    background: #0a0a0a;
  }

  .nc-summary {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 18px;
    margin: 20px 0;
  }
  .nc-summary-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
  .nc-summary-list { margin: 0; }
  .nc-summary-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 0;
    font-size: 12px;
  }
  .nc-summary-row dt { color: var(--text-tertiary); flex-shrink: 0; }
  .nc-summary-row dd {
    margin: 0;
    color: var(--text-primary);
    text-align: right;
    overflow-wrap: anywhere;
  }

  .nc-actions { margin: 24px 0; display: flex; justify-content: flex-end; }
  .nc-actions-split { justify-content: space-between; }
  .nc-next {
    display: inline-block;
    padding: 10px 22px;
    background: var(--accent);
    color: #0a0a0a;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
  }
  .nc-back {
    display: inline-block;
    padding: 10px 18px;
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
  }
  .nc-back:hover { color: var(--text-primary); }
  .nc-create {
    padding: 10px 22px;
    background: var(--success);
    color: #0a0a0a;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .nc-create:disabled {
    background: var(--border-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
  }
`;
