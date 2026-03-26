import { getVendorsByCategory, VENDORS } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';

export interface TeamConnectionsData {
  orgId: string;
  orgVendors: string[];
}

const SHORT_LABELS: Record<string, string> = {
  rmm: 'RMM',
  psa: 'PSA',
  documentation: 'Docs',
  security: 'Security',
  network: 'Network',
  sales: 'Sales',
  accounting: 'Finance',
  crm: 'CRM',
  productivity: 'Productivity',
};

export const TEAM_CONNECTIONS_STYLES = `
  /* Page header */
  .connections-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .connections-count {
    font-size: 13px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Connected chips strip */
  .connected-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 24px;
  }
  .conn-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px 5px 10px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    background: rgba(96,165,250,0.07);
    border: 1px solid rgba(96,165,250,0.2);
    color: var(--accent-text);
  }
  .conn-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-light);
    flex-shrink: 0;
  }

  /* Toolbar: search + category tabs */
  .connections-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .search-box {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--border-tertiary);
    border-radius: 7px;
    background: var(--bg-input);
    transition: border-color 0.12s;
  }
  .search-box:focus-within { border-color: var(--border-primary); }
  .search-icon { color: var(--text-muted); flex-shrink: 0; }
  .search-box input {
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    width: 150px;
  }
  .search-box input::placeholder { color: var(--text-muted); }
  .cat-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .cat-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 11px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.1s, background 0.1s, border-color 0.1s;
    white-space: nowrap;
  }
  .cat-tab:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
    border-color: var(--border-secondary);
  }
  .cat-tab.active {
    color: var(--text-primary);
    background: var(--bg-hover);
    border-color: var(--border-primary);
  }
  .cat-count {
    font-size: 11px;
    line-height: 15px;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--border-tertiary);
    color: var(--text-muted);
  }
  .cat-tab.active .cat-count {
    background: rgba(37,99,235,0.15);
    color: var(--accent-text);
  }

  /* Vendor card grid */
  .vendor-section { margin-bottom: 28px; }
  .vendor-section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    margin-bottom: 10px;
    padding-left: 2px;
  }
  .vendor-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 10px;
  }
  .vendor-card {
    background: var(--bg-card);
    border: 1px solid var(--border-tertiary);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: border-color 0.15s, background 0.15s;
  }
  .vendor-card:hover { border-color: var(--border-primary); }
  .vendor-card.is-connected {
    border-color: rgba(34,197,94,0.22);
    background: rgba(34,197,94,0.025);
  }
  .vendor-card.is-connected:hover {
    border-color: rgba(34,197,94,0.35);
    background: rgba(34,197,94,0.04);
  }
  .vc-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .vc-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-heading);
    line-height: 1.2;
  }
  .vc-cat {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-top: 3px;
  }
  .vc-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 4px;
    background: var(--border-primary);
  }
  .vc-dot.connected {
    background: var(--success);
    box-shadow: 0 0 0 3px rgba(34,197,94,0.15);
  }
  .vc-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: auto;
  }
  .vc-status {
    font-size: 12px;
    font-weight: 500;
    color: var(--success-text);
  }
  .vc-btn-connect {
    font-size: 12px;
    font-weight: 500;
    color: var(--accent-text);
    background: transparent;
    border: 1px solid rgba(37,99,235,0.25);
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.1s, border-color 0.1s;
    margin-left: auto;
  }
  .vc-btn-connect:hover {
    background: rgba(37,99,235,0.08);
    border-color: rgba(37,99,235,0.4);
  }
  .vc-btn-disconnect {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.1s, border-color 0.1s;
  }
  .vc-btn-disconnect:hover { color: var(--error); border-color: var(--error); }
  .vendor-empty {
    padding: 48px 10px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }
`;

