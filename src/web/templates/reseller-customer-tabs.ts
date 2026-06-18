import type { Organization } from "../../org/org-service.js";
import type { CustomerSummary } from "./reseller-customer-detail.js";
import type { VendorHealthState } from "../../monitoring/vendor-monitor.js";
import { escapeHtml, jsonForScriptEmbed } from "../helpers.js";

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
  | "mcps"
  | "users"
  // WYREAI-172 PR-2 Members tab (boss msg-1781787576732). Distinct
  // from "users" (read-only roster) — "members" is the actingAs-
  // context CRUD surface for the customer-org's membership.
  | "members"
  // WYREAI-172 PR-2.5 Teams tab (boss msg-1781787643789).
  // Customer-org teams + per-team vendor allowlists — the
  // launch-value Aaron flagged (per-team server-access > team-
  // CRUD-for-org-chart). Same actingAs-context-(C) substrate as
  // Members, multiplied across team-CRUD + team-members + team-
  // server-access endpoints.
  | "teams"
  | "usage"
  | "tools"
  | "audit"
  | "billing"
  | "settings";

export interface McpRow {
  vendor: string;
  pattern: string;
  seats: string;
  // Full vendor-health union (shared with the connections health-dot): adds
  // 'reachable' (auth-gated probe, alive) + 'unknown' (not yet probed) beyond
  // healthy/degraded/down. See vendor-monitor.deriveVendorHealth.
  status: VendorHealthState;
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

/**
 * WYREAI-172 PR-2 Members tab — CRUD member row shape. Distinct from
 * the read-only `MemberRow` (Users tab) because the CRUD surface needs
 * stable identifiers for the action-targeting POST/PATCH/DELETE calls.
 *
 *   - id: org_members.id — the row id (used as target for DELETE
 *     /api/orgs/:customerOrgId/members/:userId and PATCH /role)
 *   - userId: auth0 sub — used as the URL :userId param
 *   - role: 'owner' | 'admin' | 'member' — string-typed at the
 *     template layer to keep the role-change dropdown's option-list
 *     loose-coupled to the canonical OrgRole union (future role
 *     additions don't break the template by-construction)
 *   - canChangeRole: false for the customer-org-owner (the system
 *     guards owner-role-change at the route layer; surfacing the
 *     dropdown for the owner would 403 immediately, which reads as
 *     UI-broken rather than as-designed)
 *   - canRemove: false for the customer-org-owner + for the operator
 *     themselves if they happen to be in the customer-org membership
 *     too (self-remove from acting-as context is a footgun)
 */
export interface MemberCrudRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  canChangeRole: boolean;
  canRemove: boolean;
}

/**
 * WYREAI-172 PR-2.5 Teams tab — CRUD row shape per customer-org
 * team. Aaron's launch-value is the per-team vendor allowlist
 * (msg-1781787643789), so the row carries both the org-chart members
 * AND the vendor allowlist by-construction. The accordion-expand UI
 * pulls both lists onto one screen so the operator doesn't context-
 * switch between sub-pages for what's logically one management
 * scope ("team X has people P + vendors V").
 *
 *   - id: org_teams.id — target for PATCH /teams/:teamId (rename) +
 *     DELETE /teams/:teamId
 *   - name: display name
 *   - members: minimal shape (userId + display name + email) for
 *     the inline member-list. The add-member control is a free-form
 *     email picker; the remove control is a per-row button
 *   - vendorAllowlist: list of vendor slugs the team has server-
 *     access to. The grant-vendor control is a dropdown of
 *     candidate slugs (from `vendorCatalog` field on CustomerTabData
 *     — same source the Tool Access tab consumes); the revoke
 *     control is a per-row chip-X button
 */
export interface TeamCrudRow {
  id: string;
  name: string;
  members: Array<{
    userId: string;
    name: string;
    email: string;
  }>;
  vendorAllowlist: string[];
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
  /**
   * WYREAI-172 PR-2 Members tab fields. Optional so existing tab call
   * sites that don't pass them keep compiling — the renderMembers
   * function gracefully degrades to "no actingAs binding" state when
   * `actingAsActive` is undefined/false.
   *
   * - actingAsActive: true ONLY when the request's caller has an
   *   active acting-as binding targeting THIS customer-org. The page
   *   handler computes this by comparing
   *   `request.caller?.actingAs?.onBehalfOfOrgId === customer.id`.
   *   Without this binding the Members tab renders the read-only
   *   list + the "Manage on behalf of {name}" CTA; with it, the
   *   action controls light up.
   * - crudMembers: the row shape needed for the CRUD UI. Distinct
   *   from `members` (MemberRow) which carries the read-only Users-
   *   tab view-data; CRUD needs stable id + role-mutability flags.
   */
  actingAsActive?: boolean;
  crudMembers?: MemberCrudRow[];
  /**
   * WYREAI-172 PR-2.5 Teams tab fields. Optional so call-sites that
   * don't render the Teams tab keep compiling — renderTeams gracefully
   * degrades to "no teams" empty-state when undefined.
   *
   * - teams: the customer-org's teams + per-team members + per-team
   *   vendor allowlist (denormalized in the page handler via
   *   listTeamsWithDetails). Read-only when actingAsActive=false;
   *   action controls light up when active.
   * - vendorCatalog: the customer-org's connected-vendor slugs +
   *   display names. Source: orgService.listOrgVendors(customerOrgId)
   *   — same source the Tool Access tab consumes. Used by the
   *   "grant vendor to team" dropdown's option list. Omit/empty →
   *   the grant control degrades to "no vendors connected yet".
   * - membersForTeamPicker: the customer-org's members (id + name +
   *   email), shape borrowed from MemberCrudRow but with role +
   *   lock flags stripped (the team-membership operation doesn't
   *   need them — anyone in the customer-org can be added to any
   *   team). Used as the add-to-team picker's source.
   */
  teams?: TeamCrudRow[];
  vendorCatalog?: Array<{ slug: string; name: string }>;
  membersForTeamPicker?: Array<{ userId: string; name: string; email: string }>;
}

const TAB_TITLE: Record<CustomerTabId, string> = {
  mcps: "MCPs",
  users: "Users",
  members: "Members",
  teams: "Teams",
  usage: "Usage",
  tools: "Tool Access",
  audit: "Audit Log",
  billing: "Billing",
  settings: "Settings",
};

// ---- shared chrome -------------------------------------------------------

function renderChrome(data: CustomerTabData, body: string): string {
  const { org, customer, tab } = data;
  const name = escapeHtml(customer.name);
  const base = `/org/customers/${encodeURIComponent(customer.id)}`;
  const title = escapeHtml(TAB_TITLE[tab] ?? "Customer");
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
    <p class="section-desc">${name}</p>
    ${body}
  `;
}

// RC4 customer-facing dev-language leak fix (ruby 2026-06-05, Aaron-
// flagged at staging): the seam() helper previously rendered the
// internal "Mock-data-first. SWAP-IN CONTRACT: ..." dev-documentation
// directly as a visible <p> in the customer-facing UI (dashed-border
// box at the bottom of each tab). Customers saw literal compiler-
// engineer language. Now suppressed at the helper-substrate — single
// site closes all 5 seam-call leak-throughs (MCPs / Users / Tool
// Access / Billing / Settings tabs) by-construction. The seam-comments
// remain in the source as the documented swap-in contract for the
// real-data wiring work; the renderer is silent until that work lands.
// Argument is kept (vs removed) so call-sites stay stable + the
// source-grep regression-guard tracks each call-site for the eventual
// real-data swap-in audit.
function seam(_text: string): string {
  return "";
}

// ---- tab: MCPs -----------------------------------------------------------

function renderMcps(data: CustomerTabData): string {
  const dot: Record<McpRow["status"], string> = {
    healthy: "cdt-dot-healthy",
    reachable: "cdt-dot-reachable",
    degraded: "cdt-dot-degraded",
    down: "cdt-dot-down",
    unknown: "cdt-dot-unknown",
  };
  const rows = data.mcps
    .map(
      (m) => `
    <tr>
      <td class="cdt-strong">${escapeHtml(m.vendor)}</td>
      <td>${escapeHtml(m.pattern)}</td>
      <td>${escapeHtml(m.seats)}</td>
      <td><span class="cdt-dot ${dot[m.status]}"></span>${escapeHtml(m.status)}</td>
    </tr>`,
    )
    .join("");
  return renderChrome(
    data,
    `
    <table class="cdt-table">
      <thead><tr><th scope="col">Vendor</th><th scope="col">Wiring</th><th scope="col">Seats</th><th scope="col">Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="cdt-empty">No MCPs connected.</td></tr>`}</tbody>
    </table>
    ${seam("Mock-data-first. SWAP-IN CONTRACT: the real MCP-connection query MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).")}`,
  );
}

