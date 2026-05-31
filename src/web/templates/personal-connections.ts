import type { Organization } from '../../org/org-service.js';
import { brand } from '../../brand/index.js';
import { getVendorsByCategory } from '../../credentials/vendor-config.js';
import { escapeHtml } from '../helpers.js';
import { isPaidPlan } from '../../billing/gate.js';

export interface PersonalConnectionsData {
  connectedVendors: string[];
  org: Organization | null;
  orgVendors: string[];
  memberCount: number;
  connectionLimit: number;
  upgraded: boolean;
  isOwner: boolean;
  stripeEnabled: boolean;
}

// Short tab labels for the category filter bar
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

export const CONNECTIONS_PAGE_STYLES = `
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
  }
  .conn-chip-personal {
    background: rgba(34,197,94,0.07);
    border: 1px solid rgba(34,197,94,0.2);
    color: var(--success-text);
  }
  .conn-chip-team {
    background: rgba(96,165,250,0.07);
    border: 1px solid rgba(96,165,250,0.2);
    color: var(--accent-text);
  }
  .conn-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .conn-chip-personal .conn-chip-dot { background: var(--success); }
  .conn-chip-team .conn-chip-dot { background: var(--accent-light); }

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
  .vendor-card.is-team {
    border-color: rgba(96,165,250,0.22);
    background: rgba(96,165,250,0.025);
  }
  .vendor-card.is-team:hover {
    border-color: rgba(96,165,250,0.35);
    background: rgba(96,165,250,0.04);
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
  .vc-dot.team {
    background: var(--accent-light);
    box-shadow: 0 0 0 3px rgba(96,165,250,0.15);
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
  .vc-team-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-text);
    background: rgba(96,165,250,0.1);
    border: 1px solid rgba(96,165,250,0.22);
    border-radius: 4px;
    padding: 2px 7px;
  }
  .vc-btn-connect {
    font-size: 12px;
    font-weight: 500;
    color: var(--accent-text);
    background: transparent;
    border: 1px solid rgba(37,99,235,0.25);
    border-radius: 6px;
    padding: 5px 12px;
    text-decoration: none;
    transition: background 0.1s, border-color 0.1s;
    margin-left: auto;
    display: inline-block;
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
  .vc-limit-text {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }
  .vendor-empty {
    padding: 48px 10px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }
`;

