import { escapeHtml } from '../helpers.js';

export interface LogShippingDestinationView {
  id: string;
  label: string;
  platform: 'loki' | 'graylog' | 'logscale';
  endpointUrl: string;
  config: Record<string, string>; // already masked
  enabled: boolean;
  createdAt: string;
}

export interface TeamLogShippingData {
  orgId: string;
  destinations: LogShippingDestinationView[];
}

const PLATFORM_LABELS: Record<string, string> = {
  loki: 'Grafana Loki',
  graylog: 'Graylog',
  logscale: 'CrowdStrike Falcon LogScale',
};

export function renderTeamLogShipping(data: TeamLogShippingData): string {
  const { orgId, destinations } = data;

  const destCards = destinations.length > 0
    ? destinations.map((d) => `
      <div class="dest-card ${d.enabled ? '' : 'dest-card--disabled'}">
        <div class="dest-card-header">
          <div>
            <div class="dest-label">${escapeHtml(d.label)}</div>
            <div class="dest-meta">${escapeHtml(PLATFORM_LABELS[d.platform] ?? d.platform)} &middot; ${escapeHtml(d.endpointUrl)}</div>
          </div>
          <div class="dest-actions">
            <button class="btn-secondary" onclick="testDest('${escapeHtml(d.id)}', '${escapeHtml(d.label)}')">Test</button>
            <button class="btn-secondary" onclick="toggleDest('${escapeHtml(d.id)}', ${d.enabled})">${d.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn-disconnect" onclick="deleteDest('${escapeHtml(d.id)}', '${escapeHtml(d.label)}')">Delete</button>
          </div>
        </div>
        ${!d.enabled ? '<div class="dest-disabled-badge">Disabled</div>' : ''}
      </div>`).join('')
    : `<p style="font-size:13px;color:var(--text-tertiary)">No log shipping destinations configured yet.</p>`;

  return `
    <h1 style="margin-bottom:4px">Log Shipping</h1>
    <p class="section-desc">Forward MCP audit logs to your observability or SIEM platform in real-time. Pro plan only.</p>

    <div style="margin-bottom:12px">
      <button class="btn-create-invite" onclick="showAddForm()">Add Destination</button>
    </div>

    <div id="addForm" style="display:none;margin-bottom:16px" class="org-section">
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <label class="field-label">Label</label>
            <input id="lsLabel" type="text" placeholder="e.g. Production Loki" class="field-input"/>
          </div>
          <div style="min-width:200px">
            <label class="field-label">Platform</label>
            <select id="lsPlatform" class="field-input" onchange="updateCredFields()">
              <option value="">Select platform...</option>
              <option value="loki">Grafana Loki</option>
              <option value="graylog">Graylog</option>
              <option value="logscale">CrowdStrike Falcon LogScale</option>
            </select>
          </div>
        </div>
        <div>
          <label class="field-label">Endpoint URL</label>
          <input id="lsEndpoint" type="url" placeholder="https://logs.example.com" class="field-input" style="width:100%"/>
        </div>

        <!-- Loki fields -->
        <div id="fields-loki" style="display:none;gap:8px;flex-wrap:wrap" class="cred-fields">
          <div style="flex:1;min-width:160px">
            <label class="field-label">Username <span style="color:var(--text-muted)">(Grafana Cloud only)</span></label>
            <input id="loki-username" type="text" placeholder="e.g. 123456" class="field-input"/>
          </div>
          <div style="flex:1;min-width:200px">
            <label class="field-label">Token / API Key</label>
            <input id="loki-token" type="password" placeholder="Bearer token or Grafana Cloud API key" class="field-input"/>
          </div>
        </div>

        <!-- Graylog fields -->
        <div id="fields-graylog" style="display:none;gap:8px" class="cred-fields">
          <div style="flex:1;min-width:200px">
            <label class="field-label">Bearer Token <span style="color:var(--text-muted)">(optional)</span></label>
            <input id="graylog-token" type="password" placeholder="Optional auth token" class="field-input"/>
          </div>
        </div>

        <!-- LogScale fields -->
        <div id="fields-logscale" style="display:none;gap:8px;flex-wrap:wrap" class="cred-fields">
          <div style="flex:1;min-width:200px">
            <label class="field-label">Ingest Token</label>
            <input id="logscale-token" type="password" placeholder="LogScale ingest token" class="field-input"/>
          </div>
          <div style="flex:1;min-width:160px">
            <label class="field-label">Repository <span style="color:var(--text-muted)">(optional)</span></label>
            <input id="logscale-repository" type="text" placeholder="e.g. my-repo" class="field-input"/>
          </div>
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn-connect" onclick="addDest()" style="width:auto;padding:8px 16px">Add</button>
          <button class="btn-disconnect" onclick="document.getElementById('addForm').style.display='none'">Cancel</button>
        </div>
        <div id="lsError" style="color:var(--error);font-size:13px;display:none"></div>
      </div>
    </div>

    <div id="destList">${destCards}</div>

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2500);
      }

      function showAddForm() {
        document.getElementById('addForm').style.display = 'block';
        document.getElementById('lsLabel').focus();
      }

      function updateCredFields() {
        const platform = document.getElementById('lsPlatform').value;
        ['loki', 'graylog', 'logscale'].forEach(p => {
          const el = document.getElementById('fields-' + p);
          if (el) el.style.display = (p === platform) ? 'flex' : 'none';
        });
      }

      async function addDest() {
        const label = document.getElementById('lsLabel').value.trim();
        const platform = document.getElementById('lsPlatform').value;
        const endpointUrl = document.getElementById('lsEndpoint').value.trim();
        const errEl = document.getElementById('lsError');

        if (!label || !platform || !endpointUrl) {
          errEl.textContent = 'Label, platform, and endpoint URL are required';
          errEl.style.display = 'block';
          return;
        }

        const config = {};
        if (platform === 'loki') {
          const u = document.getElementById('loki-username').value.trim();
          const t = document.getElementById('loki-token').value.trim();
          if (u) config.username = u;
          if (t) config.token = t;
        } else if (platform === 'graylog') {
          const t = document.getElementById('graylog-token').value.trim();
          if (t) config.token = t;
        } else if (platform === 'logscale') {
          const t = document.getElementById('logscale-token').value.trim();
          const r = document.getElementById('logscale-repository').value.trim();
          if (t) config.token = t;
          if (r) config.repository = r;
        }

        const res = await fetch('/api/orgs/' + orgId + '/log-shipping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, platform, endpointUrl, config }),
        });
        if (res.ok) {
          showToast('Destination added');
          window.location.reload();
        } else {
          const data = await res.json().catch(function() { return {}; });
          errEl.textContent = data.error || 'Failed to add destination';
          errEl.style.display = 'block';
        }
      }

      async function testDest(id, label) {
        const res = await fetch('/api/orgs/' + orgId + '/log-shipping/' + id + '/test', { method: 'POST' });
        if (res.ok) {
          showToast('Test successful for ' + label);
        } else {
          const data = await res.json().catch(function() { return {}; });
          alert('Test failed: ' + (data.error || 'Unknown error'));
        }
      }

      async function toggleDest(id, currentlyEnabled) {
        const res = await fetch('/api/orgs/' + orgId + '/log-shipping/' + id + '/enabled', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !currentlyEnabled }),
        });
        if (res.ok) {
          showToast(currentlyEnabled ? 'Destination disabled' : 'Destination enabled');
          window.location.reload();
        } else {
          alert('Failed to update destination');
        }
      }

      async function deleteDest(id, label) {
        if (!confirm('Delete destination "' + label + '"? This cannot be undone.')) return;
        const res = await fetch('/api/orgs/' + orgId + '/log-shipping/' + id, { method: 'DELETE' });
        if (res.ok) {
          showToast('Destination deleted');
          window.location.reload();
        } else {
          alert('Failed to delete destination');
        }
      }
    </script>`;
}

export const TEAM_LOG_SHIPPING_STYLES = `
  .dest-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .dest-card--disabled {
    opacity: 0.6;
  }
  .dest-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .dest-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .dest-meta {
    font-size: 12px;
    color: var(--text-tertiary);
    word-break: break-all;
  }
  .dest-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .dest-disabled-badge {
    margin-top: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cred-fields { display: flex; }
  .field-label {
    font-size: 12px;
    color: var(--text-secondary);
    display: block;
    margin-bottom: 4px;
  }
  .field-input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
  }
  select.field-input { cursor: pointer; }
  .btn-secondary {
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }
  .btn-secondary:hover { border-color: var(--text-secondary); color: var(--text-primary); }
  .btn-create-invite {
    display: inline-flex; align-items: center;
    padding: 8px 16px; background: var(--accent); color: #fff;
    font-size: 13px; font-weight: 600; font-family: inherit;
    border: none; border-radius: 6px; cursor: pointer;
  }
  .btn-create-invite:hover { background: var(--accent-hover); }
`;