// ---- tab: Users ----------------------------------------------------------

function renderUsers(data: CustomerTabData): string {
  const customerId = escapeHtml(data.customer.id);
  const resellerId = escapeHtml(data.org.id);
  const rows = data.members
    .map(
      (u) => `
    <tr>
      <td><div class="cdt-strong">${escapeHtml(u.name)}</div><div class="cdt-sub">${escapeHtml(u.email)}</div></td>
      <td>${escapeHtml(u.role)}</td>
      <td>${escapeHtml(u.department)}</td>
      <td>${escapeHtml(u.toolAccess)}</td>
      <td class="cdt-activity">${escapeHtml(u.lastActive)}</td>
    </tr>`,
    )
    .join("");
  const more =
    data.memberTotal > data.members.length
      ? `<p class="cdt-more">+ ${data.memberTotal - data.members.length} more users</p>`
      : "";

  // 2026-06-12 Aaron-flagged "can't add users on /org/customers/<id>". The
  // backend POST /api/orgs/:orgId/invitations endpoint has existed since
  // the reseller-console RC; the reseller_admin (and the customer-org
  // owner, which the reseller becomes at customer-create time) is granted
  // `admin` role on the customer org and can therefore call it. Only the
  // UI surface was missing. This adds:
  //   - "Invite user" button in the Users tab toolbar
  //   - inline modal with an email input (matches team-invitations.ts shape)
  //   - JS that POSTs to /api/orgs/<customerId>/invitations and surfaces the
  //     copy-link the API returns in plaintext (the only moment it exists)
  // No new backend endpoint is needed — the existing org invitation route
  // handles auth, rate-limiting (10/hour), audit logging, and optional
  // email delivery.
  const inviteToolbar = `
    <div class="cdt-toolbar">
      <button type="button" class="cdt-btn-invite" onclick="cdtShowInviteModal()">+ Invite user</button>
    </div>`;
  const inviteModal = `
    <div id="cdtInviteOverlay" class="cdt-modal-overlay" style="display:none" aria-hidden="true">
      <div class="cdt-modal" role="dialog" aria-modal="true" aria-labelledby="cdtInviteTitle">
        <h2 id="cdtInviteTitle" class="cdt-modal-title">Invite a user to this customer</h2>
        <p class="cdt-modal-desc">They will receive an invitation email if you provide an address. The invite link is also shown so you can share it any other way.</p>
        <label class="cdt-modal-label" for="cdtInviteEmail">Email (optional)</label>
        <input type="email" id="cdtInviteEmail" class="cdt-modal-input" placeholder="user@example.com" autocomplete="off" />
        <div id="cdtInviteResult" class="cdt-modal-result" style="display:none"></div>
        <div id="cdtInviteError" class="cdt-modal-error" style="display:none"></div>
        <div class="cdt-modal-actions">
          <button type="button" class="cdt-btn-secondary" onclick="cdtCloseInviteModal()">Close</button>
          <button type="button" id="cdtInviteSubmit" class="cdt-btn-primary" onclick="cdtCreateInvite('${resellerId}', '${customerId}')">Create invite</button>
        </div>
      </div>
    </div>`;
  const inviteScript = `
    <script>
      function cdtShowInviteModal() {
        document.getElementById('cdtInviteOverlay').style.display = 'flex';
        document.getElementById('cdtInviteOverlay').setAttribute('aria-hidden', 'false');
        document.getElementById('cdtInviteEmail').focus();
      }
      function cdtCloseInviteModal() {
        document.getElementById('cdtInviteOverlay').style.display = 'none';
        document.getElementById('cdtInviteOverlay').setAttribute('aria-hidden', 'true');
        document.getElementById('cdtInviteEmail').value = '';
        document.getElementById('cdtInviteResult').style.display = 'none';
        document.getElementById('cdtInviteError').style.display = 'none';
      }
      async function cdtCreateInvite(resellerId, customerId) {
        var btn = document.getElementById('cdtInviteSubmit');
        var err = document.getElementById('cdtInviteError');
        var result = document.getElementById('cdtInviteResult');
        var email = (document.getElementById('cdtInviteEmail').value || '').trim();
        btn.disabled = true; btn.textContent = 'Creating…';
        err.style.display = 'none'; result.style.display = 'none';
        try {
          // 2026-06-12 launch-day workaround: route through the reseller-
          // scoped endpoint instead of /api/orgs/<customerId>/invitations,
          // which hangs on customer-org POSTs (likely RLS interaction —
          // tracked separately for post-launch root-cause). The new route
          // enforces reseller_admin role + parent-org check + skips the
          // customer-org billing-gate (reseller is the paying entity).
          var res = await fetch('/admin/reseller/' + resellerId + '/customers/' + customerId + '/invitations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(email ? { email: email } : {}),
          });
          var data = await res.json();
          if (!res.ok) {
            err.textContent = data && data.error ? data.error : 'Failed to create invite (' + res.status + ')';
            err.style.display = 'block';
            return;
          }
          // Build the success block with DOM methods, not innerHTML — the
          // email value is user-supplied input and the URL is a string we
          // render to the user. textContent + structured node creation
          // keeps both attacker-controlled fields out of HTML-parsing
          // path. 2026-06-12 post-XSS-review hardening.
          while (result.firstChild) result.removeChild(result.firstChild);
          var label = document.createElement('div');
          label.className = 'cdt-modal-result-label';
          label.textContent = 'Invite link (copy + share):';
          var url = data.inviteUrl || (window.location.origin + '/invite/' + (data.token || ''));
          var code = document.createElement('code');
          code.className = 'cdt-modal-result-url';
          code.textContent = url;
          var hint = document.createElement('div');
          hint.className = 'cdt-modal-result-hint';
          if (email) {
            hint.appendChild(document.createTextNode('Also emailed to '));
            var emailNode = document.createElement('strong');
            emailNode.textContent = email;
            hint.appendChild(emailNode);
            hint.appendChild(document.createTextNode('.'));
          } else {
            hint.textContent = 'No email sent. Share the link manually.';
          }
          result.appendChild(label);
          result.appendChild(code);
          result.appendChild(hint);
          result.style.display = 'block';
        } catch (e) {
          err.textContent = 'Network error: ' + (e && e.message ? e.message : 'unknown');
          err.style.display = 'block';
        } finally {
          btn.disabled = false; btn.textContent = 'Create invite';
        }
      }
    </script>`;

  return renderChrome(
    data,
    `
    ${inviteToolbar}
    <table class="cdt-table">
      <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Department</th><th scope="col">Tool Access</th><th scope="col">Last Active</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="cdt-empty">No members yet.</td></tr>`}</tbody>
    </table>
    ${more}
    ${inviteModal}
    ${inviteScript}
    ${seam("Mock-data-first. SWAP-IN CONTRACT: the real org-member query MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).")}`,
  );
}

// ---- tab: Members (WYREAI-172 PR-2, boss msg-1781787576732) -------------
//
// CRUD surface for the customer-org's membership. Calls existing OWNER-
// scoped /api/orgs/:customerOrgId/members/* endpoints under the actingAs
// auth-context — substrate (C) from murph's scope-doc: substrate reuse
// over parallel reseller-scoped endpoints.
//
// Without an active acting-as binding the page renders a read-only list
// + a "Manage on behalf of {name}" CTA pointing at /switch (the same
// foundation primitive shipped in #454). With an active binding for THIS
// customer-org, the action controls (Invite + per-row role-dropdown +
// per-row Remove) light up.
//
// Endpoints consumed (all gated by requireOrgRoleForWrite admin-threshold,
// PATH B honors the actingAs binding):
//   POST   /api/orgs/:customerOrgId/invitations
//   PATCH  /api/orgs/:customerOrgId/members/:userId/role
//   DELETE /api/orgs/:customerOrgId/members/:userId

function renderMembers(data: CustomerTabData): string {
  const customerName = escapeHtml(data.customer.name);
  const customerId = encodeURIComponent(data.customer.id);

  // Disabled-state body — renders when the operator does NOT have an
  // active acting-as binding for this customer. Shows the read-only
  // roster + a CTA to enter customer-context via the same /switch
  // endpoint that ships in #454. The native form action is the /switch
  // endpoint so the flow works even without JS (browser does a plain
  // POST → 200 + cookie → manual refresh shows the badge + lit-up
  // controls). With JS the page-script intercepts + reloads in-place.
  if (!data.actingAsActive) {
    const readonlyRows = data.members
      .map(
        (m) => `
        <tr>
          <td>
            <div class="cdt-strong">${escapeHtml(m.name)}</div>
            <div class="cdt-sub">${escapeHtml(m.email)}</div>
          </td>
          <td>${escapeHtml(m.role)}</td>
        </tr>`,
      )
      .join("");
    const more =
      data.memberTotal > data.members.length
        ? `<p class="cdt-more">+ ${data.memberTotal - data.members.length} more members</p>`
        : "";
    return renderChrome(
      data,
      `
      <div class="cdt-acting-as-cta" role="status">
        <p class="cdt-acting-as-cta-title">Manage on behalf of ${customerName}</p>
        <p class="cdt-acting-as-cta-desc">
          To invite, change roles, or remove members from
          ${customerName}'s organization, enter customer context. The
          actions will light up + audit-trail your actions on their
          behalf.
        </p>
        <form
          method="POST"
          action="/api/reseller/me/customers/${customerId}/switch"
          class="cdt-acting-as-cta-form"
          id="cdtMembersSwitchForm"
        >
          <button type="submit" class="cdt-btn-primary" id="cdtMembersSwitchBtn">Manage on behalf of ${customerName}</button>
          <span class="cdt-acting-as-cta-status" id="cdtMembersSwitchStatus" role="status" aria-live="polite"></span>
        </form>
      </div>

      <h2 class="cdt-section-title">Current members</h2>
      <p class="cdt-section-desc">Read-only view. Enter customer context above to manage.</p>
      <table class="cdt-table cdt-table-readonly">
        <thead>
          <tr><th>Member</th><th>Role</th></tr>
        </thead>
        <tbody>${readonlyRows || `<tr><td colspan="2" class="cdt-empty">No members yet.</td></tr>`}</tbody>
      </table>
      ${more}`,
    );
  }

  // Active-state body — operator IS acting-as this customer. Render
  // the full CRUD UI: Invite button + per-row role dropdown + Remove
  // button. Action controls are wired by JS (membersScript) to the
  // OWNER-scoped endpoints; native form fallback works for the Invite
  // submit (browser does a plain POST → 200 with the invite payload).
  const crudRows = (data.crudMembers ?? [])
    .map((m) => {
      const idAttr = escapeHtml(m.userId);
      const roleSelect = m.canChangeRole
        ? `
          <select
            class="cdt-role-select"
            data-action="role"
            data-user-id="${idAttr}"
            data-current-role="${escapeHtml(m.role)}"
            aria-label="Change role for ${escapeHtml(m.name)}"
          >
            <option value="owner"${m.role === "owner" ? " selected" : ""}>owner</option>
            <option value="admin"${m.role === "admin" ? " selected" : ""}>admin</option>
            <option value="member"${m.role === "member" ? " selected" : ""}>member</option>
          </select>`
        : `<span class="cdt-role-locked" title="The customer-org owner's role cannot be changed from this surface.">${escapeHtml(m.role)} <span aria-hidden="true">🔒</span></span>`;
      const removeBtn = m.canRemove
        ? `<button
            type="button"
            class="cdt-btn-row-remove"
            data-action="remove"
            data-user-id="${idAttr}"
            data-user-name="${escapeHtml(m.name)}"
          >Remove</button>`
        : `<span class="cdt-row-actions-locked" title="The customer-org owner cannot be removed from this surface.">—</span>`;
      return `
      <tr data-member-row="${idAttr}">
        <td>
          <div class="cdt-strong">${escapeHtml(m.name)}</div>
          <div class="cdt-sub">${escapeHtml(m.email)}</div>
        </td>
        <td>${roleSelect}</td>
        <td class="cdt-row-actions">${removeBtn}</td>
      </tr>`;
    })
    .join("");

  return renderChrome(
    data,
    `
    <div class="cdt-members-toolbar">
      <button type="button" class="cdt-btn-primary" id="cdtMembersInviteBtn">+ Invite member</button>
      <span class="cdt-members-status" id="cdtMembersStatus" role="status" aria-live="polite"></span>
    </div>

    <table class="cdt-table">
      <thead>
        <tr><th>Member</th><th>Role</th><th class="cdt-row-actions">Actions</th></tr>
      </thead>
      <tbody id="cdtMembersTbody">${crudRows || `<tr><td colspan="3" class="cdt-empty">No members yet. Invite the first.</td></tr>`}</tbody>
    </table>

    <!-- Invite modal -->
    <div
      id="cdtMembersInviteModal"
      class="cdt-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cdtMembersInviteTitle"
      style="display:none"
      aria-hidden="true"
    >
      <div class="cdt-modal">
        <h2 id="cdtMembersInviteTitle" class="cdt-modal-title">Invite a member to ${customerName}</h2>
        <p class="cdt-modal-desc">
          Their invite email is optional — if provided they receive an
          invitation link. The copy-link is also shown so you can share
          it any other way.
        </p>
        <label class="cdt-modal-label" for="cdtMembersInviteEmail">Email (optional)</label>
        <input
          type="email"
          id="cdtMembersInviteEmail"
          class="cdt-modal-input"
          placeholder="user@example.com"
          autocomplete="off"
        />
        <div id="cdtMembersInviteResult" class="cdt-modal-result" style="display:none"></div>
        <div id="cdtMembersInviteError" class="cdt-modal-error" style="display:none"></div>
        <div class="cdt-modal-actions">
          <button type="button" class="cdt-btn-secondary" id="cdtMembersInviteClose">Close</button>
          <button type="button" class="cdt-btn-primary" id="cdtMembersInviteSubmit">Create invite</button>
        </div>
      </div>
    </div>`,
  );
}

/**
 * WYREAI-172 PR-2 Members tab client script. Handles:
 *   1. /switch CTA submit (read-only state) — same shape as the
 *      customer-detail page's actingAs script: preventDefault →
 *      fetch /switch → reload page in-place on 200 (the badge +
 *      action controls light up on the next render).
 *   2. Invite modal open/close + submit → POST OWNER-scoped
 *      /api/orgs/:customerOrgId/invitations. Shows the copy-link in
 *      the result block (the invite token is shown ONCE — never
 *      re-displayed).
 *   3. Role-change dropdown — PATCH OWNER-scoped
 *      /api/orgs/:customerOrgId/members/:userId/role. On revert/
 *      failure the dropdown snaps back to the previous value via the
 *      stored data-current-role attribute.
 *   4. Remove button — confirms via window.confirm (lightweight modal
 *      would be heavier than the destruction-class warrants) then
 *      DELETE OWNER-scoped /api/orgs/:customerOrgId/members/:userId.
 *      On success the row is removed from the DOM in-place.
 *
 * All actions go through the OWNER-scoped endpoints; the actingAs
 * binding is in the cookie (set by #454's /switch), and the OWNER-
 * scoped requireOrgRoleForWrite PATH B consumes it. No new authz.
 *
 * Status routing matches the customer-detail conventions:
 *   200/201 → success message (auto-clears after a few seconds)
 *   400     → server-provided error message
 *   403     → "You don't have permission for this action."
 *   409     → server-provided conflict message (e.g. owner-role lock)
 *   429     → "Rate limit hit. Try again in a few minutes."
 *   network → "Network error. Check connection and retry."
 */
function membersScript(customerId: string, actingAsActive: boolean): string {
  return `
<script>
  (function () {
    var CUSTOMER_ID = ${jsonForScriptEmbed(customerId)};
    var ACTING_AS = ${actingAsActive ? "true" : "false"};

    function setStatus(el, text, isError) {
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('cdt-members-status-error', !!isError);
    }

    // --- /switch CTA (read-only state) ---
    var switchForm = document.getElementById('cdtMembersSwitchForm');
    var switchBtn = document.getElementById('cdtMembersSwitchBtn');
    var switchStatus = document.getElementById('cdtMembersSwitchStatus');
    if (switchForm && switchBtn) {
      switchForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        switchBtn.disabled = true;
        setStatus(switchStatus, 'Starting session…', false);
        fetch('/api/reseller/me/customers/' + encodeURIComponent(CUSTOMER_ID) + '/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.status === 200) {
            // Reload in place — the next render sees the actingAs
            // cookie + lit-up action controls.
            window.location.reload();
            return;
          }
          switchBtn.disabled = false;
          if (res.status === 403) {
            setStatus(switchStatus, "You don't have permission to act on behalf of this customer.", true);
            return;
          }
          if (res.status === 429) {
            setStatus(switchStatus, 'Rate limit hit. Try again in a few minutes.', true);
            return;
          }
          setStatus(switchStatus, 'Could not start customer session (HTTP ' + res.status + ').', true);
        }).catch(function () {
          switchBtn.disabled = false;
          setStatus(switchStatus, 'Network error. Check connection and retry.', true);
        });
      });
    }

    if (!ACTING_AS) return; // CRUD controls don't exist in read-only state

    var statusEl = document.getElementById('cdtMembersStatus');
    var inviteBtn = document.getElementById('cdtMembersInviteBtn');
    var inviteModal = document.getElementById('cdtMembersInviteModal');
    var inviteEmail = document.getElementById('cdtMembersInviteEmail');
    var inviteResult = document.getElementById('cdtMembersInviteResult');
    var inviteError = document.getElementById('cdtMembersInviteError');
    var inviteSubmit = document.getElementById('cdtMembersInviteSubmit');
    var inviteClose = document.getElementById('cdtMembersInviteClose');

    function openInvite() {
      inviteModal.style.display = 'flex';
      inviteModal.setAttribute('aria-hidden', 'false');
      if (inviteEmail) {
        inviteEmail.value = '';
        inviteEmail.focus();
      }
      if (inviteResult) inviteResult.style.display = 'none';
      if (inviteError) inviteError.style.display = 'none';
    }
    function closeInvite() {
      inviteModal.style.display = 'none';
      inviteModal.setAttribute('aria-hidden', 'true');
    }
    if (inviteBtn) inviteBtn.addEventListener('click', openInvite);
    if (inviteClose) inviteClose.addEventListener('click', closeInvite);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && inviteModal && inviteModal.style.display !== 'none') {
        closeInvite();
      }
    });

    if (inviteSubmit) {
      inviteSubmit.addEventListener('click', function () {
        var email = (inviteEmail && inviteEmail.value || '').trim();
        inviteSubmit.disabled = true;
        inviteSubmit.textContent = 'Creating…';
        if (inviteError) inviteError.style.display = 'none';
        if (inviteResult) inviteResult.style.display = 'none';
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(email ? { email: email } : {}),
        }).then(function (res) {
          inviteSubmit.disabled = false;
          inviteSubmit.textContent = 'Create invite';
          if (res.status === 201 || res.status === 200) {
            return res.json().then(function (data) {
              if (inviteResult) {
                inviteResult.style.display = 'block';
                inviteResult.textContent = data && data.url
                  ? 'Invite link (shown only once). Copy now: ' + data.url
                  : 'Invite created.';
              }
            });
          }
          return res.json().then(function (data) {
            var msg = (data && data.error) ? data.error : ('Could not create invite (HTTP ' + res.status + ').');
            if (res.status === 403) msg = "You don't have permission for this action.";
            if (res.status === 429) msg = 'Rate limit hit. Try again in a few minutes.';
            if (inviteError) {
              inviteError.style.display = 'block';
              inviteError.textContent = msg;
            }
          }).catch(function () {
            if (inviteError) {
              inviteError.style.display = 'block';
              inviteError.textContent = 'Could not create invite (HTTP ' + res.status + ').';
            }
          });
        }).catch(function () {
          inviteSubmit.disabled = false;
          inviteSubmit.textContent = 'Create invite';
          if (inviteError) {
            inviteError.style.display = 'block';
            inviteError.textContent = 'Network error. Check connection and retry.';
          }
        });
      });
    }

    // --- Role change + Remove (delegated handlers on tbody) ---
    var tbody = document.getElementById('cdtMembersTbody');
    if (!tbody) return;

    tbody.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || t.dataset.action !== 'role') return;
      var userId = t.dataset.userId;
      var newRole = t.value;
      var prevRole = t.dataset.currentRole;
      if (newRole === prevRole) return;
      t.disabled = true;
      setStatus(statusEl, 'Updating role…', false);
      fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/members/' + encodeURIComponent(userId) + '/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role: newRole }),
      }).then(function (res) {
        t.disabled = false;
        if (res.ok) {
          t.dataset.currentRole = newRole;
          setStatus(statusEl, 'Role updated.', false);
          setTimeout(function () { setStatus(statusEl, '', false); }, 3000);
          return;
        }
        // Snap dropdown back to the prior value on failure.
        t.value = prevRole;
        return res.json().then(function (data) {
          var msg = (data && data.error) ? data.error : ('Role change failed (HTTP ' + res.status + ').');
          if (res.status === 403) msg = "You don't have permission for this action.";
          if (res.status === 409) msg = (data && data.error) || 'Role change rejected.';
          if (res.status === 429) msg = 'Rate limit hit. Try again in a few minutes.';
          setStatus(statusEl, msg, true);
        }).catch(function () {
          setStatus(statusEl, 'Role change failed (HTTP ' + res.status + ').', true);
        });
      }).catch(function () {
        t.disabled = false;
        t.value = prevRole;
        setStatus(statusEl, 'Network error. Check connection and retry.', true);
      });
    });

    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || t.dataset.action !== 'remove') return;
      var userId = t.dataset.userId;
      var userName = t.dataset.userName || 'this member';
      if (!window.confirm('Remove ' + userName + ' from the customer-org? This is reversible only by re-inviting.')) return;
      t.disabled = true;
      setStatus(statusEl, 'Removing…', false);
      fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/members/' + encodeURIComponent(userId), {
        method: 'DELETE',
        credentials: 'same-origin',
      }).then(function (res) {
        if (res.ok || res.status === 204) {
          var row = tbody.querySelector('tr[data-member-row="' + CSS.escape(userId) + '"]');
          if (row && row.parentNode) row.parentNode.removeChild(row);
          setStatus(statusEl, 'Member removed.', false);
          setTimeout(function () { setStatus(statusEl, '', false); }, 3000);
          return;
        }
        t.disabled = false;
        return res.json().then(function (data) {
          var msg = (data && data.error) ? data.error : ('Remove failed (HTTP ' + res.status + ').');
          if (res.status === 403) msg = "You don't have permission for this action.";
          if (res.status === 429) msg = 'Rate limit hit. Try again in a few minutes.';
          setStatus(statusEl, msg, true);
        }).catch(function () {
          setStatus(statusEl, 'Remove failed (HTTP ' + res.status + ').', true);
        });
      }).catch(function () {
        t.disabled = false;
        setStatus(statusEl, 'Network error. Check connection and retry.', true);
      });
    });
  })();