export function renderPersonalConnections(data: PersonalConnectionsData): { body: string; pageStyles: string } {
  const {
    connectedVendors, org, orgVendors, memberCount,
    connectionLimit, upgraded, isOwner,
  } = data;

  const categories = getVendorsByCategory();
  const connectedSet = new Set(connectedVendors);
  const orgVendorSet = new Set(orgVendors);
  const atLimit = connectedVendors.length >= connectionLimit && connectionLimit !== Infinity;

  // Org section (create team / redeem code / pro summary)
  let orgSection = '';
  if (!org) {
    orgSection = `
    <div class="org-section">
      <div class="org-header">
        <span class="org-name">Team</span>
      </div>
      <p class="org-meta" style="margin-bottom:12px">Create a team to share vendor connections and invite your colleagues.</p>
      <form id="create-team-form" onsubmit="createTeam(event)" style="display:flex;flex-direction:column;gap:8px;max-width:320px">
        <input type="text" name="team_name" placeholder="Team name" required
          style="padding:8px 12px;border:1px solid var(--border-primary);border-radius:6px;background:var(--bg-sidebar);color:var(--text-primary);font-size:14px;font-family:inherit" />
        <input type="text" name="invite_code" placeholder="Invite code (optional)"
          style="padding:8px 12px;border:1px solid var(--border-primary);border-radius:6px;background:var(--bg-sidebar);color:var(--text-primary);font-size:14px;font-family:inherit" />
        <button type="submit" class="btn-create-team">Create a Team</button>
      </form>
    </div>
    <script>
      async function createTeam(e) {
        e.preventDefault();
        const form = document.getElementById('create-team-form');
        const name = form.team_name.value.trim();
        const invite_code = form.invite_code.value.trim() || undefined;
        if (!name) return;
        const res = await fetch('/api/orgs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, invite_code }),
        });
        if (res.ok) window.location.reload();
        else alert('Failed to create team: ' + (await res.json()).error);
      }
    </script>`;
  } else {
    // Flat-pricing: no free tier. Every org is on the single plan, so the
    // former free-community section (upgrade-to-pro CTA + redeem-code) is
    // gone — all orgs render the paid summary below.
    orgSection = `
    <div class="org-section">
      <div class="org-header">
        <span class="org-name">${escapeHtml(org.name)}</span>
        <span class="plan-badge pro">Pro</span>
      </div>
      <p class="org-meta">${memberCount} member${memberCount !== 1 ? 's' : ''}${isOwner ? ' &middot; <a class="btn-manage" href="/org">Manage Team</a>' : ''}</p>
    </div>`;
  }

  const upgradeBanner = upgraded
    ? '<div class="upgrade-banner">Your team has been upgraded to Pro! You now have unlimited connections, team management, and audit logging.</div>'
    : '';

  const limitBanner = atLimit && connectionLimit !== Infinity
    ? `<div class="limit-banner">You've reached the free tier limit of ${connectionLimit} connections.</div>`
    : '';

  // --- Connected chips ---
  const allConnectedChips: string[] = [];

  // Personal connections (sorted: connected first)
  for (const slug of connectedVendors) {
    const cat = categories.find((c) => c.vendors.some((v) => v.slug === slug));
    const vendor = cat?.vendors.find((v) => v.slug === slug);
    if (vendor) {
      allConnectedChips.push(
        `<span class="conn-chip conn-chip-personal"><span class="conn-chip-dot"></span>${escapeHtml(vendor.name)}</span>`,
      );
    }
  }

  // Team-shared connections not already personally connected
  if (org && isPaidPlan(org.plan) && orgVendors.length > 0) {
    for (const slug of orgVendors) {
      if (connectedSet.has(slug)) continue; // already shown
      const cat = categories.find((c) => c.vendors.some((v) => v.slug === slug));
      const vendor = cat?.vendors.find((v) => v.slug === slug);
      if (vendor) {
        allConnectedChips.push(
          `<span class="conn-chip conn-chip-team"><span class="conn-chip-dot"></span>${escapeHtml(vendor.name)}</span>`,
        );
      }
    }
  }

  const connectedStrip = allConnectedChips.length > 0
    ? `<div class="connected-strip">${allConnectedChips.join('')}</div>`
    : '';

  // --- Category tab counts ---
  const totalVendors = categories.reduce((sum, c) => sum + c.vendors.length, 0);
  const connectedCount = connectedVendors.length + (orgVendors.filter((s) => !connectedSet.has(s)).length);

  const categoryTabs = categories.map((cat) => {
    const short = SHORT_LABELS[cat.slug] ?? cat.label;
    const count = cat.vendors.length;
    return `<button class="cat-tab" data-tab="${escapeHtml(cat.slug)}" onclick="switchVendorTab('${escapeHtml(cat.slug)}')">${escapeHtml(short)} <span class="cat-count">${count}</span></button>`;
  }).join('');

  const toolbar = `
    <div class="connections-toolbar">
      <div class="search-box">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="vSearch" placeholder="Filter vendors..." oninput="filterVendors()" />
      </div>
      <div class="cat-tabs">
        <button class="cat-tab active" data-tab="all" onclick="switchVendorTab('all')">All <span class="cat-count">${totalVendors}</span></button>
        ${connectedCount > 0 ? `<button class="cat-tab" data-tab="connected" onclick="switchVendorTab('connected')">Connected <span class="cat-count">${connectedCount}</span></button>` : ''}
        ${categoryTabs}
      </div>
    </div>`;

  // --- Vendor cards ---
  function renderVendorCard(slug: string, name: string, category: string, categoryLabel: string, isConnected: boolean, isTeam: boolean): string {
    const safeName = escapeHtml(name);
    const safeLabel = escapeHtml(categoryLabel);
    const searchName = name.toLowerCase();

    if (isTeam && !isConnected) {
      return `
      <div class="vendor-card is-team" data-cat="${escapeHtml(category)}" data-name="${searchName}" data-conn="1">
        <div class="vc-top">
          <div>
            <div class="vc-name">${safeName}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot team"></span>
        </div>
        <div class="vc-footer">
          <span class="vc-team-badge">Team</span>
          <span class="vc-status">Connected</span>
        </div>
      </div>`;
    }

    if (isConnected) {
      return `
      <div class="vendor-card is-connected" data-cat="${escapeHtml(category)}" data-name="${searchName}" data-conn="1">
        <div class="vc-top">
          <div>
            <div class="vc-name">${safeName}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot connected"></span>
        </div>
        <div class="vc-footer">
          ${isTeam ? '<span class="vc-team-badge">Team</span>' : ''}
          <span class="vc-status">Connected</span>
          <form method="POST" action="/disconnect/${escapeHtml(slug)}" style="margin:0">
            <button type="submit" class="vc-btn-disconnect">Disconnect</button>
          </form>
        </div>
      </div>`;
    }

    if (atLimit) {
      return `
      <div class="vendor-card" data-cat="${escapeHtml(category)}" data-name="${searchName}" data-conn="0">
        <div class="vc-top">
          <div>
            <div class="vc-name">${safeName}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot"></span>
        </div>
        <div class="vc-footer">
          <span class="vc-limit-text">Limit reached</span>
        </div>
      </div>`;
    }

    return `
      <div class="vendor-card" data-cat="${escapeHtml(category)}" data-name="${searchName}" data-conn="0">
        <div class="vc-top">
          <div>
            <div class="vc-name">${safeName}</div>
            <div class="vc-cat">${safeLabel}</div>
          </div>
          <span class="vc-dot"></span>
        </div>
        <div class="vc-footer">
          <a class="vc-btn-connect" href="/connect/${escapeHtml(slug)}">Connect →</a>
        </div>
      </div>`;
  }

  const vendorSections = categories.map((cat) => {
    const cards = cat.vendors.map((v) => {
      const isPersonal = connectedSet.has(v.slug);
      const isTeam = orgVendorSet.has(v.slug);
      return renderVendorCard(v.slug, v.name, cat.slug, cat.label, isPersonal, isTeam);
    }).join('');

    return `
    <div class="vendor-section" data-group="${escapeHtml(cat.slug)}">
      <div class="vendor-section-label">${escapeHtml(cat.label)}</div>
      <div class="vendor-grid">
        ${cards}
      </div>
    </div>`;
  }).join('');

  const filterScript = `
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
  </script>`;

  const body = `
    ${upgradeBanner}
    ${orgSection}
    ${limitBanner}
    <div class="connections-header">
      <h1 class="section-title">Your Connections</h1>
      <span class="connections-count">${connectedVendors.length} of ${totalVendors} connected</span>
    </div>
    <p class="section-desc" style="margin-bottom:20px">Connect your vendor accounts to use MCP tools.</p>
    ${connectedStrip}
    ${toolbar}
    <div id="vendorList">
      ${vendorSections}
      <div class="vendor-empty" id="vendorEmpty" style="display:none">No vendors match your search.</div>
    </div>
    ${filterScript}
    <div style="display:flex;justify-content:center;gap:16px;margin-top:32px;font-size:13px;color:var(--text-muted);">
      <a href="${brand.issuesUrl}?labels=bug,gateway" target="_blank" rel="noopener noreferrer" style="color:var(--text-muted);text-decoration:none;">Report a bug</a>
      <span style="color:var(--border-primary);">|</span>
      <a href="${brand.issuesUrl}?labels=enhancement,gateway&amp;title=[Gateway]+Feature+request:+&amp;body=**Describe+the+feature**%0A%0A**Use+case**%0A" target="_blank" rel="noopener noreferrer" style="color:var(--text-muted);text-decoration:none;">Suggest a feature</a>
    </div>`;

  return { body, pageStyles: CONNECTIONS_PAGE_STYLES };
}
