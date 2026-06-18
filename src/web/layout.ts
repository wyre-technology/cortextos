import type { FastifyRequest } from 'fastify';
import type { Auth0User } from '../auth/auth0.js';
import type { Organization, OrgService } from '../org/org-service.js';
import { isPaidPlan } from '../billing/gate.js';
import { brand } from '../brand/index.js';
import { PAGE_STYLES } from './styles.js';
import { escapeHtml } from './helpers.js';

/**
 * Sidebar nav context.
 *  - 'default'           — Personal + Team(+Customers if reseller) + Org sub-nav.
 *  - 'reseller-settings' — the reseller-settings shell (Track C Surface 5):
 *                          a single RESELLER SETTINGS section, no Personal/Team.
 *  - 'customer-detail'   — a reseller drilled into one customer org (Track C
 *                          Surface 2): the sidebar swaps to customer context
 *                          (VIEWING AS RESELLER banner + customer sub-nav).
 */
export type NavMode = 'default' | 'reseller-settings' | 'customer-detail';

/** A tenant reachable from the customer-detail switcher. */
export interface SwitcherTenant {
  id: string;
  name: string;
}

/** Customer being viewed in 'customer-detail' navMode. */
export interface CustomerContext {
  id: string;
  name: string;
  /**
   * Sibling customer orgs under the same reseller — populates the tenant
   * switcher so a reseller can hop customer→customer without returning to
   * the list. Omit/empty → the switcher renders as a plain label.
   */
  siblings?: SwitcherTenant[];
}

export interface LayoutContext {
  user: Auth0User;
  org: Organization | null;
  activePath: string;
  title: string;
  pageStyles?: string;
  pageScripts?: string;
  /** Defaults to 'default'. */
  navMode?: NavMode;
  /** Required when navMode is 'customer-detail'. */
  customerContext?: CustomerContext;
  /**
   * WYREAI-172 actingAs-UI-flow foundation (boss msg-1781784272248).
   * When the request carries an active acting-as session (the operator
   * has entered customer-context via /api/reseller/me/customers/
   * :customerOrgId/switch), this field populates the always-visible
   * badge above the page chrome. Renders the customer name + an Exit
   * button that POSTs to /api/reseller/me/customers/exit.
   *
   * SECURITY-SUBSTRATE: This is the visible signal that the operator
   * is in impersonation mode — closes the warden-flagged audit-clarity
   * gap (msg-1781747987840-dev-10lbd, "actingAs binding is INVISIBLE
   * in UI"). Without this signal, a reseller-MSP-admin could be in
   * customer-context without realizing it + accidentally mutate the
   * customer's org when they meant to mutate their own.
   *
   * Read-only from the caller's perspective; populated by a helper
   * (`actingAsBadgeFromRequest`) that reads `request.caller.actingAs`
   * + looks up the customer name. Omit/undefined → no badge.
   */
  actingAsBadge?: ActingAsBadge;
}

/**
 * Acting-as badge payload for the layout chrome. The customerName is
 * a server-rendered display value (already escaped at the template
 * boundary); the exitFormAction is the POST URL the Exit button
 * submits to (always /api/reseller/me/customers/exit but exposed as
 * a field so the template doesn't hard-code an endpoint string).
 */
export interface ActingAsBadge {
  customerName: string;
  /** POST target for the Exit button. */
  exitFormAction: string;
}

/**
 * Build the acting-as badge payload for the current request, or
 * `undefined` if the operator isn't in customer-context. Single helper
 * called from every page handler that renders a layout — keeps the
 * badge-population logic + the "what URL does Exit post to" string
 * in one place so future changes don't fan out to 30+ call sites.
 *
 * Reads `request.caller.actingAs` (populated by the acting-as-
 * middleware on every authenticated request) and looks up the
 * customer-org's name via the OrgService. The name is the only
 * server-side data the badge needs; the exit URL is a constant
 * exposed as a field so the template doesn't hard-code the
 * endpoint string.
 *
 * Returns `undefined` when:
 *   - request.caller is missing (no auth)
 *   - request.caller.actingAs is undefined (no active session)
 *   - the customer-org lookup fails (deleted mid-session — extreme
 *     edge; the middleware revalidate would catch this on the next
 *     tick and strip the binding, but defense-in-depth at the
 *     render-side too)
 *
 * Page handlers wire it as:
 *   const actingAsBadge = await actingAsBadgeFromRequest(request, orgService);
 *   return reply.send(renderLayout({ ..., actingAsBadge }, body));
 */
