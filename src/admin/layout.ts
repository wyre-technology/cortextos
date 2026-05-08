import { THEME_VARS } from '../web/styles.js';

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: '/admin/dashboard', label: 'Dashboard' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/orgs', label: 'Orgs' },
  { href: '/admin/orgs/new', label: 'New orgs' },
  { href: '/admin/audit', label: 'Audit log' },
];

export const ADMIN_STYLES = `
  ${THEME_VARS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-body);
    background: var(--bg-body);
    color: var(--text-primary);
    min-height: 100vh;
    padding: 32px 24px 64px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1100px; margin: 0 auto; }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .brand {
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .nav { display: flex; gap: 4px; }
  .nav a {
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    color: var(--text-muted);
    padding: 6px 12px;
    border-radius: 4px;
    transition: background 0.15s, color 0.15s;
  }
  .nav a:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav a.active { background: var(--bg-card); color: var(--text-heading); border: 1px solid var(--border-secondary); }
  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 32px;
    gap: 16px;
    flex-wrap: wrap;
  }
  h1 {
    font-family: var(--font-heading);
    font-size: 24px;
    font-weight: 600;
    color: var(--text-heading);
    margin-top: 4px;
  }
  h2 {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-heading);
    margin-bottom: 8px;
  }
  .subtitle { font-size: 13px; color: var(--text-muted); }
  .btn {
    display: inline-block;
    font-size: 12px;
    color: var(--accent-text);
    background: none;
    border: 1px solid rgba(0,201,219,0.3);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    transition: border-color 0.15s;
  }
  .btn:hover { border-color: var(--accent); }

  /* KPI cards */
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 32px;
  }
  .kpi {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 18px 20px;
  }
  .kpi-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .kpi-value {
    font-family: var(--font-heading);
    font-size: 28px;
    font-weight: 600;
    color: var(--text-heading);
    line-height: 1;
  }
  .kpi-sub { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; }

  /* Sections */
  .section { margin-bottom: 36px; }
  .section-title {
    font-family: var(--font-heading);
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-heading);
    margin-bottom: 12px;
  }

  /* Tables */
  .table-wrap {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    background: var(--bg-sidebar);
    padding: 10px 14px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    position: sticky;
    top: 0;
  }
  tbody tr { border-top: 1px solid var(--border-subtle); }
  tbody tr:hover { background: var(--bg-hover); }
  tbody td { padding: 9px 14px; color: var(--text-primary); }
  .num { text-align: right; font-family: var(--font-mono); font-size: 12px; }
  .muted { color: var(--text-muted); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .badge-free { background: var(--border-tertiary); color: var(--text-tertiary); }
  .badge-pro { background: rgba(0,201,219,0.15); color: var(--accent-text); }
  .badge-business { background: rgba(34,197,94,0.12); color: var(--success-text); }
  .badge-B { background: rgba(234,179,8,0.12); color: #d9a800; }
  .badge-C { background: rgba(0,201,219,0.12); color: var(--accent-text); }
  .vendor-tag {
    display: inline-block;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--accent-text);
    background: rgba(0,201,219,0.08);
    border-radius: 3px;
    padding: 1px 5px;
  }
  .empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }

  /* Charts side by side */
  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 36px;
  }
  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
  .chart-card {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 16px 20px 12px;
  }
  .chart-card-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    margin-bottom: 12px;
  }
  .chart-wrap { position: relative; height: 180px; }

  /* Layout helpers */
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }

  /* Filter form */
  .filters {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 16px;
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .filters select, .filters input {
    font-family: inherit;
    font-size: 13px;
    background: var(--bg-body);
    color: var(--text-primary);
    border: 1px solid var(--border-secondary);
    border-radius: 4px;
    padding: 6px 10px;
    min-width: 140px;
  }

  /* Report card grid (index page) */
  .report-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .report-card {
    display: block;
    padding: 18px 20px;
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, transform 0.15s;
  }
  .report-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .report-card h2 {
    font-size: 15px;
    margin-bottom: 6px;
  }
  .report-card p {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  /* Form inputs (search, comp credits) */
  .input, .input-textarea {
    font-family: inherit;
    font-size: 13px;
    background: var(--bg-body);
    color: var(--text-primary);
    border: 1px solid var(--border-secondary);
    border-radius: 4px;
    padding: 6px 10px;
  }
  .input:focus, .input-textarea:focus { border-color: var(--accent); outline: none; }
  .btn-primary {
    display: inline-block;
    font-size: 12px;
    background: var(--accent);
    color: #04181b;
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-weight: 600;
    font-family: inherit;
    text-decoration: none;
  }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-secondary {
    display: inline-block;
    font-size: 12px;
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
  }
  .btn-secondary:hover { background: var(--panel-hover, rgba(255,255,255,0.04)); }
  .btn-danger {
    display: inline-block;
    font-size: 12px;
    background: rgba(239,68,68,0.12);
    color: var(--error-text);
    border: 1px solid rgba(239,68,68,0.45);
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-weight: 600;
    font-family: inherit;
    text-decoration: none;
  }
  .btn-danger:hover { background: rgba(239,68,68,0.20); border-color: rgba(239,68,68,0.60); }
  .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Flash banners */
  .alert {
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 13px;
    border: 1px solid transparent;
  }
  .alert-ok  { background: rgba(34,197,94,0.10);  color: var(--success-text); border-color: rgba(34,197,94,0.25); }
  .alert-err { background: rgba(239,68,68,0.10);  color: var(--error-text);   border-color: rgba(239,68,68,0.25); }
  .alert-warn{ background: rgba(234,179,8,0.10);  color: var(--warning-text); border-color: rgba(234,179,8,0.25); }

  /* Two-up grid for org detail header (plan/billing + owner) */
  .org-detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 24px;
  }
  @media (max-width: 700px) { .org-detail-grid { grid-template-columns: 1fr; } }
  .panel {
    background: var(--bg-card);
    border: 1px solid var(--border-secondary);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .panel p { margin-bottom: 4px; font-size: 13px; }
  .panel p:last-child { margin-bottom: 0; }

  /* Feature on/off list */
  .feature-row {
    display: grid;
    grid-template-columns: 24px 1fr auto auto;
    gap: 12px;
    align-items: center;
    padding: 6px 0;
    border-top: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .feature-row:first-child { border-top: 0; }
  .feature-on  { color: var(--success-text); }
  .feature-off { color: var(--text-muted); }

  /* Comp-credits inline form */
  .comp-form {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 8px;
  }
  .comp-form input[type="number"] { width: 120px; }
  .comp-form input[type="text"] { flex: 1; min-width: 240px; }
`;

const THEME_BOOTSTRAP = `
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
`;

function renderNav(activePath: string): string {
  return NAV_ITEMS.map((item) => {
    const active = activePath === item.href || activePath.startsWith(item.href + '/');
    return `<a href="${item.href}"${active ? ' class="active"' : ''}>${item.label}</a>`;
  }).join('');
}

interface AdminPageOptions {
  title: string;
  activePath: string;
  body: string;
  extraHead?: string;
  extraScripts?: string;
}

export function renderAdminPage(opts: AdminPageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.title} — Wyre Technology</title>
  ${THEME_BOOTSTRAP}
  ${opts.extraHead ?? ''}
  <style>${ADMIN_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">Wyre Technology · Admin</div>
      <nav class="nav">${renderNav(opts.activePath)}</nav>
    </div>
    ${opts.body}
  </div>
  ${opts.extraScripts ?? ''}
</body>
</html>`;
}
