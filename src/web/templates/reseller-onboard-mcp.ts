import type { Organization } from '../../org/org-service.js';
import { escapeHtml, safeCssColor } from '../helpers.js';

// Track C Surface 3 — Onboard MCP Wizard (/org/customers/:id/onboard-mcp).
// Figma design-of-record: tbaRrzQQqZTNZu2AelcIID nodes 6:2 / 7:2 / 8:2 / 8:81.
//
// A 4-step wizard a reseller runs to onboard an MCP integration for one
// of its customer orgs: Catalog → Wire Up → Config → Allowlist. Built
// mock-data-first (same play as Surfaces 1/4/5): the route handler
// passes a fixed mock scenario (Autotask · BYOC · AM3 Technology) until
// the Track A onboarding endpoint lands, then the data source swaps and
// this template renders unchanged.
//
// One route, one module: `?step=1..4` selects the body; the chrome
// (breadcrumb, banner, stepper) is shared. "Next/Back" are plain links.
// The final CTA renders disabled — onboarding is irreversible (audit-log
// entries + customer emails), so it must not be a dead live button.
// See memory/2026-05-17-track-c-s3-onboard-wizard-scoping.md.

export type OnboardStep = 1 | 2 | 3 | 4;

export interface McpCatalogEntry {
  id: string;
  name: string;
  /** 2-letter monogram for the icon tile. */
  abbr: string;
  /** Icon tile background (hex). */
  iconColor: string;
  vendor: string;
  category: string;
  /** Hosting/wiring summary, e.g. "OEM · BYOC", "Self-hosted". */
  hosting: string;
  isNew?: boolean;
}

export interface WiringPattern {
  id: 'byoc' | 'shared' | 'self-hosted';
  title: string;
  desc: string;
  pros: string[];
  cons: string[];
  bestFor: string;
  recommended?: boolean;
  /** false → card renders disabled (vendor doesn't support this pattern). */
  supported: boolean;
}

export interface SeatRow {
  name: string;
  department: string;
  role: string;
  selected: boolean;
}

export interface ToolGroup {
  name: string;
  tools: Array<{ name: string; enabled: boolean }>;
}

export interface OnboardSummaryRow {
  label: string;
  value: string;
}

export interface OnboardMcpData {
  org: Organization;
  customerId: string;
  customerName: string;
  step: OnboardStep;
  /** Vendor being onboarded — drives the step 2-4 titles. */
  vendorName: string;
  catalog: McpCatalogEntry[];
  catalogCategories: string[];
  patterns: WiringPattern[];
  seats: SeatRow[];
  /** "+ N more users" affordance under the seat table. */
  extraSeatCount: number;
  toolGroups: ToolGroup[];
  toolPresets: string[];
  activePreset: string;
  department: string;
  summary: OnboardSummaryRow[];
}

const STEP_LABELS: Record<OnboardStep, string> = {
  1: 'Catalog',
  2: 'Wire Up',
  3: 'Config',
  4: 'Allowlist',
};

/**
 * Clamp a `?step=` query value to a valid step. Anything that is not
 * exactly "2", "3", or "4" — including `parseInt`-salvageable garbage
 * like "3abc" or "2.9", arrays, and `undefined` — normalizes to step 1.
 */
export function coerceStep(raw: unknown): OnboardStep {
  if (typeof raw !== 'string') return 1;
  const s = raw.trim();
  if (s === '2') return 2;
  if (s === '3') return 3;
  if (s === '4') return 4;
  return 1;
}

function wizardPath(data: OnboardMcpData, step: OnboardStep): string {
  return `/org/customers/${encodeURIComponent(data.customerId)}/onboard-mcp?step=${step}`;
}

// ---- shared chrome -------------------------------------------------------

function renderStepper(current: OnboardStep): string {
  const steps: OnboardStep[] = [1, 2, 3, 4];
  return `
    <ol class="ob-stepper">
      ${steps.map((s) => {
        const state = s < current ? 'done' : s === current ? 'active' : 'pending';
        const marker = state === 'done' ? '&#10003;' : String(s);
        const aria = state === 'active' ? ' aria-current="step"' : '';
        const sr = state === 'done' ? ' (completed)' : state === 'active' ? ' (current step)' : '';
        return `
          <li class="ob-step ob-step-${state}"${aria}>
            <span class="ob-step-dot">${marker}</span>
            <span class="ob-step-label">${escapeHtml(STEP_LABELS[s])}<span class="ob-sr">${sr}</span></span>
          </li>`;
      }).join('')}
    </ol>`;
}