export async function actingAsBadgeFromRequest(
  request: FastifyRequest,
  orgService: Pick<OrgService, 'getOrg'>,
): Promise<ActingAsBadge | undefined> {
  const actingAs = request.caller?.actingAs;
  if (!actingAs) return undefined;
  try {
    const customer = await orgService.getOrg(actingAs.onBehalfOfOrgId);
    if (!customer) return undefined;
    return {
      customerName: customer.name,
      exitFormAction: '/api/reseller/me/customers/exit',
    };
  } catch {
    return undefined;
  }
}

interface NavItem {
  label: string;
  href: string;
}

// Nav items are kept in lock-step with registered route handlers. Adding
// an entry here without a handler at the target path produces a sidebar
// click that 404s — surfaces as "logged in but cannot hit pages" from
// the user's perspective. When a future feature lands (Billing,
// Domains, Getting-Started docs), restore the nav item in the same PR
// that adds its route handler.
const PERSONAL_NAV: NavItem[] = [
  { label: 'Connections', href: '/settings' },
  { label: 'Profile', href: '/settings/profile' },
];

// Top-level team nav. Items not nested under the Organization sub-nav.
// PR #73 collapsed Members + Invitations + Teams + Service-Accounts +
// Billing under the Organization parent below. Remaining items stay
// top-level pending future restructure PRs (e.g. Usage parent for
// Dashboard/Connections/Tool-Access, Security parent for Audit/SCIM).
const TEAM_NAV: NavItem[] = [
  { label: 'Overview', href: '/org' },
  { label: 'Dashboard', href: '/org/dashboard' },
  { label: 'Connections', href: '/org/connections' },
  { label: 'Tool Access', href: '/org/tool-access' },
  { label: 'Server Access', href: '/org/server-access' },
  { label: 'Provisioning', href: '/org/scim' },
  { label: 'Domains', href: '/org/domains' },
  { label: 'Log Shipping', href: '/org/log-shipping' },
  { label: 'Audit Log', href: '/org/audit' },
];

// Organization sub-nav. Indented-list visual (not accordion) so all 5
// items + active state are visible at a glance. Per Aaron 2026-05-11
// IA-restructure spec. URLs unchanged this PR — service-clients URL
// rename and audit-enum atomic refactor land in PR #74; "Invites" is
// the display label here while URL stays /org/invitations
// until the same batch.
const ORGANIZATION_SUBNAV: NavItem[] = [
  { label: 'Members', href: '/org/members' },
  { label: 'Invites', href: '/org/invitations' },
  { label: 'Teams', href: '/org/teams' },
  { label: 'Service Clients', href: '/org/service-clients' },
  { label: 'Billing', href: '/org/billing' },
];

// Reseller-console nav — shown only when org.type === 'reseller'. It is
// the standard TEAM_NAV with a single "Customers" item inserted after
// Overview, matching the Figma design-of-record (Track C "Conduit —
// Subtenant Experience", Surface 1 sidebar). "Customers" lists the
// customer orgs nested under the reseller — distinct from "Members"
// (members of the reseller org itself).
// Inserted after Overview, matching the Figma S1/S4 sidebar order:
// Overview · Customers · Hierarchy. "Hierarchy" is the tenant tree view
// (Track C Surface 4) — distinct from the flat "Customers" list.
const RESELLER_CONSOLE_NAV: NavItem[] = [
  { label: 'Customers', href: '/org/customers' },
  { label: 'Hierarchy', href: '/org/hierarchy' },
];

