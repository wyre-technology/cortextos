import type { OrgTeamWithMembers } from '../../org/org-service.js';
import { VENDORS } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';

export interface TeamTeamsData {
  orgId: string;
  teams: OrgTeamWithMembers[];
  orgMembers: { userId: string; name: string | null; email: string | null }[];
  orgVendors: string[];
}

function renderTeamCard(team: OrgTeamWithMembers, orgMembers: TeamTeamsData['orgMembers'], orgVendors: string[]): string {
  const memberSet = new Set(team.members.map((m) => m.userId));
  const accessSet = new Set(team.serverAccess);

  const memberOptions = orgMembers
    .filter((m) => !memberSet.has(m.userId))
    .map((m) => `<option value="${escapeHtml(m.userId)}">${escapeHtml(m.name || m.email || m.userId)}</option>`)
    .join('');

  const memberList = team.members.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px;margin:4px 0">No members yet</p>'
    : team.members.map((m) => `
        <div class="team-member-row">
          <span>${escapeHtml(m.name || m.email || m.userId)}</span>
          <button class="btn-sm btn-danger" onclick="removeTeamMember('${escapeHtml(team.id)}', '${escapeHtml(m.userId)}')">Remove</button>
        </div>`).join('');

  const vendorCheckboxes = orgVendors.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px;margin:4px 0">No vendors connected</p>'
    : orgVendors.map((slug) => {
        const vendor = VENDORS[slug];
        const label = vendor ? vendor.name : slug;
        const hasAccess = accessSet.has(slug);
        const checked = hasAccess ? 'checked' : '';
        // WYREAI-63: per-row link to the team-scoped tool-access page,
        // shown only for vendors the team has server-access for (no point
        // configuring tool-allowlist on a vendor the team can't reach).
        // Rendered as a sibling to the label so clicking the link doesn't
        // toggle the checkbox.
        const toolsLink = hasAccess
          ? `<a class="vendor-tools-link" href="/org/teams/${escapeHtml(team.id)}/tool-access/${escapeHtml(slug)}" title="Configure tool access for ${escapeHtml(label)}">Tools</a>`
          : '';
        return `<div class="vendor-check-row">
          <label class="vendor-check">
            <input type="checkbox" ${checked} onchange="toggleTeamAccess('${escapeHtml(team.id)}', '${escapeHtml(slug)}', this.checked)" />
            ${escapeHtml(label)}
          </label>
          ${toolsLink}
        </div>`;
      }).join('');

  return `
    <div class="team-card" data-team-id="${escapeHtml(team.id)}">
      <div class="team-card-header">
        <input type="text" class="team-name-input" value="${escapeHtml(team.name)}" onblur="renameTeam('${escapeHtml(team.id)}', this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
        <button class="btn-sm btn-danger" onclick="deleteTeam('${escapeHtml(team.id)}', '${escapeHtml(team.name)}')">Delete</button>
        <a class="btn-sm btn-primary" href="/org/teams/${escapeHtml(team.id)}/connections" style="text-decoration:none">Connections</a>
      </div>
      <div class="team-section">
        <h3>Members</h3>
        ${memberList}
        ${memberOptions ? `
          <div class="add-member-row">
            <select class="member-select" id="add-member-${escapeHtml(team.id)}">
              <option value="">Add member...</option>
              ${memberOptions}
            </select>
            <button class="btn-sm btn-primary" onclick="addTeamMember('${escapeHtml(team.id)}')">Add</button>
          </div>` : ''}
      </div>
      <div class="team-section">
        <h3>Server Access</h3>
        <div class="vendor-checks">${vendorCheckboxes}</div>
      </div>
    </div>`;
}

