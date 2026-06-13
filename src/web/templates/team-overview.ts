import type { Organization } from "../../org/org-service.js";
import { escapeHtml } from "../helpers.js";

export interface TeamOverviewData {
  org: Organization;
  memberCount: number;
  /**
   * Reseller-side enrichment (2026-06-13 sweep-2 cluster-1 (4)): count of
   * customer orgs nested under this reseller. Only meaningful for reseller-
   * type orgs; routes pass it for `org.type === 'reseller'` and omit it
   * for customer/standalone orgs. When present, the subtitle surfaces
   * "X customers" alongside the member count so the reseller has at-a-
   * glance context about the size of their managed fleet.
   */
  customerCount?: number;
}

export function renderTeamOverview(data: TeamOverviewData): string {
  const { org, memberCount, customerCount } = data;
  const orgName = escapeHtml(org.name);

  // 2026-06-13 reseller-side OC1-class fix (boss). The "Pro" plan-badge is
  // a holdover from the legacy BUSINESS/PRO/FREE tier system that flat-
  // pricing made misleading (one plan = "conduit", no tier-choice to
  // convey). Same fix shape as PR #362 RC4 on customer-LIST + customer-
  // DETAIL + customer-Settings tab. Subtitle now just shows member count
  // (plus customer count when reseller-side).
  const customerLine =
    typeof customerCount === "number"
      ? ` &middot; ${customerCount} customer${customerCount !== 1 ? "s" : ""}`
      : "";
  return `
    <h1 style="margin-bottom:4px">${orgName}</h1>
    <p class="section-desc">
      ${memberCount} member${memberCount !== 1 ? "s" : ""}${customerLine}
    </p>

    <div class="org-section" style="margin-top:24px">
      <h2 class="section-title">Team Name</h2>
      <p class="section-desc">Update your team's display name.</p>
      <form id="rename-form" style="display:flex;gap:8px;max-width:400px">
        <input type="text" id="orgNameInput" value="${orgName}" required
          style="flex:1;padding:8px 12px;border:1px solid var(--border-primary);border-radius:6px;background:var(--bg-card);color:var(--text-primary);font-size:14px;font-family:inherit" />
        <button type="submit" class="btn-connect" style="width:auto;padding:8px 16px">Save</button>
      </form>
    </div>

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(org.id)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      document.getElementById('rename-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const name = document.getElementById('orgNameInput').value.trim();
        if (!name) return;
        const res = await fetch('/api/orgs/' + orgId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          showToast('Team name updated');
          setTimeout(() => window.location.reload(), 500);
        } else {
          const data = await res.json().catch(() => ({}));
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      });
    </script>`;
}

export const TEAM_OVERVIEW_STYLES = ``;