// Reseller-settings nav — a distinct sidebar context (not Personal +
// Team). Shown on the reseller-settings shell (Track C Surface 5,
// White-Label Branding sidebar). Items are faithful to the Figma
// design-of-record; URLs namespaced under /org/reseller/.
const RESELLER_SETTINGS_NAV: NavItem[] = [
  { label: 'General', href: '/org/reseller/general' },
  { label: 'Branding', href: '/org/reseller/branding' },
  { label: 'Billing & Plans', href: '/org/reseller/billing' },
  { label: 'API & Webhooks', href: '/org/reseller/api' },
  { label: 'Audit Log', href: '/org/reseller/audit' },
];

/** Flattened nav-href list for regression-guard tests. Every entry
 *  here MUST have a registered route handler — the PR #70 lock-step
 *  invariant extended to the sub-nav structure. */
export const ALL_NAV_HREFS: ReadonlyArray<string> = [
  ...PERSONAL_NAV.map((i) => i.href),
  ...TEAM_NAV.map((i) => i.href),
  ...ORGANIZATION_SUBNAV.map((i) => i.href),
  ...RESELLER_CONSOLE_NAV.map((i) => i.href),
  ...RESELLER_SETTINGS_NAV.map((i) => i.href),
];

const LAYOUT_STYLES = `
  ${PAGE_STYLES}
  body {
    padding: 0 !important;
    display: block !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .layout {
    display: flex;
    min-height: 100vh;
  }

  /* Sidebar */
  .sidebar {
    width: 240px;
    min-width: 240px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 50;
    overflow-y: auto;
  }
  .sidebar-brand {
    padding: 20px 16px 4px;
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .sidebar-email {
    padding: 0 16px 16px;
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sidebar-section {
    padding: 12px 0 4px;
  }
  .sidebar-section-label {
    padding: 0 16px 6px;
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .sidebar-item {
    display: block;
    padding: 7px 16px 7px 14px;
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
    border-left: 2px solid transparent;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }
  .sidebar-item:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .sidebar-item.active {
    color: var(--text-primary);
    border-left-color: var(--accent);
    background: rgba(0,201,219,0.08);
  }
  /* Customer-detail sub-nav: tabs not yet built render disabled — no
     href, muted, non-interactive. Honest about what exists. */
  .sidebar-item-disabled {
    color: var(--text-muted);
    cursor: not-allowed;
  }
  .sidebar-item-disabled:hover { background: none; color: var(--text-muted); }

  /* VIEWING AS RESELLER banner card atop the customer-detail sidebar
     (Track C Surface 2, design note #1 — a persistent reminder that
     actions here affect the customer's data, not the reseller's). */
  .sidebar-customer-banner {
    margin: 4px 12px 12px;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: rgba(0,201,219,0.08);
  }
  .sidebar-customer-tag {
    display: block;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--accent-text);
  }
  .sidebar-customer-name {
    display: block;
    margin-top: 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .sidebar-customer-back {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: var(--accent-text);
    text-decoration: none;
  }
  .sidebar-customer-back:hover { text-decoration: underline; }

  /* Tenant switcher (Track C Area 3) — a native <details> dropdown. */
  .ts-switcher { margin-top: 4px; }
  .ts-summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ts-summary::-webkit-details-marker { display: none; }
  .ts-summary .sidebar-customer-name { margin-top: 0; }
  .ts-caret {
    font-size: 8px;
    color: var(--text-tertiary);
    transition: transform 0.12s;
  }
  .ts-switcher[open] .ts-caret { transform: rotate(180deg); }
  .ts-menu {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-secondary);
  }
  .ts-menu-label {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    margin: 8px 0 4px;
  }
  .ts-option {
    display: block;
    padding: 4px 0;
    font-size: 12px;
    color: var(--text-secondary);
    text-decoration: none;
  }
  .ts-option:hover { color: var(--text-primary); }
  .ts-option-reseller { color: var(--accent-text); font-weight: 500; }
  .ts-option-current {
    color: var(--text-primary);
    font-weight: 600;
    cursor: default;
  }
  .ts-option-current::before { content: '• '; color: var(--accent); }
  /* Sub-nav (PR #73 IA restructure): Organization parent label + indented
     sub-items. Parent label uses same typographic anchor as sidebar-item
     so it sits in the visual rhythm of the nav, but with muted color +
     no hover affordance because the parent isn't clickable. Sub-items
     indent 12px past sidebar-item baseline. */
  .sidebar-subnav-parent {
    display: block;
    padding: 7px 16px 7px 14px;
    margin-top: 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    border-left: 2px solid transparent;
  }
  .sidebar-subnav-parent.active {
    color: var(--text-secondary);
  }
  .sidebar-subnav-item {
    display: block;
    padding: 6px 16px 6px 28px;
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
    border-left: 2px solid transparent;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }
  .sidebar-subnav-item:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .sidebar-subnav-item.active {
    color: var(--text-primary);
    border-left-color: var(--accent);
    background: rgba(0,201,219,0.08);
  }
  .sidebar-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 8px 16px;
  }
  .sidebar-footer {
    margin-top: auto;
    padding: 8px 0 16px;
  }
  .sidebar-footer .sidebar-item {
    color: var(--text-muted);
  }
  .sidebar-footer .sidebar-item:hover {
    color: var(--text-secondary);
  }
  .sidebar-upgrade {
    margin: 8px 16px;
    padding: 12px;
    background: rgba(0,201,219,0.08);
    border: 1px solid rgba(0,201,219,0.2);
    border-radius: 6px;
    font-size: 12px;
    color: var(--accent-text);
  }
  .sidebar-upgrade a {
    color: var(--accent-text);
    text-decoration: underline;
  }

  /* Theme toggle */
  .theme-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 16px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
    background: none;
    border: none;
    font-family: inherit;
    width: 100%;
    text-align: left;
    transition: color 0.12s;
  }
  .theme-toggle:hover { color: var(--text-secondary); }
  .theme-toggle svg { width: 16px; height: 16px; flex-shrink: 0; }

  /* Content area */
  .content {
    flex: 1;
    margin-left: 240px;
    padding: 32px 40px;
    overflow-y: auto;
    min-height: 100vh;
  }
  .content-inner {
    max-width: 800px;
  }

  /* Mobile hamburger bar */
  .mobile-bar {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border-subtle);
    z-index: 60;
    align-items: center;
    padding: 0 16px;
  }
  .hamburger {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
  }
  .hamburger:hover { color: var(--text-primary); }
  .mobile-brand {
    font-family: var(--font-heading);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-left: 12px;
  }
  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    z-index: 45;
  }

  @media (max-width: 768px) {
    .sidebar {
      transform: translateX(-100%);
      transition: transform 0.2s ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .sidebar-overlay.open {
      display: block;
    }
    .mobile-bar {
      display: flex;
    }
    .content {
      margin-left: 0;
      padding-top: 64px;
      padding-left: 16px;
      padding-right: 16px;
    }
  }

  /* WYREAI-172 acting-as badge — always visible chrome when the
     operator is in customer-context. Sticky-top so it stays in view
     as the page scrolls (the impersonation signal must not be lost
     in long pages). Yellow-tinted background so it reads as
     "system-state-changed" without being alarming-red. */
  .acting-as-badge {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: -16px -16px 16px;
    padding: 10px 24px;
    background: var(--bg-acting-as, #5a4a00);
    color: var(--text-on-acting-as, #fffdf0);
    border-bottom: 1px solid rgba(255, 220, 71, 0.45);
    font-size: 13px;
  }
  .acting-as-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .acting-as-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ffdc47;
    box-shadow: 0 0 0 2px rgba(255, 220, 71, 0.25);
  }
  .acting-as-text strong {
    font-weight: 600;
    color: #ffdc47;
  }
  .acting-as-exit-form {
    margin: 0;
  }
  .acting-as-exit-btn {
    padding: 5px 12px;
    background: rgba(255, 220, 71, 0.18);
    color: #ffdc47;
    border: 1px solid rgba(255, 220, 71, 0.5);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .acting-as-exit-btn:hover {
    background: rgba(255, 220, 71, 0.32);
  }
  .acting-as-exit-btn:focus {
    outline: 2px solid #ffdc47;
    outline-offset: 1px;
  }
`;

