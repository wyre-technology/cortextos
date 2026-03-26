import type { Organization } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

export interface TeamOverviewData {
  org: Organization;
  memberCount: number;
}

export function renderTeamOverview(data: TeamOverviewData): string {
  const { org, memberCount } = data;
  const orgName = escapeHtml(org.name);

  return `
    <h1 style="margin-bottom:4px">${orgName}</h1>
    <p class="section-desc">
      <span class="plan-badge pro" style="margin-right:8px">Pro</span>
      ${memberCount} member${memberCount !== 1 ? 's' : ''}
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
