/** CSS custom property definitions for dark/light theming. */
export const THEME_VARS = `
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600&family=Nunito+Sans:wght@300;400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :root {
    --bg-body: #0a0a0a;
    --bg-card: #1a1a1a;
    --bg-input: #0f0f0f;
    --bg-sidebar: #111;
    --bg-vendor: #141414;
    --bg-hover: rgba(255,255,255,0.03);
    --bg-overlay: rgba(0,0,0,0.5);
    --text-primary: #e5e5e5;
    --text-heading: #f5f5f5;
    --text-secondary: #a3a3a3;
    --text-tertiary: #737373;
    --text-label: #d4d4d4;
    --text-muted: #525252;
    --text-vendor: #ededed;
    --border-primary: #333;
    --border-secondary: #2a2a2a;
    --border-tertiary: #262626;
    --border-subtle: #1e1e1e;
    --border-hover: #555;
    --accent: #00C9DB;
    --accent-hover: #00b5c6;
    --accent-light: #33d4e2;
    --accent-text: #00C9DB;
    --highlight: #EDE947;
    --success: #22c55e;
    --success-text: #4ade80;
    --error: #ef4444;
    --error-text: #fca5a5;
    --warning: #facc15;
    --warning-text: #f59e0b;
    --badge-event-bg: #0a2a2d;
    --badge-personal-bg: #2a1a1a;
    --font-heading: 'Oswald', sans-serif;
    --font-body: 'Nunito Sans', 'Inter', system-ui, sans-serif;
    --font-mono: 'IBM Plex Mono', monospace;
  }
  :root.light {
    --bg-body: #f8f8f8;
    --bg-card: #ffffff;
    --bg-input: #ffffff;
    --bg-sidebar: #f0f0f0;
    --bg-vendor: #fafafa;
    --bg-hover: rgba(0,0,0,0.03);
    --bg-overlay: rgba(0,0,0,0.3);
    --text-primary: #1a1a1a;
    --text-heading: #0a0a0a;
    --text-secondary: #666;
    --text-tertiary: #999;
    --text-label: #333;
    --text-muted: #aaa;
    --text-vendor: #1a1a1a;
    --border-primary: #ddd;
    --border-secondary: #e0e0e0;
    --border-tertiary: #e5e5e5;
    --border-subtle: #f0f0f0;
    --border-hover: #bbb;
    --accent: #00a8b8;
    --accent-hover: #009aa8;
    --accent-light: #00b5c6;
    --accent-text: #00899a;
    --highlight: #d4cc00;
    --success-text: #16a34a;
    --error-text: #dc2626;
    --warning-text: #d97706;
    --badge-event-bg: #d9f7fa;
    --badge-personal-bg: #fef3c7;
  }
`;

