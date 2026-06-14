import type { OrgRole } from "../../org/org-service.js";
import { PER_SEAT_PRICE_CENTS } from "../../billing/prices.js";
import { escapeHtml } from "../helpers.js";
import { formatUsd } from "./seat-billing-copy.js";

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
  const isViewerOwner = viewerRole === "owner";
  // Price comes from the named SoT constant (seat-service.ts), not a
  // per-org view object — single-source price independent of any snapshot.
  const perSeat = formatUsd(PER_SEAT_PRICE_CENTS);

  const memberRows = members
    .map((m) => {
      const isOwner = m.role === "owner";
      const isSelf = m.userId === viewerUserId;
      const canRemove =
        !isOwner && !isSelf && (isViewerOwner || m.role === "member");
      const displayName = m.name || m.email || m.userId;
      // MR3 (ruby 2026-06-05): pass displayName via data-attr so the toast
      // can name the removed/role-changed member (scribe Voice-1 INFOR-
      // MATIONAL spec: '{{member_name | default: A teammate}} removed
      // from {{org_name | default: your organization}}.').
      const removeBtn = canRemove
        ? `<button class="btn-disconnect"
            data-user-id="${escapeHtml(m.userId)}"
            data-member-name="${escapeHtml(displayName)}"
            onclick="removeMember(this.dataset.userId, this.dataset.memberName)">Remove</button>`
        : "";
      const emailLine =
        m.email && m.name
          ? `<span class="member-email">${escapeHtml(m.email)}</span>`
          : "";

      let roleCell: string;
      if (isViewerOwner && !isOwner && !isSelf) {
        // MR3: data-attr passes member name so toast names the affected
        // user. Sibling-shape to removeBtn above.
        roleCell = `<select class="role-select"
            data-user-id="${escapeHtml(m.userId)}"
            data-member-name="${escapeHtml(displayName)}"
            onchange="changeRole(this.dataset.userId, this.value, this.dataset.memberName)">
          <option value="member"${m.role === "member" ? " selected" : ""}>member</option>
          <option value="admin"${m.role === "admin" ? " selected" : ""}>admin</option>
        </select>`;
      } else {
        roleCell = `<span class="role-badge ${m.role}">${m.role}</span>`;
      }

      return `
      <tr>
        <td><span class="member-name">${escapeHtml(displayName)}</span>${emailLine}</td>
        <td>${roleCell}</td>
        <td>${m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}</td>
        <td>${removeBtn}</td>
      </tr>`;
    })
    .join("");

  // 2026-06-13 sweep-2 cluster-2 (a) (boss): inline Invite CTA. The
  // Members page previously had no direct path to inviting a new member —
  // the invitation create-flow lives at /org/invitations (separate nav
  // item), so a user wanting to add someone had to discover the nav route.
  // Show the CTA to owner + admin; member-role users cannot create
  // invitations (server-side gate is the source of truth, this is just
  // the discoverability layer).
  const canInvite = isViewerOwner || viewerRole === "admin";
  const inviteCta = canInvite
    ? `<a href="/org/invitations" class="btn-connect" style="width:auto;padding:8px 16px;text-decoration:none;display:inline-block">Invite a member</a>`
    : "";

  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px">
      <h1 style="margin:0">Members</h1>
      ${inviteCta}
    </div>
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

      async function removeMember(userId, memberName) {
        if (!confirm('Remove this member from the team?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/members/' + userId, { method: 'DELETE' });
        if (res.ok) {
          // MR3: in-app toast acknowledgment for admin's own action.
          // 500ms delay before reload so toast renders visibly.
          showToast((memberName || 'A teammate') + ' removed from the team.');
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          alert('Failed to remove member');
        }
      }

      async function changeRole(userId, newRole, memberName) {
        const res = await fetch('/api/orgs/' + orgId + '/members/' + userId + '/role', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        if (res.ok) {
          // MR3: enriched toast names the affected member + the new role
          // (scribe Voice-1 spec). Existing 'Role updated' bare-toast
          // didn't name the member.
          showToast((memberName || 'A teammate') + ' role changed to ' + newRole + '.');
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