function renderNavItem(item: NavItem, activePath: string): string {
  const isActive = activePath === item.href;
  const cls = isActive ? 'sidebar-item active' : 'sidebar-item';
  return `<a class="${cls}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
}

function renderSubNavItem(item: NavItem, activePath: string): string {
  const isActive = activePath === item.href;
  const cls = isActive ? 'sidebar-subnav-item active' : 'sidebar-subnav-item';
  return `<a class="${cls}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
}

/** Renders the reseller-settings sidebar section (Track C Surface 5). */
function renderResellerSettingsNav(orgName: string, activePath: string): string {
  return `
    <div class="sidebar-section">
      <div class="sidebar-section-label">${orgName}
        <span style="display:block;font-size:10px;font-weight:600;color:var(--accent-text);letter-spacing:0.04em;margin-top:2px">RESELLER · SETTINGS</span>
      </div>
      ${RESELLER_SETTINGS_NAV.map((item) => renderNavItem(item, activePath)).join('')}
    </div>`;
}

// Customer-detail sub-nav (Track C Surface 2). Only "Overview" is built —
// the per-org management tabs (Track C step 5 — Aaron "ship it all").
// Each is a working surface at /org/customers/:id/<slug>; the customer
// id is spliced in by renderCustomerDetailNav.
const CUSTOMER_DETAIL_TABS: ReadonlyArray<{ label: string; slug: string }> = [
  { label: 'MCPs', slug: 'mcps' },
  { label: 'Users', slug: 'users' },
  // WYREAI-172 PR-2 Members tab (boss msg-1781787576732 +
  // murph's scope-doc). Distinct from "Users" — Users is the
  // reseller-scoped read-only roster (lists members + their MCP
  // activity); Members is the actingAs-context CRUD surface
  // (invite / role-change / remove via the OWNER-scoped
  // /api/orgs/:customerOrgId/members/* endpoints under the
  // operator's acting-as binding). Without an active binding the
  // page renders a read-only list + a "Manage on behalf of" CTA;
  // with one, the action controls light up by-construction.
  { label: 'Members', slug: 'members' },
  { label: 'Usage', slug: 'usage' },
  { label: 'Tool Access', slug: 'tools' },
  { label: 'Audit Log', slug: 'audit' },
  { label: 'Billing', slug: 'billing' },
  { label: 'Settings', slug: 'settings' },
];

