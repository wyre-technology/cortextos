import { escapeHtml } from '../helpers.js';

export interface TeamServiceClientsData {
  orgId: string;
  baseUrl: string;
  serviceClients: {
    id: string;
    name: string;
    clientId: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }[];
}

export function renderTeamServiceClients(data: TeamServiceClientsData): string {
  const { orgId, baseUrl, serviceClients } = data;

  const clientsTable = serviceClients.length > 0 ? `
    <div class="org-section" style="padding:0;overflow:auto">
      <table>
        <thead><tr><th>Name</th><th>Client ID</th><th>Last Used</th><th>Expires</th><th></th></tr></thead>
        <tbody>${serviceClients.map((c) => `
          <tr>
            <td>${escapeHtml(c.name)}</td>
            <td><code style="font-size:12px">${escapeHtml(c.clientId)}</code></td>
            <td>${c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleDateString() : 'Never'}</td>
            <td>${c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : 'Never'}</td>
            <td style="white-space:nowrap">
              <a class="btn-sm btn-primary" href="/org/service-clients/${escapeHtml(c.clientId)}/connections" style="text-decoration:none;margin-right:4px">Connections</a>
              <button class="btn-disconnect" onclick="revokeServiceClient('${escapeHtml(c.clientId)}')">Revoke</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<p style="font-size:13px;color:var(--text-tertiary)">No service clients yet.</p>`;

  return `
    <h1 style="margin-bottom:4px">Service Clients</h1>
    <p class="section-desc">Create credentials for AI agents and automations to access your team's MCP servers programmatically.</p>

    <div style="margin-bottom:12px">
      <button class="btn-create-invite" onclick="showCreateServiceClient()">Create Service Client</button>
    </div>

    <div id="svcCreateForm" style="display:none;margin-bottom:16px" class="org-section">
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:16px">
        <div style="flex:1;min-width:200px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">Name</label>
          <input id="svcName" type="text" placeholder="e.g. Willow Documentation Agent" style="width:100%;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:6px;color:var(--text-primary);font-size:13px"/>
        </div>
        <div style="min-width:120px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">Expires (days)</label>
          <input id="svcExpiry" type="number" placeholder="365" min="1" style="width:100%;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:6px;color:var(--text-primary);font-size:13px"/>
        </div>
        <button class="btn-connect" onclick="createServiceClient()" style="width:auto;padding:8px 16px">Create</button>
        <button class="btn-disconnect" onclick="document.getElementById('svcCreateForm').style.display='none'">Cancel</button>
      </div>
      <div id="svcError" style="color:var(--error);font-size:13px;padding:0 16px 12px;display:none"></div>
    </div>

    <div id="svcSecret" style="display:none;margin-bottom:16px" class="org-section">
      <div style="padding:16px">
        <p style="font-size:13px;color:var(--warning-text);margin-bottom:8px">Save these credentials now — the secret cannot be retrieved later.</p>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Client ID</div>
        <code id="svcClientId" style="display:block;background:var(--bg-body);padding:8px 12px;border-radius:4px;font-size:13px;color:var(--text-primary);margin-bottom:8px;word-break:break-all"></code>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Client Secret</div>
        <code id="svcClientSecret" style="display:block;background:var(--bg-body);padding:8px 12px;border-radius:4px;font-size:13px;color:var(--text-primary);margin-bottom:8px;word-break:break-all"></code>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Token Endpoint</div>
        <code style="display:block;background:var(--bg-body);padding:8px 12px;border-radius:4px;font-size:13px;color:var(--text-primary);margin-bottom:12px;word-break:break-all">${escapeHtml(baseUrl)}/oauth/token</code>
        <button class="btn-connect" onclick="document.getElementById('svcSecret').style.display='none';window.location.reload()" style="width:auto;padding:8px 16px">Done</button>
      </div>
    </div>

    ${clientsTable}

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      function showCreateServiceClient() {
        document.getElementById('svcCreateForm').style.display = 'block';
        document.getElementById('svcSecret').style.display = 'none';
        document.getElementById('svcName').focus();
      }

      async function createServiceClient() {
        const name = document.getElementById('svcName').value.trim();
        if (!name) { alert('Name is required'); return; }
        const expiry = document.getElementById('svcExpiry').value;
        const body = { name };
        if (expiry) body.expires_in_days = parseInt(expiry, 10);
        const res = await fetch('/api/orgs/' + orgId + '/service-clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = await res.json();
          document.getElementById('svcCreateForm').style.display = 'none';
          document.getElementById('svcClientId').textContent = data.client_id;
          document.getElementById('svcClientSecret').textContent = data.client_secret;
          document.getElementById('svcSecret').style.display = 'block';
          showToast('Service client created');
        } else {
          const data = await res.json().catch(function() { return {}; });
          const errEl = document.getElementById('svcError');
          errEl.textContent = data.error || 'Failed to create service client';
          errEl.style.display = 'block';
        }
      }

      async function revokeServiceClient(clientId) {
        if (!confirm('Revoke this service client? Any agents using it will lose access.')) return;
        const res = await fetch('/api/orgs/' + orgId + '/service-clients/' + clientId, { method: 'DELETE' });
        if (res.ok) {
          showToast('Service client revoked');
          window.location.reload();
        } else alert('Failed to revoke service client');
      }
    </script>`;
}

export const TEAM_SERVICE_CLIENTS_STYLES = `
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 10px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--border-subtle);
  }
  th { color: var(--text-tertiary); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { color: var(--text-label); }
  .btn-create-invite {
    display: inline-flex; align-items: center;
    padding: 8px 16px; background: var(--accent); color: #fff;
    font-size: 13px; font-weight: 600; font-family: inherit;
    border: none; border-radius: 6px; cursor: pointer;
  }
  .btn-create-invite:hover { background: var(--accent-hover); }
`;
