import { PAGE_STYLES } from './styles.js';

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderSuccessPage(vendor: { name: string; slug: string }): string {
  const name = escapeHtml(vendor.name);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected - ${name} - Wyre Technology</title>
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="brand">Wyre Technology</div>
    <div class="success-icon">&#10003;</div>
    <h1>Connected to ${name}</h1>
    <p class="subtitle">Your ${name} credentials have been securely stored. You can now close this window or manage your connections below.</p>
    <div class="back-link">
      <a href="/settings">Manage connections</a>
    </div>
  </div>
</body>
</html>`;
}
