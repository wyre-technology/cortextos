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
// LIVE end-to-end. The Track A customer-provisioning endpoint shipped
// (POST /admin/reseller/:resellerId/customers, src/reseller/routes.ts) +
// the owner-invite email pipeline shipped (#229), so the wizard now
// genuinely creates a customer org. Step 3 wires the "Create customer"
// CTA to `data-create-url` on the button + the page-script POSTs the
// draft and redirects to the new customer's detail page on success
// (see the create-POST handler in this file and the receiving route at
// src/reseller/routes.ts). The wizard has no server-side draft store: each
// step is a form-GET whose Next serializes its inputs into the query string,
// so the query IS the draft and the reseller-admin's real input is carried
// step-to-step (first load is empty + defaults, NOT an example). Step 3's
// create POST sends name + admin_email + plan — the full create contract.

export type NewCustomerStep = 1 | 2 | 3;

/** The customer-org being drafted — populated from the carried form-GET query string. */
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

/**
 * Build a step URL that CARRIES the collected draft forward/back as query
 * params, so navigating between steps preserves the reseller-admin's input
 * (the wizard has no server-side draft store — the query string IS the draft).
 * Returned value is HTML-attribute-safe (escaped) for use in an href.
 */
function stepUrl(step: NewCustomerStep, draft: NewCustomerDraft): string {
  const params = new URLSearchParams({
    step: String(step),
    name: draft.name,
    subdomain: draft.subdomain,
    plan: draft.plan,
    adminEmail: draft.adminEmail,
  });
  return escapeHtml(`/org/customers/new?${params.toString()}`);
}

/** Hidden inputs that carry the already-collected draft fields through a step's form-GET. */
function carryFields(draft: NewCustomerDraft, omit: Set<string> = new Set()): string {
  const fields: Array<[string, string]> = [
    ['name', draft.name],
    ['subdomain', draft.subdomain],
    ['plan', draft.plan],
    ['adminEmail', draft.adminEmail],
  ];
  return fields
    .filter(([k]) => !omit.has(k))
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
    .join('\n    ');
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
    <form method="GET" action="/org/customers/new">
    <input type="hidden" name="step" value="2" />
    <h2 class="nc-q">Customer organization</h2>
    <p class="nc-q-sub">The new org's identity. The subdomain is path-based and
      collision-safe — derived from the name, editable.</p>

    <label class="nc-field">
      <span class="nc-label">Organization name</span>
      <input type="text" id="ncName" name="name" class="nc-input" value="${escapeHtml(draft.name)}"
        oninput="ncSyncSlug()" required />
    </label>

    <label class="nc-field">
      <span class="nc-label">Subdomain</span>
      <input type="text" id="ncSlug" name="subdomain" class="nc-input" value="${slug}" />
      <span class="nc-help">
        URL: conduit.wyre.ai/v1/mcp/${resellerSlug}/<span id="ncSlugEcho">${slug}</span>
      </span>
    </label>

    <label class="nc-field">
      <span class="nc-label">Plan tier</span>
      <select class="nc-select" name="plan">
        ${planTiers.map((p) =>
          `<option${p === draft.plan ? ' selected' : ''}>${escapeHtml(p)}</option>`,
        ).join('')}
      </select>
    </label>

    <div class="nc-actions">
      <button type="submit" class="nc-next">Next &rarr;</button>
    </div>
    </form>`;
}

function renderStep2(data: NewCustomerData): string {
  const { draft } = data;
  return `
    <form method="GET" action="/org/customers/new">
    <input type="hidden" name="step" value="3" />
    ${carryFields(draft, new Set(['adminEmail']))}
    <h2 class="nc-q">Initial admin</h2>
    <p class="nc-q-sub">Invite the first user — they become the owner of
      ${escapeHtml(draft.name)} and can invite the rest of the team.</p>

    <label class="nc-field">
      <span class="nc-label">Owner email</span>
      <input type="email" id="ncAdminEmail" name="adminEmail" class="nc-input" value="${escapeHtml(draft.adminEmail)}"
        placeholder="admin@customer.com" required />
      <span class="nc-help">An invite is sent on create; the owner sets their
        own password via the link.</span>
    </label>

    <div class="nc-actions nc-actions-split">
      <a class="nc-back" href="${stepUrl(1, draft)}">&larr; Back</a>
      <button type="submit" class="nc-next">Next &rarr;</button>
    </div>
    </form>`;
}

function renderStep3(data: NewCustomerData): string {
  const { draft, org } = data;
  const resellerSlug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const createUrl = `/admin/reseller/${encodeURIComponent(org.id)}/customers`;
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
      <a class="nc-back" href="${stepUrl(2, draft)}">&larr; Back</a>
      <button type="button" id="ncCreateBtn" class="nc-create"
        data-create-url="${escapeHtml(createUrl)}"
        data-plan="${escapeHtml(draft.plan)}"
        data-admin-email="${escapeHtml(draft.adminEmail)}"
        data-name="${escapeHtml(draft.name)}">
        Create customer
      </button>
    </div>
    <div id="ncCreateError" class="nc-error" role="alert" hidden></div>`;
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
        Provisioning v1 creates the customer org with you (the reseller admin)
        as the interim owner. Owner-invite delivery and brand-profile
        overrides land in follow-up iterations.
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
    : step === 3
    ? `
<script>
  (function () {
    var btn = document.getElementById('ncCreateBtn');
    var err = document.getElementById('ncCreateError');
    if (!btn || !err) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      err.hidden = true;
      err.textContent = '';
      try {
        var res = await fetch(btn.dataset.createUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: btn.dataset.name,
            admin_email: btn.dataset.adminEmail,
            plan: (btn.dataset.plan || 'free').toLowerCase(),
          }),
        });
        if (res.status === 201) {
          var body = await res.json();
          window.location.assign('/org/customers/' + encodeURIComponent(body.id));
          return;
        }
        var msg = 'Create failed (HTTP ' + res.status + ')';
        try {
          var data = await res.json();
          if (data && data.error) msg = data.error;
        } catch (e) { /* keep default */ }
        err.textContent = msg;
        err.hidden = false;
        btn.disabled = false;
      } catch (e) {
        err.textContent = 'Network error — please retry';
        err.hidden = false;
        btn.disabled = false;
      }
    });
  })();
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
  .nc-step-active .nc-step-dot { background: var(--accent); color: var(--text-on-accent); }
  .nc-step-active .nc-step-label { color: var(--text-primary); font-weight: 600; }
  .nc-step-done .nc-step-dot { background: var(--success); color: var(--text-on-success); }
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
    background: var(--text-on-accent);
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
    color: var(--text-on-accent);
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
    color: var(--text-on-accent);
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

  .nc-error {
    margin-top: 12px;
    padding: 10px 14px;
    background: rgba(220, 38, 38, 0.10);
    border: 1px solid var(--danger, #dc2626);
    border-radius: 6px;
    color: var(--danger, #dc2626);
    font-size: 12px;
  }
`;