/**
 * Tenant switcher (Track C Area 3). A `<details>` dropdown in the
 * customer-detail banner: jump reseller→customer or customer→customer
 * without returning to the list. No JS — native disclosure, keyboard-
 * accessible. When there are no siblings to switch to it degrades to a
 * plain label (a one-entry switcher is pointless — omit, don't blank).
 */
function renderTenantSwitcher(customer: CustomerContext, resellerName: string): string {
  const name = escapeHtml(customer.name);
  const siblings = customer.siblings ?? [];
  // Only a switcher if there is somewhere else to go.
  if (siblings.length <= 1) {
    return `<span class="sidebar-customer-name">${name}</span>`;
  }
  const resellerHome = `<a class="ts-option ts-option-reseller" href="/org">&uarr; ${escapeHtml(resellerName)}</a>`;
  const options = siblings.map((t) => {
    if (t.id === customer.id) {
      return `<span class="ts-option ts-option-current" aria-current="true">${escapeHtml(t.name)}</span>`;
    }
    return `<a class="ts-option" href="/org/customers/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a>`;
  }).join('');
  return `
    <details class="ts-switcher">
      <summary class="ts-summary" aria-label="Switch tenant">
        <span class="sidebar-customer-name">${name}</span>
        <span class="ts-caret" aria-hidden="true">&#9662;</span>
      </summary>
      <div class="ts-menu">
        ${resellerHome}
        <div class="ts-menu-label">Customers</div>
        ${options}
      </div>
    </details>`;
}

