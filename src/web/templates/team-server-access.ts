import type { Organization, OrgRole } from '../../org/org-service.js';
import { VENDORS } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';

export interface TeamServerAccessData {
  orgId: string;
  org: Organization;
  viewerRole: OrgRole;
  members: {
    userId: string;
    role: OrgRole;
    name: string | null;
    email: string | null;
  }[];
  orgVendors: string[];
  serverAccess: { userId: string; vendorSlug: string }[];
  teamGrants?: { userId: string; vendorSlug: string }[];
}

export function renderTeamServerAccess(data: TeamServerAccessData): string {
  const { orgId, org, viewerRole, members, orgVendors, serverAccess, teamGrants } = data;
  const accessSet = new Set(serverAccess.map((a) => `${a.userId}:${a.vendorSlug}`));
  const teamAccessSet = new Set((teamGrants ?? []).map((a) => `${a.userId}:${a.vendorSlug}`));
  const nonOwnerMembers = members.filter((m) => m.role !== 'owner');

  if (orgVendors.length === 0) {
    return `
      <h1 style="margin-bottom:4px">Server Access</h1>
      <p class="section-desc">Control which team members can use each vendor server. Owners always have full access.</p>
      <p style="color:var(--text-muted);font-size:13px">Connect a vendor in Team Connections first.</p>`;
  }

  if (nonOwnerMembers.length === 0) {
    return `
      <h1 style="margin-bottom:4px">Server Access</h1>
      <p class="section-desc">Control which team members can use each vendor server. Owners always have full access.</p>
      <p style="color:var(--text-muted);font-size:13px">No non-owner members to manage access for.</p>`;
  }

  const vendorHeaders = orgVendors.map((slug) => {
    const vendor = VENDORS[slug];
    return `<th style="text-align:center;min-width:80px">${vendor ? escapeHtml(vendor.name) : escapeHtml(slug)}</th>`;
  }).join('');

  const isAdmin = viewerRole === 'owner' || viewerRole === 'admin';

  const memberRows = nonOwnerMembers.map((m) => {
    const displayName = m.name || m.email || m.userId;
    const vendorCells = orgVendors.map((slug) => {
      const hasPersonalAccess = accessSet.has(`${m.userId}:${slug}`);
      const hasTeamAccess = teamAccessSet.has(`${m.userId}:${slug}`);
      if (!isAdmin) {
        if (hasPersonalAccess) {
          return `<td style="text-align:center"><span style="color:var(--success-text)">&#10003;</span></td>`;
        }
        if (hasTeamAccess) {
          return `<td style="text-align:center"><span class="team-badge" title="Inherited from team">T</span></td>`;
        }
        return `<td style="text-align:center"><span style="color:var(--text-muted)">—</span></td>`;
      }
      const teamIndicator = hasTeamAccess && !hasPersonalAccess
        ? '<span class="team-badge" title="Inherited from team">T</span>'
        : '';
      return `<td style="text-align:center">
        <input type="checkbox" ${hasPersonalAccess ? 'checked' : ''} onchange="toggleServerAccess('${escapeHtml(m.userId)}', '${escapeHtml(slug)}', this.checked)" style="cursor:pointer;accent-color:var(--accent)" />
        ${teamIndicator}
      </td>`;
    }).join('');

    return `<tr><td><span class="member-name">${escapeHtml(displayName)}</span></td>${vendorCells}</tr>`;
  }).join('');

  const defaultAccessInfo = org.defaultServerAccess === 'all'
    ? '<span style="color:var(--success-text);font-size:12px">New members get access to all servers by default</span>'
    : '<span style="color:var(--text-tertiary);font-size:12px">New members get no server access by default</span>';

  const defaultToggle = viewerRole === 'owner'
    ? `<select class="role-select" onchange="updateOrgSettings(this.value)" style="margin-left:8px">
        <option value="none"${org.defaultServerAccess === 'none' ? ' selected' : ''}>None</option>
        <option value="all"${org.defaultServerAccess === 'all' ? ' selected' : ''}>All servers</option>
      </select>`
    : '';

  return `
    <h1 style="margin-bottom:4px">Server Access</h1>
    <p class="section-desc">Control which team members can use each vendor server. Owners always have full access.</p>
    <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <span style="font-size:13px;color:var(--text-secondary)">Default access for new members:</span>
      ${defaultToggle}
      ${defaultAccessInfo}
    </div>
    <div class="org-section" style="padding:0;overflow:auto">
      <table>
        <thead><tr><th>Member</th>${vendorHeaders}</tr></thead>
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

      async function toggleServerAccess(userId, vendor, granted) {
        const url = '/api/orgs/' + orgId + '/members/' + userId + '/server-access/' + vendor;
        const method = granted ? 'PUT' : 'DELETE';
        const res = await fetch(url, { method });
        if (!res.ok) {
          const data = await res.json().catch(function() { return {}; });
          alert('Failed to update server access: ' + (data.error || 'Unknown error'));
          window.location.reload();
        } else {
          showToast(granted ? 'Access granted' : 'Access revoked');
        }
      }

      async function updateOrgSettings(defaultServerAccess) {
        const res = await fetch('/api/orgs/' + orgId + '/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultServerAccess: defaultServerAccess }),
        });
        if (res.ok) {
          showToast('Settings updated');
        } else {
          const data = await res.json().catch(function() { return {}; });
          alert('Failed to update settings: ' + (data.error || 'Unknown error'));
          window.location.reload();
        }
      }
    </script>`;
}

export const TEAM_SERVER_ACCESS_STYLES = `
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 10px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--border-subtle);
  }
  th { color: var(--text-tertiary); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { color: var(--text-label); }
  .member-name { display: block; font-weight: 500; }
  .role-select {
    background: var(--bg-card); border: 1px solid var(--border-primary); color: var(--text-primary);
    border-radius: 4px; padding: 2px 6px; font-size: 12px;
    font-family: inherit; cursor: pointer;
  }
  .team-badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; font-size: 10px; font-weight: 700;
    background: rgba(37,99,235,0.15); color: var(--accent-text);
    border-radius: 3px; cursor: help; vertical-align: middle;
  }
`;
