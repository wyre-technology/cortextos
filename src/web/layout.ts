import type { Auth0User } from '../auth/auth0.js';
import type { Organization } from '../org/org-service.js';
import { PAGE_STYLES } from './styles.js';
import { escapeHtml } from './helpers.js';

export interface LayoutContext {
  user: Auth0User;
  org: Organization | null;
  activePath: string;
  title: string;
  pageStyles?: string;
  pageScripts?: string;
}

interface NavItem {
  label: string;
  href: string;
}

const PERSONAL_NAV: NavItem[] = [
  { label: 'Connections', href: '/settings' },
  { label: 'Profile', href: '/settings/profile' },
];

const TEAM_NAV: NavItem[] = [
  { label: 'Overview', href: '/settings/team' },
  { label: 'Members', href: '/settings/team/members' },
  { label: 'Invitations', href: '/settings/team/invitations' },
  { label: 'Connections', href: '/settings/team/connections' },
  { label: 'Tool Access', href: '/settings/team/tool-access' },
  { label: 'Server Access', href: '/settings/team/server-access' },
  { label: 'Teams', href: '/settings/team/teams' },
  { label: 'Service Accounts', href: '/settings/team/service-clients' },
  { label: 'Log Shipping', href: '/settings/team/log-shipping' },
  { label: 'Audit Log', href: '/settings/team/audit' },
];

const LAYOUT_STYLES = `
  ${PAGE_STYLES}
  body {
    padding: 0 !important;
    display: block !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .layout {
    display: flex;
    min-height: 100vh;
  }

  /* Sidebar */
  .sidebar {
    width: 240px;
    min-width: 240px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 50;
    overflow-y: auto;
  }
  .sidebar-brand {
    padding: 20px 16px 4px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .sidebar-email {
    padding: 0 16px 16px;
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sidebar-section {
    padding: 12px 0 4px;
  }
  .sidebar-section-label {
    padding: 0 16px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .sidebar-item {
    display: block;
    padding: 7px 16px 7px 14px;
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
    border-left: 2px solid transparent;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }
  .sidebar-item:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .sidebar-item.active {
    color: var(--text-primary);
    border-left-color: var(--accent);
    background: rgba(37,99,235,0.08);
  }
  .sidebar-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 8px 16px;
  }
  .sidebar-footer {
    margin-top: auto;
    padding: 8px 0 16px;
  }
  .sidebar-footer .sidebar-item {
    color: var(--text-muted);
  }
  .sidebar-footer .sidebar-item:hover {
    color: var(--text-secondary);
  }
  .sidebar-upgrade {
    margin: 8px 16px;
    padding: 12px;
    background: rgba(37,99,235,0.08);
    border: 1px solid rgba(37,99,235,0.2);
    border-radius: 6px;
    font-size: 12px;
    color: var(--accent-text);
  }
  .sidebar-upgrade a {
    color: var(--accent-text);
    text-decoration: underline;
  }

  /* Theme toggle */
  .theme-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 16px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
    background: none;
    border: none;
    font-family: inherit;
    width: 100%;
    text-align: left;
    transition: color 0.12s;
  }
  .theme-toggle:hover { color: var(--text-secondary); }
  .theme-toggle svg { width: 16px; height: 16px; flex-shrink: 0; }

  /* Content area */
  .content {
    flex: 1;
    margin-left: 240px;
    padding: 32px 40px;
    overflow-y: auto;
    min-height: 100vh;
  }
  .content-inner {
    max-width: 800px;
  }

  /* Mobile hamburger bar */
  .mobile-bar {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border-subtle);
    z-index: 60;
    align-items: center;
    padding: 0 16px;
  }
  .hamburger {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
  }
  .hamburger:hover { color: var(--text-primary); }
  .mobile-brand {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-left: 12px;
  }
  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    z-index: 45;
  }

  @media (max-width: 768px) {
    .sidebar {
      transform: translateX(-100%);
      transition: transform 0.2s ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .sidebar-overlay.open {
      display: block;
    }
    .mobile-bar {
      display: flex;
    }
    .content {
      margin-left: 0;
      padding-top: 64px;
      padding-left: 16px;
      padding-right: 16px;
    }
  }
`;

function renderNavItem(item: NavItem, activePath: string): string {
  const isActive = activePath === item.href;
  const cls = isActive ? 'sidebar-item active' : 'sidebar-item';
  return `<a class="${cls}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
}

export function renderLayout(ctx: LayoutContext, bodyContent: string): string {
  const { user, org, activePath, title, pageStyles, pageScripts } = ctx;
  const userEmail = escapeHtml(user.email || user.sub);
  const orgName = org ? escapeHtml(org.name) : '';
  const isPro = org?.plan === 'pro';

  const personalNav = PERSONAL_NAV
    .map((item) => renderNavItem(item, activePath))
    .join('');

  let teamNav = '';
  if (org && isPro) {
    const planBadge = '<span style="font-size:10px;font-weight:600;color:var(--accent-text);background:rgba(37,99,235,0.15);padding:1px 5px;border-radius:3px;margin-left:6px">PRO</span>';
    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">${orgName} ${planBadge}</div>
      ${TEAM_NAV.map((item) => renderNavItem(item, activePath)).join('')}
    </div>`;
  } else if (org && !isPro) {
    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">${orgName}</div>
      <div class="sidebar-upgrade">
        Upgrade to Pro for team management, shared connections, and audit logging.
      </div>
    </div>`;
  } else {
    teamNav = `
    <div class="sidebar-section">
      <div class="sidebar-section-label">Team</div>
      <div class="sidebar-upgrade">
        <a href="/settings">Create a team</a> to share vendor connections with your colleagues.
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - Wyre Technology</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>
    ${LAYOUT_STYLES}
    ${pageStyles || ''}
  </style>
</head>
<body>
  <!-- Mobile top bar -->
  <div class="mobile-bar">
    <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">&#9776;</button>
    <span class="mobile-brand">Wyre Technology</span>
  </div>
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>

  <div class="layout">
    <!-- Sidebar -->
    <nav class="sidebar" id="sidebar">
      <div class="sidebar-brand">Wyre Technology</div>
      <div class="sidebar-email">${userEmail}</div>

      <div class="sidebar-section">
        <div class="sidebar-section-label">Personal</div>
        ${personalNav}
      </div>

      ${teamNav}

      <div class="sidebar-footer">
        <div class="sidebar-divider"></div>
        <a class="sidebar-item" href="/">Docs</a>
        <a class="sidebar-item" href="/getting-started/">Getting Started</a>
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Toggle theme">
          <svg id="themeIconSun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg id="themeIconMoon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <span id="themeLabel">Dark mode</span>
        </button>
        <a class="sidebar-item" href="/auth/logout">Log out</a>
      </div>
    </nav>

    <!-- Main content -->
    <main class="content">
      <div class="content-inner">
        ${bodyContent}
      </div>
    </main>
  </div>

  <script>
    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('open');
    }
    function updateThemeUI() {
      var isLight = document.documentElement.classList.contains('light');
      document.getElementById('themeIconSun').style.display = isLight ? 'block' : 'none';
      document.getElementById('themeIconMoon').style.display = isLight ? 'none' : 'block';
      document.getElementById('themeLabel').textContent = isLight ? 'Light mode' : 'Dark mode';
    }
    function toggleTheme() {
      document.documentElement.classList.toggle('light');
      var isLight = document.documentElement.classList.contains('light');
      localStorage.setItem('gateway-theme', isLight ? 'light' : 'dark');
      updateThemeUI();
    }
    updateThemeUI();
  </script>
  ${pageScripts || ''}
</body>
</html>`;
}
