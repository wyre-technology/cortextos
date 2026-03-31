/**
 * Landing page HTML generator
 *
 * Returns a complete, self-contained HTML string for the public-facing
 * WYRE MCP Gateway landing page. All CSS is inline (no external stylesheets
 * beyond Google Fonts). No JS frameworks — only CSS animations.
 */

import { brand } from '../brand/index.js';

export function renderLandingPage(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brand.name} — ${brand.tagline}</title>
  <meta name="description" content="${brand.tagline}" />
  <link rel="icon" href="${brand.logoUrl}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Nunito+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    /* ------------------------------------------------------------------ */
    /* Reset & base                                                       */
    /* ------------------------------------------------------------------ */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Nunito Sans', sans-serif;
      color: #333333;
      background: #FFFFFF;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    a { color: #00C9DB; text-decoration: none; transition: opacity 0.2s; }
    a:hover { opacity: 0.8; }
    img { max-width: 100%; display: block; }

    /* ------------------------------------------------------------------ */
    /* Layout helpers                                                      */
    /* ------------------------------------------------------------------ */
    .container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
    .section { padding: 80px 0; }

    /* ------------------------------------------------------------------ */
    /* Scroll-reveal animation (CSS only)                                  */
    /* ------------------------------------------------------------------ */
    .reveal {
      opacity: 0;
      transform: translateY(24px);
      animation: revealUp 0.6s ease forwards;
    }
    .reveal-d1 { animation-delay: 0.1s; }
    .reveal-d2 { animation-delay: 0.2s; }
    .reveal-d3 { animation-delay: 0.3s; }
    .reveal-d4 { animation-delay: 0.4s; }
    @keyframes revealUp {
      to { opacity: 1; transform: translateY(0); }
    }

    /* ------------------------------------------------------------------ */
    /* Header                                                              */
    /* ------------------------------------------------------------------ */
    .site-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      max-width: 1120px;
      margin: 0 auto;
    }
    .site-header__brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .site-header__logo {
      height: 40px;
      width: 40px;
      border-radius: 2px;
      object-fit: contain;
    }
    .site-header__title {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 1.25rem;
      color: #333333;
    }
    .site-header__nav {
      display: flex;
      align-items: center;
      gap: 28px;
      list-style: none;
    }
    .site-header__nav a {
      font-weight: 600;
      font-size: 0.95rem;
      color: #333333;
    }
    .site-header__nav a:hover { color: #00C9DB; }
    .site-header__nav .btn-signin {
      background: #EDE947;
      color: #333333;
      padding: 8px 20px;
      border-radius: 2px;
      font-weight: 700;
    }
    .site-header__nav .btn-signin:hover { opacity: 0.85; }

    /* Mobile nav toggle */
    .nav-toggle { display: none; background: none; border: none; cursor: pointer; }
    .nav-toggle span {
      display: block; width: 24px; height: 2px; background: #333;
      margin: 5px 0; transition: 0.3s;
    }

    @media (max-width: 768px) {
      .nav-toggle { display: block; }
      .site-header__nav {
        display: none;
        flex-direction: column;
        position: absolute;
        top: 64px;
        right: 24px;
        background: #fff;
        border: 1px solid #eee;
        border-radius: 2px;
        padding: 16px 24px;
        gap: 16px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.08);
        z-index: 100;
      }
      .site-header__nav.open { display: flex; }
      .site-header { position: relative; }
    }

    /* ------------------------------------------------------------------ */
    /* Hero                                                                */
    /* ------------------------------------------------------------------ */
    .hero {
      text-align: center;
      padding: 100px 24px 80px;
    }
    .hero__headline {
      font-family: 'Oswald', sans-serif;
      font-weight: 700;
      font-size: clamp(2rem, 5vw, 3.25rem);
      color: #333333;
      margin-bottom: 16px;
    }
    .hero__subtitle {
      font-size: 1.15rem;
      color: #555;
      max-width: 620px;
      margin: 0 auto 36px;
    }
    .hero__ctas {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      border-radius: 2px;
      font-weight: 700;
      font-size: 1rem;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.2s;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn--primary {
      background: #EDE947;
      color: #333333;
    }
    .btn--outline {
      background: transparent;
      border: 2px solid #00C9DB;
      color: #00C9DB;
    }

    /* ------------------------------------------------------------------ */
    /* Features                                                            */
    /* ------------------------------------------------------------------ */
    .features { background: #FAFAFA; }
    .features__heading {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 2rem;
      text-align: center;
      margin-bottom: 48px;
      color: #00C9DB;
    }
    .features__grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 32px;
    }
    .feature-card {
      background: #FFFFFF;
      border: 1px solid #eee;
      border-radius: 2px;
      padding: 32px 24px;
      transition: box-shadow 0.3s;
    }
    .feature-card:hover {
      box-shadow: 0 6px 24px rgba(0,0,0,0.06);
    }
    .feature-card__icon {
      width: 48px;
      height: 48px;
      background: #EDE947;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      margin-bottom: 16px;
    }
    .feature-card__title {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 1.15rem;
      margin-bottom: 8px;
      color: #333;
    }
    .feature-card__desc {
      font-size: 0.95rem;
      color: #555;
    }

    /* ------------------------------------------------------------------ */
    /* How It Works                                                        */
    /* ------------------------------------------------------------------ */
    .how__heading {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 2rem;
      text-align: center;
      margin-bottom: 48px;
      color: #00C9DB;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 32px;
      counter-reset: step;
    }
    .step {
      text-align: center;
      counter-increment: step;
    }
    .step__number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #EDE947;
      font-family: 'Oswald', sans-serif;
      font-weight: 700;
      font-size: 1.25rem;
      color: #333;
      margin-bottom: 16px;
    }
    .step__title {
      font-family: 'Oswald', sans-serif;
      font-weight: 600;
      font-size: 1.05rem;
      margin-bottom: 8px;
      color: #333;
    }
    .step__desc {
      font-size: 0.9rem;
      color: #555;
    }

    /* ------------------------------------------------------------------ */
    /* Footer                                                              */
    /* ------------------------------------------------------------------ */
    .site-footer {
      background: #333333;
      color: #ccc;
      padding: 40px 24px;
    }
    .site-footer__inner {
      max-width: 1120px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .site-footer__copy {
      font-size: 0.85rem;
    }
    .site-footer__links {
      display: flex;
      gap: 20px;
      list-style: none;
    }
    .site-footer__links a { color: #ccc; font-size: 0.85rem; }
    .site-footer__links a:hover { color: #EDE947; }
    .site-footer__social a {
      color: #ccc;
      font-size: 0.85rem;
    }
    .site-footer__social a:hover { color: #00C9DB; }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="site-header">
    <a href="/" class="site-header__brand">
      <img src="https://wyretechnology.com/wp-content/uploads/2018/02/WYRE-Square-web.webp"
           alt="${brand.name} logo"
           class="site-header__logo" />
      <span class="site-header__title">MCP Gateway</span>
    </a>

    <button class="nav-toggle" aria-label="Toggle navigation"
            onclick="document.querySelector('.site-header__nav').classList.toggle('open')">
      <span></span><span></span><span></span>
    </button>

    <nav>
      <ul class="site-header__nav">
        <li><a href="#features">Features</a></li>
        <li><a href="#how-it-works">How It Works</a></li>
        <li><a href="${brand.docsUrl}">Docs</a></li>
        <li><a href="/auth/login" class="btn-signin">Sign In</a></li>
      </ul>
    </nav>
  </header>

  <!-- Hero -->
  <section class="hero">
    <div class="container">
      <h1 class="hero__headline reveal">Your AI-Powered IT Operations Hub</h1>
      <p class="hero__subtitle reveal reveal-d1">
        Connect your MSP tools to AI agents securely.
        One gateway, every vendor, zero complexity.
      </p>
      <div class="hero__ctas reveal reveal-d2">
        <a href="/auth/login" class="btn btn--primary">Get Started</a>
        <a href="#features" class="btn btn--outline">Learn More</a>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section id="features" class="section features">
    <div class="container">
      <h2 class="features__heading reveal">Why MCP Gateway?</h2>
      <div class="features__grid">
        <div class="feature-card reveal reveal-d1">
          <div class="feature-card__icon">&#128274;</div>
          <h3 class="feature-card__title">Secure MCP Proxy</h3>
          <p class="feature-card__desc">Route AI agent requests through authenticated, audited connections. Every call is logged and traceable.</p>
        </div>
        <div class="feature-card reveal reveal-d2">
          <div class="feature-card__icon">&#128279;</div>
          <h3 class="feature-card__title">Multi-Vendor</h3>
          <p class="feature-card__desc">Connect Autotask, IT Glue, Datto RMM, Pax8, and more from one platform. No per-vendor setup headaches.</p>
        </div>
        <div class="feature-card reveal reveal-d3">
          <div class="feature-card__icon">&#128101;</div>
          <h3 class="feature-card__title">Team Management</h3>
          <p class="feature-card__desc">Role-based access, API keys, and usage billing per organization. Control who accesses what.</p>
        </div>
        <div class="feature-card reveal reveal-d4">
          <div class="feature-card__icon">&#127912;</div>
          <h3 class="feature-card__title">White-Label Ready</h3>
          <p class="feature-card__desc">Your brand, your domain, your customers' trust. Fully customizable for your MSP practice.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section id="how-it-works" class="section">
    <div class="container">
      <h2 class="how__heading reveal">How It Works</h2>
      <div class="steps">
        <div class="step reveal reveal-d1">
          <div class="step__number">1</div>
          <h3 class="step__title">Sign Up</h3>
          <p class="step__desc">Create your account and set up your organization in under a minute.</p>
        </div>
        <div class="step reveal reveal-d2">
          <div class="step__number">2</div>
          <h3 class="step__title">Connect Vendors</h3>
          <p class="step__desc">Add your vendor credentials &mdash; Autotask, IT Glue, Datto RMM, and more.</p>
        </div>
        <div class="step reveal reveal-d3">
          <div class="step__number">3</div>
          <h3 class="step__title">Configure Your AI</h3>
          <p class="step__desc">Point your AI agent (Claude, etc.) at your MCP Gateway server URL.</p>
        </div>
        <div class="step reveal reveal-d4">
          <div class="step__number">4</div>
          <h3 class="step__title">Go Live</h3>
          <p class="step__desc">Your AI agent securely accesses your MSP tools through the gateway. Done.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="site-footer">
    <div class="site-footer__inner">
      <div class="site-footer__copy">
        &copy; ${new Date().getFullYear()} ${brand.name}. All rights reserved.
      </div>
      <ul class="site-footer__links">
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
        <li><a href="${brand.supportUrl || '/support'}">Support</a></li>
      </ul>
      <div class="site-footer__social">
        <a href="https://facebook.com/WYRETech" target="_blank" rel="noopener noreferrer">Facebook</a>
      </div>
    </div>
  </footer>

</body>
</html>`;
}