export function renderTeamConnections(data: TeamConnectionsData): string {
  const { orgId, orgVendors } = data;
  const orgVendorSet = new Set(orgVendors);
  const categories = getVendorsByCategory();
  const totalVendors = categories.reduce((sum, c) => sum + c.vendors.length, 0);

  // Connected chips
  const chips = orgVendors.map((slug) => {
    const cat = categories.find((c) => c.vendors.some((v) => v.slug === slug));
    const vendor = cat?.vendors.find((v) => v.slug === slug);
    if (!vendor) return '';
    return `<span class="conn-chip"><span class="conn-chip-dot"></span>${escapeHtml(vendor.name)}</span>`;
  }).filter(Boolean).join('');

  const connectedStrip = chips
    ? `<div class="connected-strip">${chips}</div>`
    : '';

  // Category tabs
  const categoryTabs = categories.map((cat) => {
    const short = SHORT_LABELS[cat.slug] ?? cat.label;
    return `<button class="cat-tab" data-tab="${escapeHtml(cat.slug)}" onclick="switchVendorTab('${escapeHtml(cat.slug)}')">${escapeHtml(short)} <span class="cat-count">${cat.vendors.length}</span></button>`;
  }).join('');

  const toolbar = `
    <div class="connections-toolbar">
      <div class="search-box">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="vSearch" placeholder="Filter vendors..." oninput="filterVendors()" />
      </div>
      <div class="cat-tabs">
        <button class="cat-tab active" data-tab="all" onclick="switchVendorTab('all')">All <span class="cat-count">${totalVendors}</span></button>
        ${orgVendors.length > 0 ? `<button class="cat-tab" data-tab="connected" onclick="switchVendorTab('connected')">Connected <span class="cat-count">${orgVendors.length}</span></button>` : ''}
        ${categoryTabs}
      </div>
    </div>`;

  function renderTeamVendorCard(vendor: typeof VENDORS[string], catLabel: string): string {
    const name = escapeHtml(vendor.name);
    const slug = vendor.slug;
    const isConnected = orgVendorSet.has(slug);
    const searchName = vendor.name.toLowerCase();
    const cat = escapeHtml(vendor.category);
    const safeLabel = escapeHtml(catLabel);

    if (isConnected) {
      return `
      <div class="vendor-card is-connected" data-cat="${cat}" data-name="${searchName}" data-conn="1">
        <div class="vc-top">
          <div>
            <div class="vc-name">${name}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot connected"></span>
        </div>
        <div class="vc-footer">
          <span class="vc-status">Connected</span>
          <button class="vc-btn-disconnect" onclick="disconnectOrgVendor('${escapeHtml(slug)}')">Disconnect</button>
        </div>
      </div>`;
    }

    // OAuth-only vendors: redirect to OAuth flow with org_id
    if (vendor.oauthConfig && vendor.fields.length === 0) {
      return `
      <div class="vendor-card" data-cat="${cat}" data-name="${searchName}" data-conn="0">
        <div class="vc-top">
          <div>
            <div class="vc-name">${name}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot"></span>
        </div>
        <div class="vc-footer">
          <button class="vc-btn-connect" onclick="window.location='/connect/${escapeHtml(slug)}?org_id=${escapeHtml(orgId)}'">Connect for Team →</button>
        </div>
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
      <div class="vendor-card" data-cat="${cat}" data-name="${searchName}" data-conn="0">
        <div class="vc-top">
          <div>
            <div class="vc-name">${name}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot"></span>
        </div>
        <div class="vc-footer">
          <button class="vc-btn-connect" onclick="showConnectModal('${escapeHtml(slug)}', '${name}', '${fieldsJson}')">Connect for Team →</button>
        </div>
      </div>`;
  }

  const vendorSections = categories.map((cat) => {
    const cards = cat.vendors.map((v) => renderTeamVendorCard(v, cat.label)).join('');
    return `
    <div class="vendor-section" data-group="${escapeHtml(cat.slug)}">
      <div class="vendor-section-label">${escapeHtml(cat.label)}</div>
      <div class="vendor-grid">
        ${cards}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="connections-header">
      <h1 class="section-title">Team Connections</h1>
      <span class="connections-count">${orgVendors.length} of ${totalVendors} connected</span>
    </div>
    <p class="section-desc" style="margin-bottom:20px">Manage shared vendor credentials available to all team members.</p>
    ${connectedStrip}
    ${toolbar}
    <div id="vendorList">
      ${vendorSections}
      <div class="vendor-empty" id="vendorEmpty" style="display:none">No vendors match your search.</div>
    </div>

    <!-- Connect modal overlay -->
    <div id="connectModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center">
      <div class="card" style="max-width:420px">
        <div class="brand">Wyre Technology</div>
        <h1 id="modalTitle"></h1>
        <p class="subtitle">Enter the shared credentials for your team.</p>
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
      (function() {
        var activeTab = 'all';

        function switchVendorTab(tab) {
          activeTab = tab;
          document.querySelectorAll('.cat-tab').forEach(function(t) {
            t.classList.toggle('active', t.getAttribute('data-tab') === tab);
          });
          applyVendorFilter();
        }

        function applyVendorFilter() {
          var search = document.getElementById('vSearch').value.toLowerCase().trim();
          var anyVisible = false;
          var showLabel = activeTab === 'all' || activeTab === 'connected' || search !== '';

          document.querySelectorAll('.vendor-section').forEach(function(section) {
            var sectionVisible = false;
            var lbl = section.querySelector('.vendor-section-label');

            section.querySelectorAll('.vendor-card').forEach(function(card) {
              var cat = card.getAttribute('data-cat');
              var name = card.getAttribute('data-name');
              var isConn = card.getAttribute('data-conn') === '1';

              var tabOk = activeTab === 'all'
                || activeTab === cat
                || (activeTab === 'connected' && isConn);
              var searchOk = !search || name.indexOf(search) !== -1;
              var show = tabOk && searchOk;

              card.style.display = show ? '' : 'none';
              if (show) { sectionVisible = true; anyVisible = true; }
            });

            section.style.display = sectionVisible ? '' : 'none';
            if (lbl) lbl.style.display = showLabel ? '' : 'none';
          });

          document.getElementById('vendorEmpty').style.display = anyVisible ? 'none' : '';
        }

        window.switchVendorTab = switchVendorTab;
        window.filterVendors = applyVendorFilter;
      })();

      const orgId = '${escapeHtml(orgId)}';
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
        const res = await fetch('/api/orgs/' + orgId + '/credentials/' + currentVendorSlug, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          hideConnectModal();
          showToast('Team credentials saved');
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          const data = await res.json().catch(function() { return {}; });
          const errEl = document.getElementById('modalError');
          errEl.textContent = data.error || 'Failed to save credentials';
          errEl.style.display = 'block';
        }
      });

      async function disconnectOrgVendor(slug) {
        if (!confirm('Disconnect this vendor for the entire team?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/credentials/' + slug, { method: 'DELETE' });
        if (res.ok) window.location.reload();
        else alert('Failed to disconnect vendor');
      }
    </script>`;
}