/** Shared inline styles reused by auxiliary pages (success, settings, team management). */
export const PAGE_STYLES = `
  ${THEME_VARS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-body);
    background: var(--bg-body);
    color: var(--text-primary);
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 24px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    width: 100%;
    max-width: 720px;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 40px 32px;
    width: 100%;
    max-width: 480px;
    margin: 0 auto;
  }
  .brand {
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-bottom: 24px;
  }
  h1 {
    font-family: var(--font-heading);
    font-size: 22px;
    font-weight: 600;
    color: var(--text-heading);
    margin-bottom: 8px;
  }
  .subtitle {
    font-size: 14px;
    color: var(--text-secondary);
    margin-bottom: 28px;
  }
  .success-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 50%;
    margin-bottom: 20px;
    font-size: 22px;
    color: var(--success-text);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
  }
  .header-left .brand {
    margin-bottom: 4px;
    text-decoration: none;
    color: inherit;
  }
  .header-left .brand:hover { color: var(--text-primary); }
  .header-nav { display: flex; align-items: center; gap: 16px; }
  .header-nav a {
    font-size: 13px;
    color: var(--text-tertiary);
    text-decoration: none;
    transition: color 0.15s;
  }
  .header-nav a:hover { color: var(--text-primary); }
  .header-left .user-email {
    font-size: 14px;
    color: var(--text-secondary);
  }
  .btn-logout {
    font-size: 13px;
    color: var(--text-tertiary);
    text-decoration: none;
    border: 1px solid var(--border-primary);
    padding: 6px 14px;
    border-radius: 6px;
    transition: color 0.15s, border-color 0.15s;
  }
  .btn-logout:hover { color: var(--text-primary); border-color: var(--border-hover); }
  .section-title {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-heading);
    margin-bottom: 4px;
  }
  .section-desc {
    font-size: 14px;
    color: var(--text-tertiary);
    margin-bottom: 20px;
  }
  .vendor-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }
  .category-section {
    margin-bottom: 24px;
  }
  .category-section:not(:first-child) {
    border-top: 1px solid var(--border-subtle);
    padding-top: 20px;
  }
  .category-header {
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 0 0 12px 0;
  }
  .vendor-card {
    background: var(--bg-vendor);
    border: 1px solid var(--border-tertiary);
    border-left: 4px solid var(--highlight);
    border-radius: 10px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    transition: border-color 0.15s;
  }
  .vendor-card:hover { border-color: var(--border-primary); border-left-color: var(--highlight); }
  .vendor-card.connected { border-color: rgba(34, 197, 94, 0.3); }
  .vendor-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .vendor-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-vendor);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-primary);
  }
  .status-dot.active { background: var(--success); }
  .vendor-card-footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .badge-connected {
    font-size: 12px;
    font-weight: 500;
    color: var(--success-text);
  }
  .badge-shared {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.1);
    border: 1px solid rgba(0, 201, 219, 0.2);
    border-radius: 4px;
    padding: 2px 6px;
  }
  .btn-connect {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 8px 14px;
    background: var(--accent);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .btn-connect:hover { background: var(--accent-hover); }
  .btn-disconnect {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    white-space: nowrap;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .btn-disconnect:hover { color: var(--error); border-color: var(--error); }
  .back-link {
    display: block;
    text-align: center;
    margin-top: 20px;
    font-size: 13px;
    color: var(--text-tertiary);
  }
  .back-link a {
    color: var(--accent-light);
    text-decoration: none;
  }
  .back-link a:hover { text-decoration: underline; }
  .org-section {
    background: var(--bg-vendor);
    border: 1px solid var(--border-tertiary);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 32px;
  }
  .org-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .org-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-vendor);
  }
  .plan-badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 4px;
  }
  .plan-badge.free { background: var(--border-tertiary); color: var(--text-tertiary); }
  .plan-badge.pro { background: rgba(0, 201, 219, 0.15); color: var(--accent-text); }
  .org-meta { font-size: 13px; color: var(--text-tertiary); }
  .btn-upgrade {
    display: inline-flex;
    align-items: center;
    padding: 8px 16px;
    background: var(--accent);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-decoration: none;
    margin-top: 12px;
  }
  .btn-upgrade:hover { background: var(--accent-hover); }
  .btn-create-team {
    display: inline-flex;
    align-items: center;
    padding: 8px 16px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    cursor: pointer;
    text-decoration: none;
  }
  .btn-create-team:hover { color: var(--text-primary); border-color: var(--border-hover); }
  .btn-manage {
    font-size: 13px;
    color: var(--accent-light);
    text-decoration: none;
  }
  .btn-manage:hover { text-decoration: underline; }
  .upgrade-banner {
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 24px;
    font-size: 14px;
    color: var(--success-text);
  }
  .limit-banner {
    background: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.2);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--warning);
  }
  .limit-banner a { color: var(--warning); }
  .invite-banner {
    background: rgba(0, 201, 219, 0.08);
    border: 1px solid rgba(0, 201, 219, 0.35);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 24px;
    font-size: 14px;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .invite-banner strong { color: #00C9DB; }
  .invite-banner code {
    font-family: 'IBM Plex Mono', monospace;
    background: rgba(0, 201, 219, 0.14);
    border: 1px solid rgba(0, 201, 219, 0.3);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 13px;
    color: #00C9DB;
    letter-spacing: 0.05em;
  }
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }
`;
