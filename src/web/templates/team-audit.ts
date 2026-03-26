import { escapeHtml } from '../helpers.js';

export interface TeamAuditData {
  orgId: string;
}

export function renderTeamAudit(data: TeamAuditData): string {
  const { orgId } = data;

  return `
    <h1 style="margin-bottom:16px">Audit Log</h1>
    <div class="tabs">
      <button class="tab active" onclick="switchTab('proxy')">Proxy Logs</button>
      <button class="tab" onclick="switchTab('admin')">Admin Actions</button>
    </div>
    <div id="proxy-panel" class="tab-panel active">
      <div class="filters">
        <select id="vendor"><option value="">All vendors</option></select>
        <input type="date" id="start" placeholder="Start date"/>
        <input type="date" id="end" placeholder="End date"/>
        <button class="btn" onclick="loadLog()">Filter</button>
        <a class="btn btn-secondary" id="csv-link" href="/api/audit?format=csv&amp;org_id=${escapeHtml(orgId)}" target="_blank">Export CSV</a>
      </div>
      <table>
        <thead><tr><th>Time</th><th>User</th><th>Vendor</th><th>Tool</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody id="log-body"><tr><td colspan="6" style="color:var(--text-tertiary)">Loading...</td></tr></tbody>
      </table>
      <div class="pagination">
        <button class="btn btn-secondary" id="prev" onclick="prevPage()" disabled>&larr; Prev</button>
        <span id="page-info">Page 1</span>
        <button class="btn btn-secondary" id="next" onclick="nextPage()">Next &rarr;</button>
      </div>
    </div>
    <div id="admin-panel" class="tab-panel">
      <div class="filters">
        <select id="admin-event-type">
          <option value="">All events</option>
          <option value="member_invited">Member Invited</option>
          <option value="member_removed">Member Removed</option>
          <option value="invitation_accepted">Invitation Accepted</option>
          <option value="invitation_revoked">Invitation Revoked</option>
          <option value="org_credential_created">Credential Created</option>
          <option value="org_credential_deleted">Credential Deleted</option>
          <option value="role_changed">Role Changed</option>
          <option value="org_updated">Org Updated</option>
          <option value="org_deleted">Org Deleted</option>
          <option value="billing_plan_changed">Plan Changed</option>
        </select>
        <input type="date" id="admin-start" placeholder="Start date"/>
        <input type="date" id="admin-end" placeholder="End date"/>
        <button class="btn" onclick="loadAdminLog()">Filter</button>
        <a class="btn btn-secondary" id="admin-csv-link" href="/api/audit/admin?format=csv&amp;org_id=${escapeHtml(orgId)}" target="_blank">Export CSV</a>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Target</th><th>Details</th></tr></thead>
        <tbody id="admin-log-body"><tr><td colspan="5" style="color:var(--text-tertiary)">Loading...</td></tr></tbody>
      </table>
      <div class="pagination">
        <button class="btn btn-secondary" id="admin-prev" onclick="adminPrevPage()" disabled>&larr; Prev</button>
        <span id="admin-page-info">Page 1</span>
        <button class="btn btn-secondary" id="admin-next" onclick="adminNextPage()">Next &rarr;</button>
      </div>
    </div>

    <script>
      const orgId = '${escapeHtml(orgId)}';
      let page = 0;
      const pageSize = 50;

      var metadataLabels = {
        newRole: 'New role', oldRole: 'Old role', vendor: 'Vendor',
        memberRole: 'Role', name: 'Name', clientId: 'Client ID',
        expiresAt: 'Expires', vendors: 'Vendors', defaultServerAccess: 'Default access',
        invitationId: 'Invitation'
      };

      function formatMetadata(eventType, meta) {
        if (!meta) return '-';
        var parts = [];
        Object.keys(meta).forEach(function(k) {
          var label = metadataLabels[k] || k;
          var val = meta[k];
          if (Array.isArray(val)) val = val.join(', ');
          if (val != null && val !== '') parts.push(label + ': ' + val);
        });
        return parts.length > 0 ? parts.join(' &middot; ') : '-';
      }

      async function loadLog() {
        const vendor = document.getElementById('vendor').value;
        const start = document.getElementById('start').value;
        const end = document.getElementById('end').value;
        const params = new URLSearchParams({ org_id: orgId, limit: String(pageSize), offset: String(page * pageSize) });
        if (vendor) params.set('vendor', vendor);
        if (start) params.set('start', start + 'T00:00:00Z');
        if (end) params.set('end', end + 'T23:59:59Z');

        const res = await fetch('/api/audit?' + params.toString());
        const data = await res.json();

        params.set('format', 'csv');
        document.getElementById('csv-link').href = '/api/audit?' + params.toString();

        const tbody = document.getElementById('log-body');
        if (!data.entries || data.entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-tertiary)">No entries found</td></tr>';
        } else {
          tbody.innerHTML = data.entries.map(function(e) {
            var time = new Date(e.createdAt).toLocaleString();
            var statusClass = e.statusCode < 400 ? 'status-ok' : 'status-err';
            var duration = e.responseTimeMs != null ? e.responseTimeMs + 'ms' : '-';
            var userDisplay = e.userEmail || e.userName || e.userId.slice(0,12) + '...';
            var credType = e.orgId ? '' : ' <span class="personal-badge">personal</span>';
            return '<tr><td>' + time + '</td><td>' + userDisplay + credType + '</td><td>' + e.vendorSlug + '</td><td>' + (e.toolName||'-') + '</td><td class="' + statusClass + '">' + e.statusCode + '</td><td>' + duration + '</td></tr>';
          }).join('');
        }

        document.getElementById('page-info').textContent = 'Page ' + (page + 1) + ' of ' + Math.max(1, Math.ceil(data.total / pageSize));
        document.getElementById('prev').disabled = page === 0;
        document.getElementById('next').disabled = (page + 1) * pageSize >= data.total;
      }

      function prevPage() { if (page > 0) { page--; loadLog(); } }
      function nextPage() { page++; loadLog(); }

      function switchTab(tab) {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        document.querySelector('[onclick="switchTab(\\'' + tab + '\\')"]').classList.add('active');
        document.getElementById(tab + '-panel').classList.add('active');
        if (tab === 'admin' && !adminLoaded) { loadAdminLog(); adminLoaded = true; }
      }

      let adminPage = 0;
      let adminLoaded = false;

      async function loadAdminLog() {
        const eventType = document.getElementById('admin-event-type').value;
        const start = document.getElementById('admin-start').value;
        const end = document.getElementById('admin-end').value;
        const params = new URLSearchParams({ org_id: orgId, limit: String(pageSize), offset: String(adminPage * pageSize) });
        if (eventType) params.set('event_type', eventType);
        if (start) params.set('start', start + 'T00:00:00Z');
        if (end) params.set('end', end + 'T23:59:59Z');

        const res = await fetch('/api/audit/admin?' + params.toString());
        const data = await res.json();

        params.set('format', 'csv');
        document.getElementById('admin-csv-link').href = '/api/audit/admin?' + params.toString();

        const tbody = document.getElementById('admin-log-body');
        if (!data.entries || data.entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-tertiary)">No entries found</td></tr>';
        } else {
          tbody.innerHTML = data.entries.map(function(e) {
            var time = new Date(e.createdAt).toLocaleString();
            var actor = e.actorEmail || e.actorName || (e.actorId.length > 12 ? e.actorId.slice(0,12) + '...' : e.actorId);
            var target = e.targetId ? (e.targetEmail || e.targetName || (e.targetId.length > 12 ? e.targetId.slice(0,12) + '...' : e.targetId)) : '-';
            var details = formatMetadata(e.eventType, e.metadata);
            return '<tr><td>' + time + '</td><td>' + actor + '</td><td><span class="event-badge">' + e.eventType.replace(/_/g, ' ') + '</span></td><td>' + target + '</td><td>' + details + '</td></tr>';
          }).join('');
        }

        document.getElementById('admin-page-info').textContent = 'Page ' + (adminPage + 1) + ' of ' + Math.max(1, Math.ceil(data.total / pageSize));
        document.getElementById('admin-prev').disabled = adminPage === 0;
        document.getElementById('admin-next').disabled = (adminPage + 1) * pageSize >= data.total;
      }

      function adminPrevPage() { if (adminPage > 0) { adminPage--; loadAdminLog(); } }
      function adminNextPage() { adminPage++; loadAdminLog(); }

      loadLog();
    </script>`;
}

