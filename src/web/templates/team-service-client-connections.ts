import { getVendorsByCategory, VENDORS } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';

export interface TeamServiceClientConnectionsData {
  orgId: string;
  clientId: string;
  clientName: string;
  clientVendors: string[];
}

export function renderTeamServiceClientConnections(data: TeamServiceClientConnectionsData): string {
  const { orgId, clientId, clientName, clientVendors } = data;
  const clientVendorSet = new Set(clientVendors);
  const categories = getVendorsByCategory();

  function renderVendorCard(vendor: typeof VENDORS[string]): string {
    const name = escapeHtml(vendor.name);
    const slug = vendor.slug;
    const isConnected = clientVendorSet.has(slug);

    if (isConnected) {
      return `
      <div class="vendor-card connected">
        <div class="vendor-card-header">
          <span class="vendor-name">${name}</span>
          <span class="status-dot active"></span>
        </div>
        <div class="vendor-card-footer">
          <span class="badge-shared">Service Account</span>
          <span class="badge-connected">Connected</span>
          <button class="btn-disconnect" style="margin-left:auto" onclick="disconnectClientVendor('${escapeHtml(slug)}')">Disconnect</button>
        </div>
      </div>`;
    }

    // OAuth-only vendors: service accounts can't use OAuth — show disabled note
    if (vendor.oauthConfig && vendor.fields.length === 0) {
      return `
      <div class="vendor-card" style="opacity:0.5">
        <div class="vendor-card-header">
          <span class="vendor-name">${name}</span>
          <span class="status-dot"></span>
        </div>
        <span style="font-size:12px;color:var(--text-tertiary)">OAuth only — use org-level credentials</span>
      </div>`;
    }

    const fieldsJson = escapeHtml(JSON.stringify(vendor.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.secret ? 'password' : 'text',
      required: f.required,
      placeholder: f.placeholder || '',
      options: f.options || null,
    }))));

    return `
      <div class="vendor-card">
        <div class="vendor-card-header">
          <span class="vendor-name">${name}</span>
          <span class="status-dot"></span>
        </div>
        <button class="btn-connect" onclick="showConnectModal('${escapeHtml(slug)}', '${name}', '${fieldsJson}')">Connect</button>
      </div>`;
  }

  const vendorSections = categories
    .map((cat) => {
      const cards = cat.vendors.map(renderVendorCard).join('');
      return `
      <div class="category-section">
        <h2 class="category-header">${escapeHtml(cat.label)}</h2>
        <div class="vendor-grid">${cards}</div>
      </div>`;
    })
    .join('');

  return `
    <h1 style="margin-bottom:4px">Service Client Connections: ${escapeHtml(clientName)}</h1>
    <p class="section-desc">Manage vendor credentials for this service account. These take precedence over org-level credentials when this service account makes requests.</p>
    ${vendorSections}

    <!-- Connect modal overlay -->
    <div id="connectModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center">
      <div class="card" style="max-width:420px">
        <div class="brand">Wyre Technology</div>
        <h1 id="modalTitle"></h1>
        <p class="subtitle">Enter credentials for this service account.</p>
        <form id="modalForm" style="display:flex;flex-direction:column;gap:12px">
          <div id="modalFields"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="submit" class="btn-connect" style="flex:1">Connect</button>
            <button type="button" class="btn-disconnect" onclick="hideConnectModal()" style="flex:0">Cancel</button>
          </div>
          <div id="modalError" style="color:var(--error);font-size:13px;display:none"></div>
        </form>
      </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';
      const clientId = '${escapeHtml(clientId)}';
      let currentVendorSlug = '';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      function showConnectModal(slug, name, fieldsJson) {
        currentVendorSlug = slug;
        document.getElementById('modalTitle').textContent = 'Connect ' + name;
        const fields = JSON.parse(fieldsJson);
        const container = document.getElementById('modalFields');
        var inputStyle = 'width:100%;padding:8px 12px;background:var(--bg-body);border:1px solid var(--border-primary);border-radius:6px;color:var(--text-primary);font-size:14px;font-family:inherit;box-sizing:border-box';
        container.innerHTML = fields.map(function(f) {
          const req = f.required ? ' required' : '';
          const label = '<label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:4px">' + f.label + '</label>';
          if (f.options && f.options.length) {
            const opts = '<option value="">Select...</option>' + f.options.map(function(o) {
              return '<option value="' + o + '">' + o + '</option>';
            }).join('');
            return label + '<select name="' + f.key + '"' + req + ' style="' + inputStyle + ';cursor:pointer;appearance:none">' + opts + '</select>';
          }
          return label + '<input name="' + f.key + '" type="' + f.type + '" placeholder="' + f.placeholder + '"' + req +
            ' style="' + inputStyle + '" />';
        }).join('');
        document.getElementById('modalError').style.display = 'none';
        document.getElementById('connectModal').style.display = 'flex';
      }

      function hideConnectModal() {
        document.getElementById('connectModal').style.display = 'none';
      }

      document.getElementById('connectModal').addEventListener('click', function(e) {
        if (e.target === this) hideConnectModal();
      });

      document.getElementById('modalForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(this);
        const body = {};
        formData.forEach(function(v, k) { body[k] = v; });
        const res = await fetch('/api/orgs/' + orgId + '/service-clients/' + clientId + '/credentials/' + currentVendorSlug, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          hideConnectModal();
          showToast('Credentials saved');
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          const data = await res.json().catch(function() { return {}; });
          const errEl = document.getElementById('modalError');
          errEl.textContent = data.error || 'Failed to save credentials';
          errEl.style.display = 'block';
        }
      });

      async function disconnectClientVendor(slug) {
        if (!confirm('Disconnect this vendor for the service account?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/service-clients/' + clientId + '/credentials/' + slug, { method: 'DELETE' });
        if (res.ok) window.location.reload();
        else alert('Failed to disconnect vendor');
      }
    </script>`;
}

export const TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES = ``;