</script>`;
}

// ---- tab: Teams (WYREAI-172 PR-2.5, Aaron-launch-required) --------------
//
// Customer-org teams + per-team vendor allowlists. Aaron's launch-value
// is the per-team server-access (msg-1781787643789) — the team-CRUD-for-
// org-chart is the carrier; the per-team vendor allowlist is the payload.
//
// Same actingAs-context-(C) substrate as Members, multiplied across:
//   POST   /api/orgs/:customerOrgId/teams                    — create team
//   PATCH  /api/orgs/:customerOrgId/teams/:teamId            — rename team
//   DELETE /api/orgs/:customerOrgId/teams/:teamId            — delete team
//   PUT    /api/orgs/:customerOrgId/teams/:teamId/members/:userId
//                                                            — add member to team
//   DELETE /api/orgs/:customerOrgId/teams/:teamId/members/:userId
//                                                            — remove member
//   PUT    /api/orgs/:customerOrgId/teams/:teamId/server-access/:vendor
//                                                            — grant vendor to team
//   DELETE /api/orgs/:customerOrgId/teams/:teamId/server-access/:vendor
//                                                            — revoke vendor from team
//
// All requireOrgRoleForWrite admin — actingAs PATH B consumes the binding
// from #441 + the audit-triplet auto-tags every operator action.

function renderTeams(data: CustomerTabData): string {
  const customerName = escapeHtml(data.customer.name);
  const customerId = encodeURIComponent(data.customer.id);

  // Read-only state — operator does NOT have an active acting-as
  // binding for this customer. Mirror the Members tab pattern: show
  // the read-only team list + a CTA to enter context.
  if (!data.actingAsActive) {
    const teams = data.teams ?? [];
    const rows = teams
      .map(
        (t) => `
        <tr>
          <td><div class="cdt-strong">${escapeHtml(t.name)}</div></td>
          <td>${t.members.length}</td>
          <td>${t.vendorAllowlist.length}</td>
        </tr>`,
      )
      .join("");
    return renderChrome(
      data,
      `
      <div class="cdt-acting-as-cta" role="status">
        <p class="cdt-acting-as-cta-title">Manage on behalf of ${customerName}</p>
        <p class="cdt-acting-as-cta-desc">
          To create teams, change membership, or adjust per-team vendor
          allowlists for ${customerName}, enter customer context. The
          actions will light up + audit-trail your actions on their behalf.
        </p>
        <form
          method="POST"
          action="/api/reseller/me/customers/${customerId}/switch"
          class="cdt-acting-as-cta-form"
          id="cdtTeamsSwitchForm"
        >
          <button type="submit" class="cdt-btn-primary" id="cdtTeamsSwitchBtn">Manage on behalf of ${customerName}</button>
          <span class="cdt-acting-as-cta-status" id="cdtTeamsSwitchStatus" role="status" aria-live="polite"></span>
        </form>
      </div>

      <h2 class="cdt-section-title">Current teams</h2>
      <p class="cdt-section-desc">Read-only view. Enter customer context above to manage.</p>
      <table class="cdt-table cdt-table-readonly">
        <thead>
          <tr><th>Team</th><th>Members</th><th>Vendor allowlist</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="3" class="cdt-empty">No teams yet.</td></tr>`}</tbody>
      </table>`,
    );
  }

  // Active state — full CRUD UI. Each team row expands to a per-team
  // accordion with members + vendor allowlist controls.
  const teams = data.teams ?? [];
  const vendorCatalog = data.vendorCatalog ?? [];
  const membersForPicker = data.membersForTeamPicker ?? [];

  const teamRows = teams
    .map((t) => {
      const teamIdAttr = escapeHtml(t.id);
      const teamName = escapeHtml(t.name);
      const memberRows = t.members
        .map(
          (m) => `
          <li class="cdt-team-member-row" data-team-member="${escapeHtml(m.userId)}">
            <span class="cdt-team-member-name">${escapeHtml(m.name)}</span>
            <span class="cdt-team-member-email">${escapeHtml(m.email)}</span>
            <button
              type="button"
              class="cdt-btn-row-remove cdt-btn-team-member-remove"
              data-action="team-remove-member"
              data-team-id="${teamIdAttr}"
              data-user-id="${escapeHtml(m.userId)}"
              data-user-name="${escapeHtml(m.name)}"
            >Remove</button>
          </li>`,
        )
        .join("");
      const vendorChips = t.vendorAllowlist
        .map((slug) => {
          const slugEsc = escapeHtml(slug);
          const display =
            vendorCatalog.find((v) => v.slug === slug)?.name ?? slug;
          return `
          <span class="cdt-team-vendor-chip" data-team-vendor="${slugEsc}">
            <span class="cdt-team-vendor-name">${escapeHtml(display)}</span>
            <button
              type="button"
              class="cdt-team-vendor-revoke"
              aria-label="Revoke ${escapeHtml(display)}"
              data-action="team-revoke-vendor"
              data-team-id="${teamIdAttr}"
              data-vendor-slug="${slugEsc}"
            >×</button>
          </span>`;
        })
        .join("");
      // Vendor-grant dropdown: only the catalog slugs NOT already on
      // the allowlist (subtract — keep the options actionable).
      const allowlistSet = new Set(t.vendorAllowlist);
      const grantOptions = vendorCatalog
        .filter((v) => !allowlistSet.has(v.slug))
        .map(
          (v) =>
            `<option value="${escapeHtml(v.slug)}">${escapeHtml(v.name)}</option>`,
        )
        .join("");
      // Add-member picker: only the customer-org members NOT already
      // on the team.
      const teamMemberUserIds = new Set(t.members.map((m) => m.userId));
      const memberPickerOptions = membersForPicker
        .filter((m) => !teamMemberUserIds.has(m.userId))
        .map(
          (m) =>
            `<option value="${escapeHtml(m.userId)}">${escapeHtml(m.name)} (${escapeHtml(m.email)})</option>`,
        )
        .join("");
      return `
      <details class="cdt-team-row" data-team-row="${teamIdAttr}">
        <summary class="cdt-team-summary">
          <span class="cdt-team-summary-name">${teamName}</span>
          <span class="cdt-team-summary-meta">${t.members.length} member${t.members.length === 1 ? "" : "s"} · ${t.vendorAllowlist.length} vendor${t.vendorAllowlist.length === 1 ? "" : "s"}</span>
        </summary>
        <div class="cdt-team-body">
          <div class="cdt-team-row-actions">
            <button
              type="button"
              class="cdt-btn-secondary"
              data-action="team-rename"
              data-team-id="${teamIdAttr}"
              data-team-name="${teamName}"
            >Rename</button>
            <button
              type="button"
              class="cdt-btn-row-remove"
              data-action="team-delete"
              data-team-id="${teamIdAttr}"
              data-team-name="${teamName}"
            >Delete team</button>
          </div>

          <h3 class="cdt-team-section-title">Members</h3>
          <ul class="cdt-team-member-list" data-team-id="${teamIdAttr}">
            ${memberRows || `<li class="cdt-empty">No members yet.</li>`}
          </ul>
          <form class="cdt-team-add-member-form" data-team-id="${teamIdAttr}">
            <label class="cdt-modal-label" for="cdtTeamAddMember-${teamIdAttr}">Add a customer-org member to this team</label>
            <div class="cdt-team-add-row">
              <select
                id="cdtTeamAddMember-${teamIdAttr}"
                class="cdt-team-add-select"
                aria-label="Pick a member to add to ${teamName}"
              >
                <option value="" disabled selected>Select a member…</option>
                ${memberPickerOptions || '<option value="" disabled>All members already on this team</option>'}
              </select>
              <button
                type="button"
                class="cdt-btn-secondary"
                data-action="team-add-member"
                data-team-id="${teamIdAttr}"
              >Add to team</button>
            </div>
          </form>

          <h3 class="cdt-team-section-title">Vendor allowlist</h3>
          <p class="cdt-section-desc">
            Per-team vendor access — only members of this team can call
            allowlisted vendors. (Org-wide access is a separate concern
            in the Tool Access tab.)
          </p>
          <div class="cdt-team-vendor-list" data-team-id="${teamIdAttr}">
            ${vendorChips || '<span class="cdt-empty">No vendors granted yet.</span>'}
          </div>
          <form class="cdt-team-grant-vendor-form" data-team-id="${teamIdAttr}">
            <label class="cdt-modal-label" for="cdtTeamGrantVendor-${teamIdAttr}">Grant a connected vendor to this team</label>
            <div class="cdt-team-add-row">
              <select
                id="cdtTeamGrantVendor-${teamIdAttr}"
                class="cdt-team-grant-select"
                aria-label="Pick a vendor to grant to ${teamName}"
              >
                <option value="" disabled selected>Select a vendor…</option>
                ${grantOptions || '<option value="" disabled>All connected vendors already granted</option>'}
              </select>
              <button
                type="button"
                class="cdt-btn-secondary"
                data-action="team-grant-vendor"
                data-team-id="${teamIdAttr}"
              >Grant</button>
            </div>
          </form>
        </div>
      </details>`;
    })
    .join("");

  return renderChrome(
    data,
    `
    <div class="cdt-teams-toolbar">
      <form class="cdt-teams-create-form" id="cdtTeamsCreateForm">
        <label class="cdt-modal-label" for="cdtTeamsCreateName">New team name</label>
        <div class="cdt-team-add-row">
          <input
            type="text"
            id="cdtTeamsCreateName"
            class="cdt-modal-input"
            placeholder="e.g. Helpdesk"
            autocomplete="off"
            maxlength="100"
          />
          <button type="submit" class="cdt-btn-primary" id="cdtTeamsCreateBtn">+ Create team</button>
        </div>
        <span class="cdt-members-status" id="cdtTeamsStatus" role="status" aria-live="polite"></span>
      </form>
    </div>

    <div class="cdt-teams-list" id="cdtTeamsList">
      ${teamRows || `<p class="cdt-empty">No teams yet. Create the first.</p>`}
    </div>`,
  );
}