export const TEAM_AUDIT_STYLES = `
  .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filters select, .filters input {
    background: var(--bg-card); border: 1px solid var(--border-primary); color: var(--text-primary);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; font-family: inherit;
  }
  .btn {
    padding: 6px 14px; background: var(--accent); color: #fff;
    font-size: 13px; font-weight: 600; border: none; border-radius: 6px;
    cursor: pointer; font-family: inherit; text-decoration: none;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn-secondary { background: transparent; border: 1px solid var(--border-primary); color: var(--text-secondary); }
  .btn-secondary:hover { color: var(--text-primary); border-color: var(--border-hover); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; color: var(--text-tertiary); font-weight: 500;
    padding: 8px 12px; border-bottom: 1px solid var(--border-tertiary);
  }
  td { padding: 8px 12px; border-bottom: 1px solid var(--bg-card); }
  .status-ok { color: var(--success-text); }
  .status-err { color: var(--error); }
  .pagination {
    display: flex; gap: 8px; margin-top: 16px;
    align-items: center; font-size: 13px; color: var(--text-tertiary);
  }
  .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border-tertiary); }
  .tab {
    padding: 8px 16px; font-size: 13px; font-weight: 500; color: var(--text-tertiary);
    cursor: pointer; border-bottom: 2px solid transparent;
    background: none; border-top: none; border-left: none; border-right: none; font-family: inherit;
  }
  .tab.active { color: var(--text-heading); border-bottom-color: var(--accent); }
  .tab:hover { color: var(--text-secondary); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .event-badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 500; background: var(--badge-event-bg); color: var(--accent-text);
  }
  .personal-badge {
    display: inline-block; padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 500; background: var(--badge-personal-bg); color: var(--warning-text);
    margin-left: 4px;
  }
`;
