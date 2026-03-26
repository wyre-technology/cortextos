import { VENDORS } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';

export interface TeamToolAccessData {
  orgId: string;
  orgVendors: string[];
}

export function renderTeamToolAccess(data: TeamToolAccessData): string {
  const { orgId, orgVendors } = data;

  const vendorPanels = orgVendors.map((slug) => {
    const vendor = VENDORS[slug];
    if (!vendor) return '';
    const name = escapeHtml(vendor.name);
    return `
      <div class="org-section" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleToolAccess('${escapeHtml(slug)}')">
          <span class="vendor-name">${name}</span>
          <span id="ta-arrow-${escapeHtml(slug)}" style="color:var(--text-tertiary);font-size:12px">&#9654;</span>
        </div>
        <div id="ta-panel-${escapeHtml(slug)}" style="display:none;margin-top:16px">
          <div style="color:var(--text-muted);font-size:13px">Loading tools...</div>
        </div>
      </div>`;
  }).join('');

  const emptyState = orgVendors.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px">Connect a vendor in Team Connections to manage tool access.</p>'
    : '';

  return `
    <h1 style="margin-bottom:4px">Tool Access</h1>
    <p class="section-desc">Control which tools each role can use. No restrictions = all tools allowed.</p>
    ${vendorPanels}
    ${emptyState}

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';
      const toolAccessLoaded = {};

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
      }

      async function toggleToolAccess(slug) {
        const panel = document.getElementById('ta-panel-' + slug);
        const arrow = document.getElementById('ta-arrow-' + slug);
        if (panel.style.display === 'none') {
          panel.style.display = 'block';
          arrow.innerHTML = '&#9660;';
          if (!toolAccessLoaded[slug]) {
            await loadToolAccess(slug);
            toolAccessLoaded[slug] = true;
          }
        } else {
          panel.style.display = 'none';
          arrow.innerHTML = '&#9654;';
        }
      }

      async function loadToolAccess(slug) {
        const panel = document.getElementById('ta-panel-' + slug);
        try {
          const [discoverRes, allowlistRes] = await Promise.all([
            fetch('/api/orgs/' + orgId + '/tool-access/' + slug + '/discover'),
            fetch('/api/orgs/' + orgId + '/tool-access/' + slug),
          ]);
          if (!discoverRes.ok || !allowlistRes.ok) {
            const failedRes = !discoverRes.ok ? discoverRes : allowlistRes;
            const failedLabel = !discoverRes.ok ? 'discover' : 'allowlist';
            let detail = failedRes.status + ' ' + failedRes.statusText;
            try { const body = await failedRes.json(); if (body.error) detail = body.error; } catch {}
            panel.innerHTML = '<p style="color:var(--error);font-size:13px">Failed to load tools (' + failedLabel + '): ' + escapeHtml(detail) + '</p>';
            return;
          }
          const { tools } = await discoverRes.json();
          const allowlists = await allowlistRes.json();

          if (!tools || tools.length === 0) {
            panel.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No tools discovered from this vendor.</p>';
            return;
          }

          let html = '';
          for (const role of ['member']) {
            const current = allowlists[role];
            const isRestricted = current !== null;
            html += '<div style="margin-bottom:16px">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
            html += '<span style="font-size:13px;font-weight:600;color:var(--text-label);text-transform:capitalize">' + role + ' tools</span>';
            html += '<div style="display:flex;gap:8px">';
            html += '<button class="btn-copy" onclick="saveToolAccess(\\'' + slug + '\\',\\'' + role + '\\')" style="font-size:11px">Save</button>';
            if (isRestricted) {
              html += '<button class="btn-disconnect" onclick="resetToolAccess(\\'' + slug + '\\',\\'' + role + '\\')" style="font-size:11px">Reset to Allow All</button>';
            }
            html += '</div></div>';
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px">';
            for (const tool of tools) {
              const checked = !isRestricted || current.includes(tool.name) ? ' checked' : '';
              html += '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">';
              html += '<input type="checkbox" data-vendor="' + slug + '" data-role="' + role + '" value="' + escapeHtml(tool.name) + '"' + checked + ' style="accent-color:var(--accent)" />';
              html += escapeHtml(tool.name);
              html += '</label>';
            }
            html += '</div></div>';
          }
          panel.innerHTML = html;
        } catch {
          panel.innerHTML = '<p style="color:var(--error);font-size:13px">Error loading tools.</p>';
        }
      }

      async function saveToolAccess(slug, role) {
        const checkboxes = document.querySelectorAll('input[data-vendor="' + slug + '"][data-role="' + role + '"]');
        const tools = [];
        checkboxes.forEach(function(cb) { if (cb.checked) tools.push(cb.value); });
        const allChecked = tools.length === checkboxes.length;

        if (allChecked) {
          const res = await fetch('/api/orgs/' + orgId + '/tool-access/' + slug + '/' + role, { method: 'DELETE' });
          if (res.ok) { showToast('Tool access updated (allow all)'); toolAccessLoaded[slug] = false; loadToolAccess(slug); }
          else alert('Failed to update tool access');
        } else {
          const res = await fetch('/api/orgs/' + orgId + '/tool-access/' + slug + '/' + role, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tools: tools }),
          });
          if (res.ok) { showToast('Tool access updated'); toolAccessLoaded[slug] = false; loadToolAccess(slug); }
          else alert('Failed to update tool access');
        }
      }

      async function resetToolAccess(slug, role) {
        if (!confirm('Reset to allow all tools for ' + role + 's?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/tool-access/' + slug + '/' + role, { method: 'DELETE' });
        if (res.ok) {
          showToast('Reset to allow all');
          toolAccessLoaded[slug] = false;
          loadToolAccess(slug);
        } else alert('Failed to reset tool access');
      }
    </script>`;
}

export const TEAM_TOOL_ACCESS_STYLES = `
  .btn-copy {
    font-size: 12px; font-weight: 500; font-family: inherit;
    background: transparent; color: var(--accent-light);
    border: 1px solid var(--border-primary); border-radius: 6px;
    padding: 4px 10px; cursor: pointer; transition: border-color 0.15s;
  }
  .btn-copy:hover { border-color: var(--accent-light); }
`;