/**
 * WYREAI-172 PR-2.5 Teams tab client script. Handles:
 *   1. /switch CTA (read-only state) — same pattern as Members
 *   2. Create team (POST /teams) — append to the list on success
 *   3. Rename team (PATCH /teams/:teamId) — prompts via window.prompt;
 *      updates the summary label on success
 *   4. Delete team (DELETE /teams/:teamId) — confirms via window.confirm;
 *      removes the row from the DOM on 204
 *   5. Add member to team (PUT /teams/:teamId/members/:userId) —
 *      reads the picker; appends to the member list on success
 *   6. Remove member from team (DELETE /teams/:teamId/members/:userId) —
 *      removes the member row from the DOM on 204
 *   7. Grant vendor to team (PUT /teams/:teamId/server-access/:vendor) —
 *      appends a chip to the allowlist on success
 *   8. Revoke vendor from team (DELETE /teams/:teamId/server-access/:vendor) —
 *      removes the chip on 204
 *
 * Status routing matches Members — 403 / 429 / 409 / network → distinct
 * messages. For destructive ops (delete-team + revoke-vendor + remove-
 * member) the DOM mutation is the canonical "it worked" signal; the
 * status text auto-clears after a few seconds.
 *
 * Page-reload-on-mutation is intentionally AVOIDED for Teams (unlike
 * the /switch CTA which reloads to flip the read-only→active flag).
 * Teams ops are frequent + small-blast-radius; reloading on every
 * mutation would lose any open accordion + form-input state. Direct
 * DOM-mutation keeps the UX responsive.
 */