export function renderTeamTeams(data: TeamTeamsData): string {
  const { orgId, teams, orgMembers, orgVendors } = data;

  const teamCards = teams.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px">No teams yet. Create one to group members and manage vendor access collectively.</p>'
    : teams.map((t) => renderTeamCard(t, orgMembers, orgVendors)).join('');

  return `
    <h1 style="margin-bottom:4px">Teams</h1>
    <p class="section-desc">Group members into teams and assign vendor access collectively. A member's effective access is the union of their personal grants and all team grants.</p>

    <div class="create-team-form">
      <input type="text" id="new-team-name" placeholder="New team name" class="team-name-input" />
      <button class="btn-sm btn-primary" onclick="createTeam()">Create Team</button>
    </div>

    <div class="teams-list">${teamCards}</div>

    <div class="toast" id="toast"></div>

    <script>
      var orgId = '${escapeHtml(orgId)}';

      function showToast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(function() { t.classList.remove('show'); }, 2000);
      }

      async function createTeam() {
        var nameInput = document.getElementById('new-team-name');
        var name = nameInput.value.trim();
        if (!name) { alert('Team name is required'); return; }
        var res = await fetch('/api/orgs/' + orgId + '/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        });
        if (res.ok) {
          showToast('Team created');
          window.location.reload();
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      }

      async function renameTeam(teamId, name) {
        name = name.trim();
        if (!name) { window.location.reload(); return; }
        var res = await fetch('/api/orgs/' + orgId + '/teams/' + teamId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        });
        if (res.ok) {
          showToast('Team renamed');
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
          window.location.reload();
        }
      }

      async function deleteTeam(teamId, name) {
        if (!confirm('Delete team "' + name + '"? This cannot be undone.')) return;
        var res = await fetch('/api/orgs/' + orgId + '/teams/' + teamId, { method: 'DELETE' });
        if (res.ok) {
          showToast('Team deleted');
          window.location.reload();
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      }

      async function addTeamMember(teamId) {
        var select = document.getElementById('add-member-' + teamId);
        var userId = select.value;
        if (!userId) return;
        var res = await fetch('/api/orgs/' + orgId + '/teams/' + teamId + '/members/' + userId, { method: 'PUT' });
        if (res.ok) {
          showToast('Member added');
          window.location.reload();
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      }

      async function removeTeamMember(teamId, userId) {
        var res = await fetch('/api/orgs/' + orgId + '/teams/' + teamId + '/members/' + userId, { method: 'DELETE' });
        if (res.ok) {
          showToast('Member removed');
          window.location.reload();
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      }

      async function toggleTeamAccess(teamId, vendor, granted) {
        var url = '/api/orgs/' + orgId + '/teams/' + teamId + '/server-access/' + vendor;
        var method = granted ? 'PUT' : 'DELETE';
        var res = await fetch(url, { method: method });
        if (!res.ok) {
          var data = await res.json().catch(function() { return {}; });
          alert('Failed: ' + (data.error || 'Unknown error'));
          window.location.reload();
        } else {
          showToast(granted ? 'Access granted' : 'Access revoked');
        }
      }
    </script>`;
}

export const TEAM_TEAMS_STYLES = `
  .section-desc {
    color: var(--text-secondary);
    font-size: 14px;
    margin-bottom: 20px;
  }
  .create-team-form {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
  }
  .team-name-input {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 14px;
    font-family: inherit;
    flex: 1;
    max-width: 300px;
  }
  .team-name-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .teams-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .team-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .team-card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .team-card-header .team-name-input {
    font-size: 16px;
    font-weight: 600;
    max-width: none;
    flex: 1;
  }
  .team-section {
    margin-bottom: 12px;
  }
  .team-section:last-child {
    margin-bottom: 0;
  }
  .team-section h3 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-tertiary);
    margin-bottom: 8px;
  }
  .team-member-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .add-member-row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .member-select {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 13px;
    font-family: inherit;
    flex: 1;
    max-width: 250px;
  }
  .vendor-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .vendor-check-row {
    display: inline-flex; align-items: center; gap: 8px;
  }
  .vendor-tools-link {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg-subtle); color: var(--text-secondary);
    text-decoration: none; border: 1px solid var(--border-subtle);
  }
  .vendor-tools-link:hover { color: var(--text-primary); border-color: var(--border-primary); }
  .vendor-check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .vendor-check input {
    accent-color: var(--accent);
    cursor: pointer;
  }
  .btn-sm {
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-danger {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-primary);
  }
  .btn-danger:hover {
    color: var(--error-text);
    border-color: var(--error-text);
  }
`;
