import type { Organization } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

// Track C Surface 5 — Reseller White-Label Branding (/org/reseller/branding).
// Figma design-of-record: tbaRrzQQqZTNZu2AelcIID node 9:96.
//
// The reseller-settings "Branding" tab: how a reseller's customer orgs see
// Conduit. Built mock-data-first (same play as the billing IA shell and
// Surface 1): the route handler passes a mock `branding` record until the
// Track A reseller-settings endpoint lands, then the data source swaps and
// this template renders unchanged. v1 ships the layout + a disabled
// "Save changes" affordance — no dead persistence route.

export interface ResellerBrandColors {
  /** Hex accent — defaults inherit Conduit cyan when unset. */
  accent: string;
  textOnDark: string;
  textOnLight: string;
}

export interface ResellerBranding {
  /** Path-based, collision-safe default URL — always read-only. */
  defaultUrl: string;
  /** Optional brandable CNAME alias; null when the reseller hasn't set one. */
  brandAlias: string | null;
  /** Whether the brand alias' DNS has been verified. */
  aliasVerified: boolean;
  /** Uploaded customer logo URL, or null for the empty upload zone. */
  logoUrl: string | null;
  colors: ResellerBrandColors;
  /** Editable in v1. */
  emailFromName: string;
  /** Fixed platform address in v1 (read-only) — per-customer sender is v2. */
  emailFromAddress: string;
  /** Human-readable auth summary, e.g. "SPF + DKIM verified · DMARC pending". */
  emailAuthStatus: string;
  /** false → render the status amber (auth incomplete); true → green. */
  emailAuthVerified: boolean;
  /** Stripe Connect direct-billing toggle — OFF by default, advanced/v2. */
  directBillingEnabled: boolean;
}

export interface ResellerBrandingData {
  org: Organization;
  branding: ResellerBranding;
  /** A customer org name surfaced in the subtitle copy ("How <name> …"). */
  sampleCustomerName: string;
}

function renderAliasRow(branding: ResellerBranding): string {
  const alias = branding.brandAlias ?? '';
  const badge = branding.brandAlias && branding.aliasVerified
    ? `<span class="rb-verified">&#10003; Verified</span>`
    : branding.brandAlias
      ? `<span class="rb-unverified">DNS pending</span>`
      : '';
  return `
    <label class="rb-field">
      <span class="rb-label">Brandable alias (optional)</span>
      <div class="rb-alias-input">
        <input type="text" class="rb-input" value="${escapeHtml(alias)}"
          placeholder="mcp.yourbrand.com" aria-label="Brandable alias" />
        ${badge}
      </div>
      <span class="rb-help">
        A vanity CNAME your customers see in place of the default path.
        ${branding.brandAlias ? '<a class="rb-link" href="/org/reseller/api">Edit DNS &rarr;</a>' : ''}
      </span>
    </label>`;
}

function renderSwatch(label: string, hex: string): string {
  return `
    <div class="rb-swatch">
      <span class="rb-swatch-chip" style="background:${escapeHtml(hex)}"></span>
      <div class="rb-swatch-meta">
        <span class="rb-swatch-label">${escapeHtml(label)}</span>
        <span class="rb-swatch-hex">${escapeHtml(hex.toUpperCase())}</span>
      </div>
    </div>`;
}