function teamsScript(
  customerId: string,
  actingAsActive: boolean,
): string {
  return `
<script>
  (function () {
    var CUSTOMER_ID = ${jsonForScriptEmbed(customerId)};
    var ACTING_AS = ${actingAsActive ? "true" : "false"};

    function setStatus(el, text, isError) {
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('cdt-members-status-error', !!isError);
    }
    function autoClear(el, ms) {
      setTimeout(function () { setStatus(el, '', false); }, ms || 3000);
    }
    function routeErrorMessage(res, data) {
      if (res.status === 403) return "You don't have permission for this action.";
      if (res.status === 429) return 'Rate limit hit. Try again in a few minutes.';
      if (data && data.error) return data.error;
      return 'Action failed (HTTP ' + res.status + ').';
    }

    // --- /switch CTA (read-only state) ---
    var switchForm = document.getElementById('cdtTeamsSwitchForm');
    var switchBtn = document.getElementById('cdtTeamsSwitchBtn');
    var switchStatus = document.getElementById('cdtTeamsSwitchStatus');
    if (switchForm && switchBtn) {
      switchForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        switchBtn.disabled = true;
        setStatus(switchStatus, 'Starting session…', false);
        fetch('/api/reseller/me/customers/' + encodeURIComponent(CUSTOMER_ID) + '/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.status === 200) {
            window.location.reload();
            return;
          }
          switchBtn.disabled = false;
          if (res.status === 403) {
            setStatus(switchStatus, "You don't have permission to act on behalf of this customer.", true);
            return;
          }
          if (res.status === 429) {
            setStatus(switchStatus, 'Rate limit hit. Try again in a few minutes.', true);
            return;
          }
          setStatus(switchStatus, 'Could not start customer session (HTTP ' + res.status + ').', true);
        }).catch(function () {
          switchBtn.disabled = false;
          setStatus(switchStatus, 'Network error. Check connection and retry.', true);
        });
      });
    }

    if (!ACTING_AS) return;

    var statusEl = document.getElementById('cdtTeamsStatus');
    var createForm = document.getElementById('cdtTeamsCreateForm');
    var createInput = document.getElementById('cdtTeamsCreateName');
    var createBtn = document.getElementById('cdtTeamsCreateBtn');
    var teamsList = document.getElementById('cdtTeamsList');

    // --- Create team ---
    if (createForm && createInput && createBtn) {
      createForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var name = (createInput.value || '').trim();
        if (!name) {
          setStatus(statusEl, 'Team name is required.', true);
          return;
        }
        createBtn.disabled = true;
        setStatus(statusEl, 'Creating team…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name: name }),
        }).then(function (res) {
          createBtn.disabled = false;
          if (res.status === 200 || res.status === 201) {
            setStatus(statusEl, 'Team "' + name + '" created. Reload to manage.', false);
            createInput.value = '';
            // Page-reload only on CREATE — the new team needs the
            // server-rendered accordion shape (vendor catalog +
            // member picker option lists are server-rendered per
            // team), and re-deriving that client-side would duplicate
            // template logic. Cheap trade vs the per-mutation reload-
            // avoidance: create-team is infrequent compared to the
            // other ops.
            setTimeout(function () { window.location.reload(); }, 800);
            return;
          }
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Create team failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          createBtn.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
      });
    }

    if (!teamsList) return;

    // --- Delegated handler for the per-team controls ---
    teamsList.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.action) return;
      var action = t.dataset.action;
      var teamId = t.dataset.teamId;

      if (action === 'team-rename') {
        var prev = t.dataset.teamName || '';
        var next = window.prompt('Rename team', prev);
        if (next == null) return;
        var newName = next.trim();
        if (!newName || newName === prev) return;
        t.disabled = true;
        setStatus(statusEl, 'Renaming…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name: newName }),
        }).then(function (res) {
          t.disabled = false;
          if (res.ok) {
            var row = teamsList.querySelector('details[data-team-row="' + CSS.escape(teamId) + '"]');
            if (row) {
              var label = row.querySelector('.cdt-team-summary-name');
              if (label) label.textContent = newName;
              t.dataset.teamName = newName;
              var delBtn = row.querySelector('button[data-action="team-delete"]');
              if (delBtn) delBtn.dataset.teamName = newName;
            }
            setStatus(statusEl, 'Team renamed.', false);
            autoClear(statusEl);
            return;
          }
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Rename failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }

      if (action === 'team-delete') {
        var teamName = t.dataset.teamName || 'this team';
        if (!window.confirm('Delete team "' + teamName + '"? This removes team membership + per-team vendor allowlists; members keep their org-wide access.')) return;
        t.disabled = true;
        setStatus(statusEl, 'Deleting team…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId), {
          method: 'DELETE',
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.ok || res.status === 204) {
            var row = teamsList.querySelector('details[data-team-row="' + CSS.escape(teamId) + '"]');
            if (row && row.parentNode) row.parentNode.removeChild(row);
            setStatus(statusEl, 'Team deleted.', false);
            autoClear(statusEl);
            return;
          }
          t.disabled = false;
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Delete failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }

      if (action === 'team-add-member') {
        var select = document.getElementById('cdtTeamAddMember-' + teamId);
        if (!select) return;
        var userId = select.value;
        if (!userId) {
          setStatus(statusEl, 'Pick a member first.', true);
          return;
        }
        t.disabled = true;
        setStatus(statusEl, 'Adding member to team…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId) + '/members/' + encodeURIComponent(userId), {
          method: 'PUT',
          credentials: 'same-origin',
        }).then(function (res) {
          t.disabled = false;
          if (res.ok) {
            setStatus(statusEl, 'Member added. Reload to refresh the picker list.', false);
            autoClear(statusEl, 4000);
            // Picker option lists are server-rendered per team; the
            // simplest correct UX is a quiet reload on add. (Avoiding
            // here would duplicate the team-member-picker dedup logic
            // client-side.)
            setTimeout(function () { window.location.reload(); }, 800);
            return;
          }
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Add member failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }

      if (action === 'team-remove-member') {
        var userIdRm = t.dataset.userId;
        var userNameRm = t.dataset.userName || 'this member';
        if (!window.confirm('Remove ' + userNameRm + ' from the team? Their org-wide membership is unaffected.')) return;
        t.disabled = true;
        setStatus(statusEl, 'Removing…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId) + '/members/' + encodeURIComponent(userIdRm), {
          method: 'DELETE',
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.ok || res.status === 204) {
            var li = teamsList.querySelector('li.cdt-team-member-row[data-team-member="' + CSS.escape(userIdRm) + '"]');
            if (li && li.parentNode) li.parentNode.removeChild(li);
            setStatus(statusEl, 'Member removed from team.', false);
            autoClear(statusEl);
            return;
          }
          t.disabled = false;
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Remove failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }

      if (action === 'team-grant-vendor') {
        var grantSelect = document.getElementById('cdtTeamGrantVendor-' + teamId);
        if (!grantSelect) return;
        var slug = grantSelect.value;
        if (!slug) {
          setStatus(statusEl, 'Pick a vendor first.', true);
          return;
        }
        t.disabled = true;
        setStatus(statusEl, 'Granting…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId) + '/server-access/' + encodeURIComponent(slug), {
          method: 'PUT',
          credentials: 'same-origin',
        }).then(function (res) {
          t.disabled = false;
          if (res.ok) {
            setStatus(statusEl, 'Vendor granted. Reload to refresh the picker list.', false);
            autoClear(statusEl, 4000);
            setTimeout(function () { window.location.reload(); }, 800);
            return;
          }
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Grant failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }

      if (action === 'team-revoke-vendor') {
        var revokeSlug = t.dataset.vendorSlug;
        t.disabled = true;
        setStatus(statusEl, 'Revoking…', false);
        fetch('/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams/' + encodeURIComponent(teamId) + '/server-access/' + encodeURIComponent(revokeSlug), {
          method: 'DELETE',
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.ok || res.status === 204) {
            var chip = teamsList.querySelector('span.cdt-team-vendor-chip[data-team-vendor="' + CSS.escape(revokeSlug) + '"]');
            if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
            setStatus(statusEl, 'Vendor revoked.', false);
            autoClear(statusEl);
            return;
          }
          t.disabled = false;
          return res.json().then(function (data) {
            setStatus(statusEl, routeErrorMessage(res, data), true);
          }).catch(function () {
            setStatus(statusEl, 'Revoke failed (HTTP ' + res.status + ').', true);
          });
        }).catch(function () {
          t.disabled = false;
          setStatus(statusEl, 'Network error. Check connection and retry.', true);
        });
        return;
      }
    });
  })();
</script>`;
}