function renderChrome(data: OnboardMcpData, body: string): string {
  const { step, customerName, vendorName } = data;

  const title =
    step === 1 ? 'Onboard an MCP'
    : step === 2 ? `Onboard ${escapeHtml(vendorName)}`
    : step === 3 ? `Configure ${escapeHtml(vendorName)} · BYOC`
    : 'Scope tool access';

  const back =
    step === 1
      ? { href: `/org/customers/${encodeURIComponent(data.customerId)}`, label: `Back to ${escapeHtml(customerName)}` }
      : { href: wizardPath(data, (step - 1) as OnboardStep), label: `Back to ${escapeHtml(STEP_LABELS[(step - 1) as OnboardStep])}` };

  return `
    <div class="ob-wrap">
      <a class="ob-back" href="${back.href}">&larr; ${back.label}</a>
      <h1 class="ob-title">${title}</h1>
      <div class="ob-banner">ONBOARDING AS RESELLER &middot; for ${escapeHtml(customerName)}</div>
      ${renderStepper(step)}
      ${body}
    </div>`;
}

// ---- step 1 — catalog ----------------------------------------------------

function renderCatalogCard(entry: McpCatalogEntry, data: OnboardMcpData): string {
  const newBadge = entry.isNew ? `<span class="ob-new">NEW</span>` : '';
  return `
    <div class="ob-cat-card">
      <div class="ob-cat-head">
        <span class="ob-cat-icon" style="background:${safeCssColor(entry.iconColor, 'var(--border-secondary)')}">${escapeHtml(entry.abbr)}</span>
        ${newBadge}
      </div>
      <div class="ob-cat-name">${escapeHtml(entry.name)}</div>
      <div class="ob-cat-vendor">${escapeHtml(entry.vendor)} &middot; ${escapeHtml(entry.category)}</div>
      <div class="ob-cat-hosting">${escapeHtml(entry.hosting)}</div>
      <a class="ob-cat-btn" href="${wizardPath(data, 2)}">+ Onboard</a>
    </div>`;
}

function renderStep1(data: OnboardMcpData): string {
  return `
    <div class="ob-search" role="search">
      <span aria-hidden="true">&#128269;</span>
      <input type="text" placeholder="Search MCPs (e.g. Autotask, Datto, Halo, CIPP…)"
        aria-label="Search MCPs" />
    </div>
    <div class="ob-pills">
      ${data.catalogCategories.map((c, i) =>
        `<button type="button" class="ob-pill ${i === 0 ? 'ob-pill-active' : ''}">${escapeHtml(c)}</button>`,
      ).join('')}
    </div>
    ${data.catalog.length === 0
      ? '<p class="ob-empty">No MCPs available in the catalog yet.</p>'
      : `<div class="ob-cat-grid">
      ${data.catalog.map((e) => renderCatalogCard(e, data)).join('')}
    </div>`}`;
}

// ---- step 2 — wire up pattern -------------------------------------------

