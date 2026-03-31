/**
 * Login page HTML generator
 *
 * Renders a clean, centered login card with provider-specific sign-in
 * buttons. The button shown depends on the AUTH_PROVIDER config value.
 */

import { brand } from '../brand/index.js';
import { config } from '../config.js';

export function renderLoginPage(): string {
  const showAzure = config.authProvider === 'azure-ad';
  const showAuth0 = config.authProvider === 'auth0';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In &mdash; ${brand.name} MCP Gateway</title>
  <link rel="icon" href="${brand.logoUrl}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600&family=Nunito+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Nunito Sans', sans-serif;
      color: #333333;
      background: #F5F5F5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .login-card {
      background: #FFFFFF;
      border-radius: 2px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      padding: 48px 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .login-card__logo {
      width: 64px;
      height: 64px;
      border-radius: 2px;
      margin: 0 auto 24px;
      object-fit: contain;
    }
    .login-card__heading {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 1.5rem;
      margin-bottom: 8px;
      color: #333;
    }
    .login-card__sub {
      font-size: 0.95rem;
      color: #666;
      margin-bottom: 32px;
    }
    .login-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      padding: 14px 24px;
      border: none;
      border-radius: 2px;
      font-family: 'Nunito Sans', sans-serif;
      font-weight: 700;
      font-size: 1rem;
      cursor: pointer;
      text-decoration: none;
      transition: opacity 0.2s, transform 0.2s;
      margin-bottom: 12px;
    }
    .login-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .login-btn:last-child { margin-bottom: 0; }
    .login-btn--microsoft {
      background: #2F2F2F;
      color: #FFFFFF;
    }
    .login-btn--auth0 {
      background: #EDE947;
      color: #333333;
    }
    .login-btn__icon {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
    }
    .login-card__back {
      display: inline-block;
      margin-top: 24px;
      font-size: 0.85rem;
      color: #00C9DB;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <img src="https://wyretechnology.com/wp-content/uploads/2018/02/WYRE-Square-web.webp"
         alt="${brand.name} logo"
         class="login-card__logo" />
    <h1 class="login-card__heading">Sign in to MCP Gateway</h1>
    <p class="login-card__sub">Securely access your AI-powered IT operations hub.</p>

    ${showAzure ? `
    <a href="/auth/login" class="login-btn login-btn--microsoft">
      <svg class="login-btn__icon" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
        <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
      </svg>
      Sign in with Microsoft
    </a>` : ''}

    ${showAuth0 ? `
    <a href="/auth/login" class="login-btn login-btn--auth0">
      Sign in with Auth0
    </a>` : ''}

    <a href="/" class="login-card__back">&larr; Back to home</a>
  </div>
</body>
</html>`;
}