/** Renders the customer-context sidebar (Track C Surface 2 + Area 3 switcher). */
function renderCustomerDetailNav(
  customer: CustomerContext,
  activePath: string,
  resellerName: string,
): string {
  const overviewHref = `/org/customers/${encodeURIComponent(customer.id)}`;
  const overviewActive = activePath === overviewHref;
  const name = escapeHtml(customer.name);
  return `
    <div class="sidebar-section">
      <div class="sidebar-customer-banner">
        <span class="sidebar-customer-tag">VIEWING AS RESELLER</span>
        ${renderTenantSwitcher(customer, resellerName)}
        <a class="sidebar-customer-back" href="/org/customers">&larr; Back to customers</a>
      </div>
      <div class="sidebar-section-label">${name}</div>
      <a class="sidebar-item ${overviewActive ? 'active' : ''}" href="${escapeHtml(overviewHref)}">Overview</a>
      ${CUSTOMER_DETAIL_TABS.map((tab) => {
        const href = `${overviewHref}/${tab.slug}`;
        const active = activePath === href;
        return `<a class="sidebar-item ${active ? 'active' : ''}" href="${escapeHtml(href)}">${escapeHtml(tab.label)}</a>`;
      }).join('')}
    </div>`;
}

/**
 * Render the WYREAI-172 acting-as badge that appears above the page
 * chrome whenever the operator is in customer-context. The Exit form
 * POSTs to /api/reseller/me/customers/exit; on success the route's
 * 303 redirect sends the operator back to /org/customers and the
 * middleware's next-tick read sees no cookie → no badge.
 *
 * a11y: `role="status"` + `aria-live="polite"` so screen-readers
 * announce the impersonation context when it changes. The Exit button
 * is a real submit (not a JS click) so the flow is link-bookmarkable
 * + works with JS disabled.
 */
function renderActingAsBadge(badge: ActingAsBadge): string {
  const name = escapeHtml(badge.customerName);
  const action = escapeHtml(badge.exitFormAction);
  return `
    <div class="acting-as-badge" role="status" aria-live="polite">
      <div class="acting-as-label">
        <span class="acting-as-dot" aria-hidden="true"></span>
        <span class="acting-as-text">Acting as <strong>${name}</strong></span>
      </div>
      <form class="acting-as-exit-form" method="POST" action="${action}">
        <button type="submit" class="acting-as-exit-btn">Exit customer context</button>
      </form>
    </div>`;
}

