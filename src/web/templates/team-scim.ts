import { escapeHtml } from '../helpers.js';

export interface TeamScimData {
  orgId: string;
  baseUrl: string;
  /** 'tenant' for customer/standalone orgs; 'reseller' for MSP orgs. */
  scope: 'tenant' | 'reseller';
  connections: {
    id: string;
    idpType: string;
    defaultRole: string;
    status: string;
    lastSyncAt: string | null;
    lastError: string | null;
    createdAt: string;
  }[];
}

const IDP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'entra', label: 'Microsoft Entra ID' },
  { value: 'okta', label: 'Okta' },
  { value: 'jumpcloud', label: 'JumpCloud' },
  { value: 'google', label: 'Google Workspace' },
  { value: 'generic', label: 'Other (SCIM 2.0)' },
];

export function renderTeamScim(data: TeamScimData): string {
  const { orgId, baseUrl, scope, connections } = data;
  const scopePrefix = scope === 'tenant' ? 't' : 'r';

  const idpOptions = IDP_OPTIONS.map(
    (o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`,
  ).join('');

  const tenantRoleOptions = `
    <option value="member">member</option>
    <option value="admin">admin</option>
    <option value="owner">owner</option>`;
  const resellerRoleOptions = `
    <option value="reseller_support_agent">reseller_support_agent</option>
    <option value="reseller_billing_viewer">reseller_billing_viewer</option>
    <option value="reseller_admin">reseller_admin</option>
    <option value="reseller_owner">reseller_owner</option>`;
  const roleOptions = scope === 'tenant' ? tenantRoleOptions : resellerRoleOptions;

  const connectionsTable = connections.length > 0 ? `
    <div class="org-section" style="padding:0;overflow:auto">
      <table>
        <thead><tr><th>IdP</th><th>Default role</th><th>Status</th><th>Last sync</th><th></th></tr></thead>
        <tbody>${connections.map((c) => `
          <tr>
            <td>${escapeHtml(c.idpType)}</td>
            <td><code style="font-size:12px">${escapeHtml(c.defaultRole)}</code></td>
            <td>${c.status === 'active' ? '<span style="color:var(--success-text,#1a7f37)">active</span>' : '<span style="color:var(--text-tertiary)">revoked</span>'}</td>
            <td>${c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'Never'}${c.lastError ? `<div style="font-size:11px;color:var(--error-text,#c00)">${escapeHtml(c.lastError)}</div>` : ''}</td>
            <td style="white-space:nowrap">
              ${c.status === 'active' ? `<button class="btn-disconnect" onclick="revokeConnection('${escapeHtml(c.id)}')">Revoke</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<p style="font-size:13px;color:var(--text-tertiary)">No SCIM connections yet.</p>`;

  return `
    <h1 style="margin-bottom:4px">Provisioning</h1>
    <p class="section-desc">Connect your IdP (Entra ID, Okta, JumpCloud, Google) to automatically create, update, and deactivate users in this ${scope === 'tenant' ? 'organization' : 'MSP'} via SCIM 2.0.</p>

    <div style="margin-bottom:12px">
      <button class="btn-create-invite" onclick="showCreateScim()">Connect IdP</button>
    </div>

    <div id="scimCreateForm" style="display:none;margin-bottom:16px" class="org-section">
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:16px">
        <div style="min-width:160px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">IdP</label>
          <select id="scimIdp" style="width:100%;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:6px;color:var(--text-primary);font-size:13px">${idpOptions}</select>
        </div>
        <div style="min-width:180px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">Default role</label>
          <select id="scimRole" style="width:100%;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:6px;color:var(--text-primary);font-size:13px">${roleOptions}</select>
        </div>
        <button class="btn-connect" onclick="createScim()" style="width:auto;padding:8px 16px">Generate token</button>
        <button class="btn-disconnect" onclick="document.getElementById('scimCreateForm').style.display='none'">Cancel</button>
      </div>
      <div id="scimError" style="color:var(--error);font-size:13px;padding:0 16px 12px;display:none"></div>
    </div>

    <div id="scimSecret" style="display:none;margin-bottom:16px" class="org-section">
      <div style="padding:16px">
        <p style="font-size:13px;color:var(--warning-text);margin-bottom:8px">Copy these now — the token cannot be retrieved later. Paste them into your IdP's SCIM provisioning settings.</p>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Tenant URL</div>
        <code id="scimUrl" style="display:block;background:var(--bg-body);padding:8px 12px;border-radius:4px;font-size:13px;color:var(--text-primary);margin-bottom:8px;word-break:break-all"></code>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Secret token</div>
        <code id="scimToken" style="display:block;background:var(--bg-body);padding:8px 12px;border-radius:4px;font-size:13px;color:var(--text-primary);margin-bottom:12px;word-break:break-all"></code>
        <p style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px">Setup guides:
          <a href="/docs/scim/entra" style="color:var(--accent)">Entra ID</a> &middot;
          <a href="/docs/scim/okta" style="color:var(--accent)">Okta</a> &middot;
          <a href="/docs/scim/jumpcloud" style="color:var(--accent)">JumpCloud</a> &middot;
          <a href="/docs/scim/google" style="color:var(--accent)">Google Workspace</a>
        </p>
        <button class="btn-connect" onclick="document.getElementById('scimSecret').style.display='none';window.location.reload()" style="width:auto;padding:8px 16px">Done</button>
      </div>
    </div>

    ${connectionsTable}

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';
      const scopePrefix = '${scopePrefix}';
      const baseUrl = '${escapeHtml(baseUrl)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      function showCreateScim() {
        document.getElementById('scimCreateForm').style.display = 'block';
        document.getElementById('scimSecret').style.display = 'none';
        document.getElementById('scimError').style.display = 'none';
      }

      async function createScim() {
        const idp = document.getElementById('scimIdp').value;
        const role = document.getElementById('scimRole').value;
        const res = await fetch('/api/orgs/' + orgId + '/scim/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idp_type: idp, default_role: role }),
        });
        if (res.ok) {
          const data = await res.json();
          document.getElementById('scimCreateForm').style.display = 'none';
          document.getElementById('scimUrl').textContent = baseUrl + '/scim/v2/' + scopePrefix + '/' + orgId;
          document.getElementById('scimToken').textContent = data.token;
          document.getElementById('scimSecret').style.display = 'block';
          showToast('Connection created');
        } else {
          const data = await res.json().catch(function() { return {}; });
          const errEl = document.getElementById('scimError');
          errEl.textContent = data.error || 'Failed to create SCIM connection';
          errEl.style.display = 'block';
        }
      }

      async function revokeConnection(id) {
        if (!confirm('Revoke this SCIM connection? Your IdP will lose the ability to provision users in this org.')) return;
        const res = await fetch('/api/orgs/' + orgId + '/scim/connections/' + id, { method: 'DELETE' });
        if (res.ok) {
          showToast('Connection revoked');
          window.location.reload();
        } else alert('Failed to revoke connection');
      }
    </script>`;
}

export const TEAM_SCIM_STYLES = `
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