export function renderResellerBranding(data: ResellerBrandingData): string {
  const { org, branding, sampleCustomerName } = data;
  const orgName = escapeHtml(org.name);
  const customer = escapeHtml(sampleCustomerName);

  const emailStatusClass = branding.emailAuthVerified ? 'rb-email-ok' : 'rb-email-warn';

  return `
    <div class="rb-header">
      <h1 style="margin-bottom:4px">Branding</h1>
      <p class="section-desc">
        How ${customer} and your other customers see Conduit. Path-based URL
        for collision-safety; brand alias is optional.
      </p>
    </div>

    <section class="rb-card">
      <h2 class="rb-card-title">URL strategy</h2>
      <label class="rb-field">
        <span class="rb-label">Default</span>
        <input type="text" class="rb-input rb-input-readonly"
          value="${escapeHtml(branding.defaultUrl)}" readonly
          aria-label="Default path-based URL" />
        <span class="rb-help">Collision-safe path-based URL. Always available.</span>
      </label>
      ${renderAliasRow(branding)}
    </section>

    <section class="rb-card">
      <h2 class="rb-card-title">Visual branding <span class="rb-scope">per customer</span></h2>
      <div class="rb-grid">
        <div class="rb-subcard">
          <h3 class="rb-subcard-title">Customer logo</h3>
          <div class="rb-upload" role="button" tabindex="0" aria-label="Upload customer logo">
            ${branding.logoUrl
              ? `<img class="rb-logo-preview" src="${escapeHtml(branding.logoUrl)}" alt="Customer logo" />`
              : `<span class="rb-upload-text">Drop SVG/PNG or click to upload</span>
                 <span class="rb-upload-hint">SVG or PNG, 256px+</span>`}
          </div>
        </div>

        <div class="rb-subcard">
          <h3 class="rb-subcard-title">Brand colors</h3>
          ${renderSwatch('Accent', branding.colors.accent)}
          ${renderSwatch('Text on dark', branding.colors.textOnDark)}
          ${renderSwatch('Text on light', branding.colors.textOnLight)}
          <span class="rb-help">Defaults inherit Conduit cyan.</span>
        </div>

        <div class="rb-subcard">
          <h3 class="rb-subcard-title">Email sender</h3>
          <label class="rb-field">
            <span class="rb-label">From name</span>
            <input type="text" class="rb-input" value="${escapeHtml(branding.emailFromName)}"
              aria-label="Email from name" />
          </label>
          <label class="rb-field">
            <span class="rb-label">From address</span>
            <input type="text" class="rb-input rb-input-readonly"
              value="${escapeHtml(branding.emailFromAddress)}" readonly
              aria-label="Email from address" />
            <span class="rb-help">
              Fixed platform address in v1. Per-customer sender domains land
              in a follow-up.
            </span>
          </label>
          <p class="rb-email-status ${emailStatusClass}">${escapeHtml(branding.emailAuthStatus)}</p>
        </div>
      </div>
    </section>

    <section class="rb-card">
      <h2 class="rb-card-title">Per-customer billing <span class="rb-scope">advanced</span></h2>
      <div class="rb-toggle-row">
        <label class="rb-switch">
          <input type="checkbox" ${branding.directBillingEnabled ? 'checked' : ''}
            disabled aria-label="Bill customers directly via Stripe Connect" />
          <span class="rb-switch-track"><span class="rb-switch-thumb"></span></span>
        </label>
        <div>
          <span class="rb-toggle-label">Bill customers directly (Stripe Connect)</span>
          <span class="rb-help">
            Route customer invoices through your own Stripe account.
            Connect onboarding lands in a follow-up.
          </span>
        </div>
      </div>
    </section>

    <div class="rb-actions">
      <button type="button" class="rb-save" disabled
        title="Branding persistence lands with the Track A reseller-settings endpoint">
        Save changes
      </button>
    </div>

    <p class="ia-shell-note">
      This branding panel renders mock data until the Track A reseller-settings
      endpoint lands. Logo upload, color editing, and Stripe Connect onboarding
      route through follow-up work; ${orgName}'s settings are not yet persisted.
    </p>
  `;
}

export const RESELLER_BRANDING_STYLES = `
  .rb-header { margin-bottom: 24px; }

  .rb-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .rb-card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rb-scope {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    border: 1px solid var(--border-secondary);
    border-radius: 10px;
    padding: 2px 8px;
  }

  .rb-field { display: block; margin-bottom: 16px; }
  .rb-field:last-child { margin-bottom: 0; }
  .rb-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    margin-bottom: 6px;
  }
  .rb-input {
    width: 100%;
    max-width: 420px;
    padding: 8px 12px;
    background: var(--bg-input, var(--bg-card));
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
  }
  .rb-input-readonly {
    color: var(--text-secondary);
    background: var(--border-subtle);
    cursor: default;
  }
  .rb-help {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }
  .rb-link { color: var(--accent); text-decoration: none; }
  .rb-link:hover { text-decoration: underline; }

  .rb-alias-input {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .rb-verified {
    font-size: 11px;
    font-weight: 600;
    color: var(--success);
  }
  .rb-unverified {
    font-size: 11px;
    font-weight: 600;
    color: #f59e0b;
  }

  .rb-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  }
  .rb-subcard {
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 16px;
  }
  .rb-subcard-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0 0 12px;
  }

  .rb-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 96px;
    border: 1px dashed var(--border-hover);
    border-radius: 8px;
    text-align: center;
    cursor: pointer;
  }
  .rb-upload-text { font-size: 12px; color: var(--text-secondary); }
  .rb-upload-hint { font-size: 10px; color: var(--text-tertiary); }
  .rb-logo-preview { max-height: 64px; max-width: 100%; }

  .rb-swatch {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .rb-swatch-chip {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--border-secondary);
    flex-shrink: 0;
  }
  .rb-swatch-meta { display: flex; flex-direction: column; }
  .rb-swatch-label { font-size: 12px; color: var(--text-primary); }
  .rb-swatch-hex {
    font-size: 11px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .rb-email-status {
    margin: 4px 0 0;
    font-size: 11px;
    font-weight: 500;
  }
  .rb-email-ok { color: var(--success); }
  .rb-email-warn { color: #f59e0b; }

  .rb-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  .rb-toggle-label {
    display: block;
    font-size: 13px;
    color: var(--text-primary);
    font-weight: 500;
  }
  .rb-switch { flex-shrink: 0; }
  .rb-switch input { position: absolute; opacity: 0; pointer-events: none; }
  .rb-switch-track {
    display: inline-block;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: var(--border-secondary);
    position: relative;
    transition: background 0.15s;
  }
  .rb-switch-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: transform 0.15s;
  }
  .rb-switch input:checked + .rb-switch-track { background: var(--accent); }
  .rb-switch input:checked + .rb-switch-track .rb-switch-thumb {
    transform: translateX(16px);
    background: #0a0a0a;
  }

  .rb-actions { margin: 8px 0 16px; }
  .rb-save {
    padding: 9px 18px;
    background: var(--accent);
    color: #0a0a0a;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .rb-save:disabled {
    background: var(--border-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
  }
`;