export function renderLayout(ctx: LayoutContext, bodyContent: string): string {
  const { user, org, activePath, title, pageStyles, pageScripts, customerContext, actingAsBadge } = ctx;
  const navMode: NavMode = ctx.navMode ?? 'default';
  const userEmail = escapeHtml(user.email || user.sub);
  const orgName = org ? escapeHtml(org.name) : '';
  // isPaidPlan is the single source of truth shared with requireTeamAccess
  // — keeps the sidebar-visibility gate matched to the handler-access
  // gate. See src/billing/gate.ts:isPaidPlan for empirical origin.
  const isPro = isPaidPlan(org?.plan);
  const brandName = escapeHtml(brand.name);
  const isReseller = org?.type === 'reseller';

  const personalNav = PERSONAL_NAV
    .map((item) => renderNavItem(item, activePath))
    .join('');

  let teamNav = '';
  if (org && isPro) {
    // Flat-pricing: one plan, no tier badge. The sidebar shows the single
    // "CONDUIT" plan label (or the reseller badge for reseller orgs).
    const planLabel = 'CONDUIT';
    const planTone = 'background:rgba(0,201,219,0.15);color:var(--accent-text)';
    const planBadge = `<span style="font-size:10px;font-weight:600;${planTone};padding:1px 5px;border-radius:3px;margin-left:6px">${planLabel}</span>`;
    const resellerBadge = isReseller
      ? `<span style="font-size:10px;font-weight:600;background:rgba(0,201,219,0.15);color:var(--accent-text);padding:1px 5px;border-radius:3px;margin-left:6px">RESELLER</span>`
      : '';

    // Reseller orgs get "Customers" + "Hierarchy" after Overview — the
    // flat customer list and the tenant tree view. Faithful to the Track
    // C Surface 1 / Surface 4 sidebar.
    const consoleNav = isReseller
      ? [TEAM_NAV[0], ...RESELLER_CONSOLE_NAV, ...TEAM_NAV.slice(1)]
      : TEAM_NAV;

    // Organization sub-nav is active when activePath is any of its hrefs.
    // Indented-list visual: parent label rendered as a sidebar-section-label
    // visual anchor, sub-items rendered with sub-item indent.
    const orgSubNavActive = ORGANIZATION_SUBNAV.some((item) => item.href === activePath);
    const orgParentCls = orgSubNavActive ? 'sidebar-subnav-parent active' : 'sidebar-subnav-parent';
    const orgSubItems = ORGANIZATION_SUBNAV
      .map((item) => renderSubNavItem(item, activePath))
      .join('');

    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">${orgName} ${planBadge}${resellerBadge}</div>
      ${consoleNav.map((item) => renderNavItem(item, activePath)).join('')}
      <div class="${orgParentCls}">Organization</div>
      ${orgSubItems}
    </div>`;
  } else if (org && !isPro) {
    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">${orgName}</div>
      <div class="sidebar-upgrade">
        Upgrade to Pro for team management, shared connections, and audit logging.
      </div>
    </div>`;
  } else {
    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">Team</div>
      <div class="sidebar-upgrade">
        <a href="/settings">Create a team</a> to share vendor connections with your colleagues.
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - ${brandName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@400;500;600&family=Nunito+Sans:wght@300;400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>
    ${LAYOUT_STYLES}
    ${pageStyles || ''}
  </style>
</head>
<body>
  <!-- Mobile top bar -->
  <div class="mobile-bar">
    <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">&#9776;</button>
    <span class="mobile-brand">${brandName}</span>
  </div>
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>

  <div class="layout">
    <!-- Sidebar -->
    <nav class="sidebar" id="sidebar">
      <div class="sidebar-brand">${brandName}</div>
      <div class="sidebar-email">${userEmail}</div>

      ${navMode === 'reseller-settings'
        ? renderResellerSettingsNav(orgName || 'Reseller', activePath)
        : navMode === 'customer-detail' && customerContext
        ? renderCustomerDetailNav(customerContext, activePath, org?.name ?? 'Reseller')
        : `<div class="sidebar-section">
        <div class="sidebar-section-label">Personal</div>
        ${personalNav}
      </div>

      ${teamNav}`}

      <div class="sidebar-footer">
        <div class="sidebar-divider"></div>
        <a class="sidebar-item" href="/">Docs</a>
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Toggle theme">
          <svg id="themeIconSun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg id="themeIconMoon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <span id="themeLabel">Dark mode</span>
        </button>
        <a class="sidebar-item" href="/auth/logout">Log out</a>
      </div>
    </nav>

    <!-- Main content -->
    <main class="content">
      <div class="content-inner">
        ${actingAsBadge ? renderActingAsBadge(actingAsBadge) : ''}
        ${bodyContent}
      </div>
    </main>
  </div>

  <script>
    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('open');
    }
    function updateThemeUI() {
      var isLight = document.documentElement.classList.contains('light');
      document.getElementById('themeIconSun').style.display = isLight ? 'block' : 'none';
      document.getElementById('themeIconMoon').style.display = isLight ? 'none' : 'block';
      document.getElementById('themeLabel').textContent = isLight ? 'Light mode' : 'Dark mode';
    }
    function toggleTheme() {
      document.documentElement.classList.toggle('light');
      var isLight = document.documentElement.classList.contains('light');
      localStorage.setItem('gateway-theme', isLight ? 'light' : 'dark');
      updateThemeUI();
    }
    updateThemeUI();
  </script>
  ${pageScripts || ''}
</body>
</html>`;
}