function renderPatternCard(p: WiringPattern): string {
  const cls = [
    'ob-pattern',
    p.recommended ? 'ob-pattern-selected' : '',
    !p.supported ? 'ob-pattern-disabled' : '',
  ].filter(Boolean).join(' ');
  const badge = !p.supported
    ? `<span class="ob-pattern-tag ob-pattern-tag-off">NOT SUPPORTED</span>`
    : p.recommended
      ? `<span class="ob-pattern-tag">RECOMMENDED</span>`
      : '';
  return `
    <div class="${cls}">
      ${badge}
      <h3 class="ob-pattern-title">${escapeHtml(p.title)}</h3>
      <p class="ob-pattern-desc">${escapeHtml(p.desc)}</p>
      <ul class="ob-pattern-list">
        ${p.pros.map((x) => `<li class="ob-pro">&#10003; ${escapeHtml(x)}</li>`).join('')}
        ${p.cons.map((x) => `<li class="ob-con">&times; ${escapeHtml(x)}</li>`).join('')}
      </ul>
      <p class="ob-pattern-bestfor">Best for: ${escapeHtml(p.bestFor)}</p>
    </div>`;
}

function renderStep2(data: OnboardMcpData): string {
  return `
    <h2 class="ob-q">How will ${escapeHtml(data.customerName)} connect to ${escapeHtml(data.vendorName)}?</h2>
    <p class="ob-q-sub">
      ${escapeHtml(data.vendorName)} uses OEM credentials (each user supplies their
      own API key) OR shared credentials (you supply one, all users use it).
    </p>
    <div class="ob-pattern-grid">
      ${data.patterns.map((p) => renderPatternCard(p)).join('')}
    </div>
    <div class="ob-actions">
      <a class="ob-next" href="${wizardPath(data, 3)}">Next &rarr;</a>
    </div>`;
}

// ---- step 3 — config / BYOC seats ---------------------------------------

function renderSeatRow(seat: SeatRow): string {
  const box = seat.selected ? 'ob-box ob-box-on' : 'ob-box';
  const mark = seat.selected ? '&#10003;' : '';
  return `
    <tr>
      <td><span class="${box}" role="checkbox" aria-checked="${seat.selected}"
        aria-label="Seat for ${escapeHtml(seat.name)}">${mark}</span></td>
      <td class="ob-seat-name">${escapeHtml(seat.name)}</td>
      <td>${escapeHtml(seat.department)}</td>
      <td>${escapeHtml(seat.role)}</td>
    </tr>`;
}

function renderStep3(data: OnboardMcpData): string {
  const more = data.extraSeatCount > 0
    ? `<p class="ob-seat-more">+ ${data.extraSeatCount} more user${data.extraSeatCount === 1 ? '' : 's'}</p>`
    : '';
  return `
    <div class="ob-split">
      <div class="ob-split-main">
        <h2 class="ob-q">Who gets a seat?</h2>
        <p class="ob-q-sub">
          Each user with a seat must onboard their own ${escapeHtml(data.vendorName)}
          API key via their Conduit profile.
        </p>
        <table class="ob-seats">
          <thead><tr><th></th><th>User</th><th>Department</th><th>Seat</th></tr></thead>
          <tbody>${data.seats.map(renderSeatRow).join('')}</tbody>
        </table>
        ${more}
      </div>
      <aside class="ob-split-aside">
        <h2 class="ob-q ob-q-aside">What ${escapeHtml(data.customerName)} users will see</h2>
        <p class="ob-q-sub">Each selected user gets a setup email + sees this in their Conduit dashboard.</p>
        <div class="ob-preview">
          <div class="ob-preview-title">Connect ${escapeHtml(data.vendorName)}</div>
          <p class="ob-preview-desc">
            Your administrator (${escapeHtml(data.org.name)}) has provisioned
            ${escapeHtml(data.vendorName)} for ${escapeHtml(data.customerName)}.
            Provide your API key to activate access.
          </p>
          <label class="ob-preview-label">${escapeHtml(data.vendorName)} Username</label>
          <div class="ob-preview-input">cramirez@am3-it.com (auto-filled)</div>
          <label class="ob-preview-label">Integration Code</label>
          <div class="ob-preview-input">Provided by ${escapeHtml(data.org.name)}</div>
          <label class="ob-preview-label">API Tracking Identifier (Secret)</label>
          <div class="ob-preview-input">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
          <div class="ob-preview-btns">
            <span class="ob-preview-activate">Activate</span>
            <span class="ob-preview-cancel">Cancel</span>
          </div>
        </div>
      </aside>
    </div>
    <div class="ob-actions">
      <a class="ob-next" href="${wizardPath(data, 4)}">Next: Tool Access &rarr;</a>
    </div>`;
}

// ---- step 4 — tool allowlist + done -------------------------------------

function renderToolGroup(group: ToolGroup): string {
  const enabled = group.tools.filter((t) => t.enabled).length;
  return `
    <div class="ob-tool-group">
      <div class="ob-tool-head">
        <span class="ob-tool-group-name">${escapeHtml(group.name)}</span>
        <span class="ob-tool-count">${enabled} of ${group.tools.length} enabled</span>
      </div>
      ${group.tools.map((t) => `
        <div class="ob-tool-row">
          <span class="${t.enabled ? 'ob-box ob-box-on' : 'ob-box'}" role="checkbox"
            aria-checked="${t.enabled}" aria-label="${escapeHtml(t.name)}">${t.enabled ? '&#10003;' : ''}</span>
          <span class="${t.enabled ? 'ob-tool-name' : 'ob-tool-name ob-tool-off'}">${escapeHtml(t.name)}</span>
        </div>`).join('')}
    </div>`;
}

function renderStep4(data: OnboardMcpData): string {
  return `
    <h2 class="ob-q">Which ${escapeHtml(data.vendorName)} tools can ${escapeHtml(data.customerName)} users invoke?</h2>
    <p class="ob-q-sub">Tool-level scoping by department. Off by default; check the boxes to grant.</p>

    <div class="ob-scope-bar">
      <label class="ob-scope-label">Department:</label>
      <span class="ob-select">${escapeHtml(data.department)} &#9662;</span>
      <label class="ob-scope-label">Apply preset:</label>
      ${data.toolPresets.map((p) =>
        `<button type="button" class="ob-preset ${p === data.activePreset ? 'ob-preset-active' : ''}">${escapeHtml(p)}</button>`,
      ).join('')}
    </div>

    <div class="ob-split">
      <div class="ob-split-main">
        ${data.toolGroups.map(renderToolGroup).join('')}
      </div>
      <aside class="ob-split-aside">
        <div class="ob-summary">
          <div class="ob-summary-title">Summary</div>
          <dl class="ob-summary-list">
            ${data.summary.map((r) => `
              <div class="ob-summary-row">
                <dt>${escapeHtml(r.label)}</dt>
                <dd>${escapeHtml(r.value)}</dd>
              </div>`).join('')}
          </dl>
        </div>
      </aside>
    </div>

    <div class="ob-actions">
      <button type="button" class="ob-finish" disabled
        title="Onboarding persistence lands with the Track A endpoint">
        Onboard ${escapeHtml(data.vendorName)} for ${escapeHtml(data.customerName)}
      </button>
    </div>`;
}

// ---- entrypoint ----------------------------------------------------------

export function renderOnboardMcp(data: OnboardMcpData): string {
  const body =
    data.step === 1 ? renderStep1(data)
    : data.step === 2 ? renderStep2(data)
    : data.step === 3 ? renderStep3(data)
    : renderStep4(data);

  const note = `
    <p class="ia-shell-note">
      This wizard renders mock data until the Track A onboarding endpoint
      lands. v1 ships the BYOC config variant; shared and self-hosted
      wiring follow. The final action is disabled — onboarding writes
      audit-log entries and sends customer emails, so it stays gated
      until the endpoint is live.
    </p>`;

  return renderChrome(data, body + note);
}

export const RESELLER_ONBOARD_MCP_STYLES = `
  .ob-wrap { max-width: 1200px; }
  .ob-back {
    display: inline-block;
    font-size: 12px;
    color: var(--text-tertiary);
    text-decoration: none;
    margin-bottom: 12px;
  }
  .ob-back:hover { color: var(--text-secondary); }
  .ob-title { font-size: 26px; margin: 0 0 14px; }
  .ob-banner {
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

  /* stepper */
  .ob-stepper {
    display: flex;
    list-style: none;
    padding: 0;
    margin: 0 0 28px;
    gap: 0;
  }
  .ob-step {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    font-size: 12px;
  }
  .ob-step:not(:last-child)::after {
    content: '';
    flex: 1;
    height: 2px;
    background: var(--border-secondary);
    margin: 0 8px;
  }
  .ob-step-done:not(:last-child)::after { background: var(--success); }
  .ob-step-dot {
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
  .ob-step-label { color: var(--text-tertiary); white-space: nowrap; }
  .ob-step-active .ob-step-dot { background: var(--accent); color: #0a0a0a; }
  .ob-step-active .ob-step-label { color: var(--text-primary); font-weight: 600; }
  .ob-step-done .ob-step-dot { background: var(--success); color: #0a0a0a; }
  .ob-step-done .ob-step-label { color: var(--text-primary); }
  /* visually-hidden text — exposes step state to screen readers only */
  .ob-sr {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }
  /* On narrow viewports the four labels overflow — show dots only. */
  @media (max-width: 560px) {
    .ob-step-label { display: none; }
    .ob-step:not(:last-child)::after { margin: 0 4px; }
  }

  .ob-empty {
    padding: 16px;
    background: var(--bg-card);
    border: 1px dashed var(--border-secondary);
    border-radius: 8px;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .ob-q { font-size: 18px; margin: 0 0 6px; color: var(--text-primary); }
  .ob-q-sub { font-size: 13px; color: var(--text-tertiary); margin: 0 0 20px; line-height: 1.5; }
  .ob-q-aside { font-size: 15px; }

  .ob-actions { margin: 24px 0; display: flex; justify-content: flex-end; }
  .ob-next {
    display: inline-block;
    padding: 10px 22px;
    background: var(--accent);
    color: #0a0a0a;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
  }
  .ob-finish {
    padding: 12px 24px;
    background: var(--success);
    color: #0a0a0a;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .ob-finish:disabled {
    background: var(--border-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
  }

  /* step 1 — catalog */
  .ob-search {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 600px;
    padding: 9px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    margin-bottom: 16px;
  }
  .ob-search input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  .ob-search input::placeholder { color: var(--text-muted); }
  .ob-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .ob-pill {
    padding: 6px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 16px;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .ob-pill-active {
    border-color: var(--accent);
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.08);
  }
  .ob-cat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }
  .ob-cat-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 16px;
  }
  .ob-cat-head { display: flex; align-items: flex-start; justify-content: space-between; }
  .ob-cat-icon {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: #f2f2f5;
  }
  .ob-new {
    font-size: 9px;
    font-weight: 600;
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.12);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 2px 8px;
  }
  .ob-cat-name { margin-top: 14px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .ob-cat-vendor { margin-top: 4px; font-size: 11px; color: var(--text-tertiary); }
  .ob-cat-hosting { margin-top: 6px; font-size: 11px; color: var(--text-secondary); font-weight: 500; }
  .ob-cat-btn {
    display: block;
    text-align: center;
    margin-top: 14px;
    padding: 7px;
    background: var(--bg-input, var(--border-subtle));
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--accent-text);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
  }

  /* step 2 — patterns */
  .ob-pattern-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
  .ob-pattern {
    position: relative;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 12px;
    padding: 20px;
  }
  .ob-pattern-selected { border: 2px solid var(--accent); }
  .ob-pattern-disabled { opacity: 0.55; }
  .ob-pattern-tag {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.08);
    border: 1px solid var(--accent);
    border-radius: 11px;
    padding: 3px 10px;
    margin-bottom: 10px;
  }
  .ob-pattern-tag-off {
    color: var(--text-muted);
    background: var(--border-subtle);
    border-color: var(--border-secondary);
  }
  .ob-pattern-title { font-size: 17px; margin: 0 0 6px; color: var(--text-primary); }
  .ob-pattern-desc { font-size: 12px; color: var(--text-secondary); margin: 0 0 14px; line-height: 1.5; }
  .ob-pattern-list { list-style: none; padding: 0; margin: 0 0 14px; }
  .ob-pattern-list li { font-size: 12px; margin-bottom: 6px; line-height: 1.4; }
  .ob-pro { color: var(--text-secondary); }
  .ob-con { color: var(--text-tertiary); }
  .ob-pattern-bestfor { font-size: 11px; color: var(--text-tertiary); font-weight: 500; margin: 0; }

  /* split layout (steps 3 & 4) */
  .ob-split { display: grid; grid-template-columns: 1.2fr 1fr; gap: 24px; }
  @media (max-width: 860px) { .ob-split { grid-template-columns: 1fr; } }

  /* step 3 — seats */
  .ob-seats { width: 100%; border-collapse: collapse; font-size: 13px; }
  .ob-seats th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-secondary);
  }
  .ob-seats td { padding: 9px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
  .ob-seat-name { color: var(--text-primary); font-weight: 500; }
  .ob-seat-more { margin-top: 12px; font-size: 12px; color: var(--accent-text); font-weight: 500; }

  .ob-box {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-secondary);
    background: var(--bg-card);
    font-size: 10px;
    color: #0a0a0a;
  }
  .ob-box-on { background: var(--accent); border-color: var(--accent); }

  .ob-preview {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 18px;
  }
  .ob-preview-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .ob-preview-desc { font-size: 11px; color: var(--text-tertiary); margin: 8px 0 16px; line-height: 1.5; }
  .ob-preview-label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .ob-preview-input {
    padding: 8px 12px;
    background: var(--bg-input, var(--border-subtle));
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--text-tertiary);
    font-size: 12px;
    margin-bottom: 14px;
  }
  .ob-preview-btns { display: flex; gap: 10px; }
  .ob-preview-activate {
    padding: 7px 18px;
    background: var(--accent);
    color: #0a0a0a;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
  }
  .ob-preview-cancel {
    padding: 7px 18px;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    color: var(--text-secondary);
    font-size: 12px;
    border-radius: 6px;
  }

  /* step 4 — allowlist */
  .ob-scope-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .ob-scope-label { font-size: 12px; color: var(--text-tertiary); }
  .ob-select {
    padding: 7px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .ob-preset {
    padding: 7px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 16px;
    color: var(--text-secondary);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .ob-preset-active {
    border-color: var(--accent);
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.08);
  }
  .ob-tool-group { margin-bottom: 18px; }
  .ob-tool-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .ob-tool-group-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .ob-tool-count { font-size: 11px; color: var(--text-tertiary); }
  .ob-tool-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
  .ob-tool-name { font-size: 13px; color: var(--text-primary); }
  .ob-tool-off { color: var(--text-tertiary); }

  .ob-summary {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 18px;
  }
  .ob-summary-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 14px; }
  .ob-summary-list { margin: 0; }
  .ob-summary-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 0;
    font-size: 12px;
  }
  .ob-summary-row dt { color: var(--text-tertiary); flex-shrink: 0; }
  .ob-summary-row dd {
    margin: 0;
    color: var(--text-primary);
    text-align: right;
    overflow-wrap: anywhere;
  }
`;
