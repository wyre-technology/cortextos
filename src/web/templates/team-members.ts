import type { OrgRole } from '../../org/org-service.js';
import { PER_SEAT_PRICE_CENTS } from '../../billing/prices.js';
import { escapeHtml } from '../helpers.js';
import { formatUsd } from './seat-billing-copy.js';

export interface TeamMembersData {
  orgId: string;
  viewerUserId: string;
  viewerRole: OrgRole;
  members: {
    userId: string;
    role: OrgRole;
    joinedAt: string | null;
    email: string | null;
    name: string | null;
  }[];
}

export function renderTeamMembers(data: TeamMembersData): string {
  const { orgId, viewerUserId, viewerRole, members } = data;
  const isViewerOwner = viewerRole === 'owner';
  // Price comes from the named SoT constant (seat-service.ts), not a
  // per-org view object — single-source price independent of any snapshot.
  const perSeat = formatUsd(PER_SEAT_PRICE_CENTS);

  const memberRows = members
    .map((m) => {
      const isOwner = m.role === 'owner';
      const isSelf = m.userId === viewerUserId;
      const canRemove = !isOwner && !isSelf && (isViewerOwner || m.role === 'member');
      const removeBtn = canRemove
        ? `<button class="btn-disconnect" onclick="removeMember('${escapeHtml(m.userId)}')">Remove</button>`
        : '';
      const displayName = m.name || m.email || m.userId;
      const emailLine = m.email && m.name ? `<span class="member-email">${escapeHtml(m.email)}</span>` : '';

      let roleCell: string;
      if (isViewerOwner && !isOwner && !isSelf) {
        roleCell = `<select class="role-select" onchange="changeRole('${escapeHtml(m.userId)}', this.value)">
          <option value="member"${m.role === 'member' ? ' selected' : ''}>member</option>
          <option value="admin"${m.role === 'admin' ? ' selected' : ''}>admin</option>
        </select>`;
      } else {
        roleCell = `<span class="role-badge ${m.role}">${m.role}</span>`;
      }

      return `
      <tr>
        <td><span class="member-name">${escapeHtml(displayName)}</span>${emailLine}</td>
        <td>${roleCell}</td>
        <td>${m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}</td>
        <td>${removeBtn}</td>
      </tr>`;
    })
    .join('');

  return `
    <h1 style="margin-bottom:4px">Members</h1>
    <p class="section-desc">Manage who has access to your team's shared vendor connections.
      Each member is a ${escapeHtml(perSeat)}/mo seat — adding or removing one
      prorates your next bill.</p>

    <div class="org-section" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Joined</th><th></th></tr></thead>
        <tbody>${memberRows}</tbody>
      </table>
    </div>

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      async function removeMember(userId) {
        if (!confirm('Remove this member from the team?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/members/' + userId, { method: 'DELETE' });
        if (res.ok) window.location.reload();
        else alert('Failed to remove member');
      }

      async function changeRole(userId, newRole) {
        const res = await fetch('/api/orgs/' + orgId + '/members/' + userId + '/role', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        if (res.ok) {
          showToast('Role updated');
        } else {
          const data = await res.json().catch(function() { return {}; });
          alert('Failed to change role: ' + (data.error || 'Unknown error'));
          window.location.reload();
        }
      }
    </script>`;
}

export const TEAM_MEMBERS_STYLES = `
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 10px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--border-subtle);
  }
  th { color: var(--text-tertiary); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { color: var(--text-label); }
  .role-badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .role-badge.owner { background: rgba(37, 99, 235, 0.15); color: var(--accent-text); }
  /* Admin role-badge is purple per design — no canonical role-admin token
     in THEME_VARS yet; defining the role-color palette is a separate task
     (covered alongside PR-3 native-dialog work as a UX component-tokens
     refactor surface). Hardcoded literal is the obvious-over-compelling
     choice until that token lands. */
  .role-badge.admin { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
  .role-badge.member { background: var(--border-tertiary); color: var(--text-secondary); }
  .role-select {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .member-name { display: block; font-weight: 500; }
  .member-email { display: block; font-size: 12px; color: var(--text-tertiary); }
`;