// ---- tab: Usage (LIVE) ---------------------------------------------------

function renderUsage(data: CustomerTabData): string {
  return renderChrome(
    data,
    `
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
    </div>`,
  );
}

/** Live loader for the Usage tab — reseller-scoped, endpoint owns authz. */
function usageScript(resellerId: string, customerId: string): string {
  const base = `/admin/reseller/${encodeURIComponent(resellerId)}/customers/${encodeURIComponent(customerId)}/dashboard`;
  return `
<script>
  (function () {
    var BASE = ${jsonForScriptEmbed(base)};
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
  const groups = data.toolGroups
    .map((g) => {
      const on = g.tools.filter((t) => t.enabled).length;
      const rows = g.tools
        .map(
          (t) => `
      <div class="cdt-tool-row">
        <span class="cdt-box ${t.enabled ? "cdt-box-on" : ""}" aria-hidden="true">${t.enabled ? "&#10003;" : ""}</span>
        <span class="${t.enabled ? "" : "cdt-tool-off"}">${escapeHtml(t.name)}<span class="cdt-sr"> — ${t.enabled ? "enabled" : "disabled"}</span></span>
      </div>`,
        )
        .join("");
      return `
      <div class="cdt-tool-group">
        <div class="cdt-tool-head"><span class="cdt-strong">${escapeHtml(g.name)}</span>
          <span class="cdt-sub">${on} of ${g.tools.length} enabled</span></div>
        ${rows}
      </div>`;
    })
    .join("");
  return renderChrome(
    data,
    `
    <div class="cdt-toolbar">
      <span class="cdt-label">Department:</span>
      <span class="cdt-select">${escapeHtml(data.toolDepartment)} &#9662;</span>
    </div>
    ${groups}
    ${seam("Mock-data-first. SWAP-IN CONTRACT: tool-access reads/writes MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).")}`,
  );
}

// ---- tab: Audit Log (LIVE) -----------------------------------------------

function renderAudit(data: CustomerTabData): string {
  return renderChrome(
    data,
    `
    <p id="cdtAuditLoading" class="cdt-loading" role="status" aria-live="polite">Loading audit log…</p>
    <table class="cdt-table" id="cdtAuditTable" style="display:none">
      <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th></tr></thead>
      <tbody id="cdtAuditRows"></tbody>
    </table>`,
  );
}

/** Live loader for the Audit Log tab — reseller-scoped, endpoint owns authz. */
function auditScript(resellerId: string, customerId: string): string {
  const url = `/admin/reseller/${encodeURIComponent(resellerId)}/customers/${encodeURIComponent(customerId)}/audit`;
  return `
<script>
  (function () {
    var URL = ${jsonForScriptEmbed(url)};
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
  return renderChrome(
    data,
    `
    <div class="cdt-empty-card">
      <h2 class="cdt-section-title">Customer billing</h2>
      <p class="cdt-empty-body">No billing data yet for this customer.</p>
    </div>
    ${seam("Mock-data-first. SWAP-IN CONTRACT: requires a reseller-scoped customer-billing READ ROUTE (not yet built) that verifies the calling reseller owns :id and internally calls seatService.getSeatBilling(customerId) under the verified access context. Until that route lands, this tab renders an honest empty state — never fabricated financial data on a customer-billing surface (F3 discipline applied to the reseller-viewing-customer direction).")}`,
  );
}

// ---- tab: Settings -------------------------------------------------------

function renderSettings(data: CustomerTabData): string {
  const c = data.customer;
  return renderChrome(
    data,
    `
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
    </div>
    <div class="cdt-danger">
      <div class="cdt-strong">Danger zone</div>
      <p class="cdt-sub">Suspending or removing a customer org is irreversible from here.</p>
      <button type="button" class="cdt-danger-btn" disabled>Suspend customer</button>
    </div>
    <div class="cdt-actions">
      <button type="button" class="cdt-save" disabled>Save changes</button>
    </div>
    ${seam("Mock-data-first. SWAP-IN CONTRACT: settings reads/writes MUST be reseller-scoped + :id-ownership-checked (warden Finding 2).")}`,
  );
}

// ---- entrypoint ----------------------------------------------------------

export function renderCustomerTab(data: CustomerTabData): {
  body: string;
  pageScripts: string;
} {
  // Explicit per-tab dispatch — an unrecognized tab renders a neutral
  // "unknown tab" body rather than silently falling through to the
  // editable-looking Settings form.
  const body =
    data.tab === "mcps"
      ? renderMcps(data)
      : data.tab === "users"
        ? renderUsers(data)
        : data.tab === "members"
          ? renderMembers(data)
          : data.tab === "teams"
            ? renderTeams(data)
            : data.tab === "usage"
              ? renderUsage(data)
              : data.tab === "tools"
                ? renderTools(data)
                : data.tab === "audit"
                  ? renderAudit(data)
                  : data.tab === "billing"
                    ? renderBilling(data)
                    : data.tab === "settings"
                      ? renderSettings(data)
                      : renderChrome(data, '<p class="cdt-empty">Unknown tab.</p>');

  const pageScripts =
    data.tab === "usage"
      ? usageScript(data.org.id, data.customer.id)
      : data.tab === "audit"
        ? auditScript(data.org.id, data.customer.id)
        : data.tab === "members"
          ? membersScript(data.customer.id, !!data.actingAsActive)
          : data.tab === "teams"
            ? teamsScript(data.customer.id, !!data.actingAsActive)
            : "";

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

  /* Users tab toolbar + invite modal — 2026-06-12 Aaron-flagged surface */
  .cdt-toolbar { display: flex; justify-content: flex-end; margin-bottom: 4px; }
  .cdt-btn-invite {
    padding: 8px 14px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: 0;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .cdt-btn-invite:hover { background: var(--accent-hover); }
  .cdt-modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: none; align-items: center; justify-content: center;
    z-index: 100;
  }
  .cdt-modal {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    width: min(480px, 92vw);
    padding: 24px;
    color: var(--text-secondary);
  }
  .cdt-modal-title { font-size: 17px; margin: 0 0 6px; color: var(--text-primary); }
  .cdt-modal-desc { font-size: 12px; color: var(--text-tertiary); margin: 0 0 16px; line-height: 1.5; }
  .cdt-modal-label { display: block; font-size: 12px; color: var(--text-tertiary); margin-bottom: 6px; }
  .cdt-modal-input {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-input, var(--bg-card));
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    box-sizing: border-box;
  }
  .cdt-modal-input:focus { outline: none; border-color: var(--accent); }
  .cdt-modal-result {
    margin-top: 16px;
    padding: 12px;
    background: rgba(34, 197, 94, 0.06);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: 6px;
  }
  .cdt-modal-result-label { font-size: 11px; color: var(--text-tertiary); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  .cdt-modal-result-url {
    display: block;
    word-break: break-all;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--bg-card);
    padding: 8px 10px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .cdt-modal-result-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 8px; }
  .cdt-modal-error {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 6px;
    color: var(--error-text);
    font-size: 13px;
  }
  .cdt-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .cdt-btn-primary {
    padding: 8px 14px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: 0;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .cdt-btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .cdt-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
  .cdt-btn-secondary {
    padding: 8px 14px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }
  .cdt-btn-secondary:hover { color: var(--text-primary); border-color: var(--border-hover); }
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
  .cdt-dot-reachable { background: #0ea5e9; }
  .cdt-dot-degraded { background: var(--warning-text); }
  .cdt-dot-down { background: var(--error); }
  .cdt-dot-unknown { background: #9ca3af; }

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
    align-items: center; justify-content: center; font-size: 10px; color: var(--text-on-accent);
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
    padding: 9px 18px; background: var(--accent); color: var(--text-on-accent);
    font-size: 13px; font-weight: 600; font-family: inherit; border: none;
    border-radius: 6px; cursor: pointer;
  }
  .cdt-save:disabled { background: var(--border-secondary); color: var(--text-muted); cursor: not-allowed; }

  /* WYREAI-172 PR-2 Members tab styles */
  .cdt-acting-as-cta {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 24px;
  }
  .cdt-acting-as-cta-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 6px;
  }
  .cdt-acting-as-cta-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0 0 12px;
    line-height: 1.5;
  }
  .cdt-acting-as-cta-form {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
  }
  .cdt-acting-as-cta-status {
    font-size: 12px;
    color: var(--text-tertiary);
    min-height: 1em;
  }
  .cdt-acting-as-cta-status.cdt-members-status-error {
    color: var(--error-text);
  }
  .cdt-section-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .cdt-section-desc {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0 0 12px;
  }
  .cdt-table-readonly {
    /* Visual de-emphasis for the read-only roster shown without an
       active acting-as binding. The table chrome stays the same; the
       muted-row tone signals "view, not edit". */
    opacity: 0.85;
  }
  .cdt-members-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .cdt-members-status {
    font-size: 12px;
    color: var(--text-tertiary);
    min-height: 1em;
  }
  .cdt-members-status-error {
    color: var(--error-text);
  }
  .cdt-role-select {
    padding: 6px 8px;
    background: var(--bg-input, var(--bg-page));
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
  }
  .cdt-role-select:focus { outline: none; border-color: var(--accent); }
  .cdt-role-select:disabled { opacity: 0.6; cursor: progress; }
  .cdt-role-locked {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
  .cdt-btn-row-remove {
    padding: 5px 12px;
    background: transparent;
    color: var(--error-text);
    border: 1px solid var(--error-text);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .cdt-btn-row-remove:hover {
    background: var(--bg-card-hover, var(--bg-card));
  }
  .cdt-btn-row-remove:disabled {
    color: var(--text-muted);
    border-color: var(--border-primary);
    cursor: not-allowed;
  }
  .cdt-row-actions { text-align: right; }
  .cdt-row-actions-locked {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* WYREAI-172 PR-2.5 Teams tab styles */
  .cdt-teams-toolbar {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 18px;
  }
  .cdt-teams-create-form { margin: 0; }
  .cdt-team-add-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
  }
  .cdt-teams-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cdt-team-row {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 14px 18px;
  }
  .cdt-team-summary {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    cursor: pointer;
    font-weight: 600;
    color: var(--text-primary);
    list-style: none;
  }
  .cdt-team-summary::-webkit-details-marker { display: none; }
  .cdt-team-summary::before {
    content: '▸';
    margin-right: 8px;
    color: var(--text-tertiary);
    font-size: 11px;
    transition: transform 0.15s;
    display: inline-block;
  }
  .cdt-team-row[open] .cdt-team-summary::before {
    transform: rotate(90deg);
  }
  .cdt-team-summary-name {
    flex: 1;
    font-size: 14px;
  }
  .cdt-team-summary-meta {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-tertiary);
  }
  .cdt-team-body {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }
  .cdt-team-row-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  .cdt-team-section-title {
    margin: 12px 0 4px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }
  .cdt-team-member-list {
    list-style: none;
    padding: 0;
    margin: 0 0 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cdt-team-member-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--bg-page);
    border-radius: 4px;
    font-size: 13px;
  }
  .cdt-team-member-name { font-weight: 500; color: var(--text-primary); }
  .cdt-team-member-email {
    flex: 1;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .cdt-btn-team-member-remove { padding: 3px 10px; font-size: 11px; }

  .cdt-team-add-select,
  .cdt-team-grant-select {
    flex: 1;
    padding: 7px 10px;
    background: var(--bg-input, var(--bg-page));
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
  }
  .cdt-team-add-select:focus,
  .cdt-team-grant-select:focus { outline: none; border-color: var(--accent); }

  .cdt-team-vendor-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    min-height: 1.5em;
  }
  .cdt-team-vendor-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 10px;
    background: rgba(0, 201, 219, 0.12);
    border: 1px solid rgba(0, 201, 219, 0.3);
    border-radius: 12px;
    font-size: 12px;
    color: var(--text-primary);
  }
  .cdt-team-vendor-chip .cdt-team-vendor-name { font-weight: 500; }
  .cdt-team-vendor-revoke {
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 0 4px;
    font-size: 14px;
    line-height: 1;
    border-radius: 50%;
  }
  .cdt-team-vendor-revoke:hover {
    color: var(--error-text);
    background: rgba(255, 255, 255, 0.05);
  }
`;
