/**
 * Landing page HTML generator
 *
 * Returns a complete, self-contained HTML string for the public-facing
 * landing page. All CSS is inline (no external stylesheets beyond Google
 * Fonts). No JS frameworks — only CSS animations.
 *
 * Accepts an optional BrandConfig + pathPrefix for customer-branded pages.
 */

import { brand } from "../brand/index.js";
import type { BrandConfig } from "../brand/types.js";
import { escapeHtml } from "../web/helpers.js";

/**
 * Extract bare font family names from a CSS font-family string so we can
 * build a Google Fonts URL.  E.g. "'Prompt', Arial, sans-serif" -> ["Prompt"]
 */
function googleFontFamilies(cfg: BrandConfig): string[] {
  const raw = [cfg.headingFont, cfg.bodyFont];
  const families = new Set<string>();
  for (const value of raw) {
    const first = value.split(",")[0].trim().replace(/'/g, "");
    if (
      ![
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "system-ui",
      ].includes(first.toLowerCase())
    ) {
      families.add(first);
    }
  }
  return [...families];
}

function googleFontsLink(cfg: BrandConfig): string {
  const families = googleFontFamilies(cfg);
  if (families.length === 0) return "";
  const params = families
    .map((f) => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`)
    .join("&");
  return `<link href="https://fonts.googleapis.com/css2?${params}&display=swap" rel="stylesheet" />`;
}

export function renderLandingPage(
  overrideBrand?: BrandConfig,
  pathPrefix?: string,
): string {
  const b = overrideBrand ?? brand;
  const isCustomer = !!overrideBrand;
  // The non-customer Sign In button targets the provider chooser at /login,
  // not /auth/login (the Auth0 direct entrypoint). The chooser short-
  // circuits to the single provider's login URL when only one provider is
  // configured (see landingRoutes /login handler), so single-provider
  // deployments don't see a pointless one-button "chooser." Customer-
  // branded pages already use ${prefix}/login.
  const loginPath = isCustomer ? `${pathPrefix}/login` : "/login";
  const homePath = pathPrefix || "/";
  const heroHeadline = isCustomer
    ? "Your AI-Powered Operations Hub"
    : "Your AI-Powered Operations Hub";
  const heroSubtitle =
    "Connect all your tools to AI agents securely. One gateway, zero complexity.";

  // SEO + AEO/GEO metadata. Renders only on the non-customer (default)
  // landing — reseller-white-labeled pages keep their own entity surface.
  // Matches the schema shape of the Astro marketing site at conduit.wyre.ai
  // (wyre-ai-site/src/pages/conduit/index.astro) so that when the cutover
  // from Astro-marketing to this Fastify app happens, the Organization +
  // SoftwareApplication entities answer engines have learned stay stable.
  // 2026-06-09 SEO/AEO/GEO audit.
  const canonicalUrl = process.env.BASE_URL ?? "https://conduit.wyre.ai";
  const ogImage =
    process.env.BRAND_OG_IMAGE ?? `${canonicalUrl}/assets/og-conduit.png`;
  const seoTitle = `${b.name} — ${b.tagline}`;
  const seoHead = isCustomer
    ? ""
    : `
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:title" content="${escapeHtml(seoTitle)}" />
  <meta property="og:description" content="${escapeHtml(b.tagline)}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:site_name" content="WYRE Technology" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(seoTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(b.tagline)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "WYRE Technology",
    url: "https://wyre.ai",
    logo: "https://wyre.ai/assets/wyre-logo.svg",
    sameAs: [
      "https://conduit.wyre.ai",
      "https://mcp.wyre.ai",
      "https://wyretechnology.com",
      "https://www.linkedin.com/company/wyre-technology",
      "https://github.com/wyre-technology",
      "https://facebook.com/WYRETech",
    ],
  })}</script>
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: seoTitle,
    description: b.tagline,
    url: canonicalUrl,
    about: {
      "@type": "SoftwareApplication",
      name: "Conduit",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description:
        "AI gateway for managed service providers. Visibility and control over every AI action across the MSP's tool stack, with white-label resale to clients.",
      provider: {
        "@type": "Organization",
        name: "WYRE Technology",
        url: "https://wyre.ai",
      },
    },
  })}</script>
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is Conduit?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Conduit is a Model Context Protocol (MCP) gateway for managed service providers. It gives MSP owners full visibility into every AI action their team takes, control over every connection to vendor tools, and confidence that client data stays where it belongs.",
        },
      },
      {
        "@type": "Question",
        name: "Who is Conduit for?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "MSPs and their clients. Conduit ships as a multi-tenant SaaS where MSP owners onboard their team, white-label the experience for downstream customers, and resell MCP-powered AI access to those customers under their own brand.",
        },
      },
      {
        "@type": "Question",
        name: "How does Conduit relate to the WYRE MCP Gateway?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Conduit is WYRE Technology’s hosted MCP gateway product. The WYRE MCP Gateway open-source project (mcp.wyre.ai) is the same technology offered as a self-hosted Claude Code plugin for solo operators; Conduit is the managed multi-tenant SaaS for MSPs that need user-level visibility, audit, and white-label resale.",
        },
      },
    ],
  })}</script>`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${b.name} — ${b.tagline}</title>
  <meta name="description" content="${b.tagline}" />
  <link rel="icon" href="${b.logoUrl}" />${seoHead}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  ${googleFontsLink(b)}
  <style>
    /* ------------------------------------------------------------------ */
    /* Reset & base                                                       */
    /* ------------------------------------------------------------------ */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: ${b.bodyFont};
      color: #333333;
      background: #FFFFFF;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    a { color: ${b.accentColor}; text-decoration: none; transition: opacity 0.2s; }
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
      border-radius: ${b.borderRadius};
      object-fit: contain;
    }
    .site-header__title {
      font-family: ${b.headingFont};
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
    .site-header__nav a:hover { color: ${b.accentColor}; }
    .site-header__nav .btn-signin {
      background: ${b.primaryColor};
      color: #FFFFFF;
      padding: 8px 20px;
      border-radius: ${b.borderRadius};
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
        border-radius: ${b.borderRadius};
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
      font-family: ${b.headingFont};
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
      border-radius: ${b.borderRadius};
      font-weight: 700;
      font-size: 1rem;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.2s;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn--primary {
      background: ${b.primaryColor};
      color: #FFFFFF;
    }
    .btn--outline {
      background: transparent;
      border: 2px solid ${b.accentColor};
      color: ${b.accentColor};
    }

    /* ------------------------------------------------------------------ */
    /* Features                                                            */
    /* ------------------------------------------------------------------ */
    .features { background: #FAFAFA; }
    .features__heading {
      font-family: ${b.headingFont};
      font-weight: 600;
      font-size: 2rem;
      text-align: center;
      margin-bottom: 48px;
      color: ${b.accentColor};
    }
    .features__grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 32px;
    }
    .feature-card {
      background: #FFFFFF;
      border: 1px solid #eee;
      border-radius: ${b.borderRadius};
      padding: 32px 24px;
      transition: box-shadow 0.3s;
    }
    .feature-card:hover {
      box-shadow: 0 6px 24px rgba(0,0,0,0.06);
    }
    .feature-card__icon {
      width: 48px;
      height: 48px;
      background: ${b.accentColor};
      border-radius: ${b.borderRadius};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      margin-bottom: 16px;
    }
    .feature-card__title {
      font-family: ${b.headingFont};
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
      font-family: ${b.headingFont};
      font-weight: 600;
      font-size: 2rem;
      text-align: center;
      margin-bottom: 48px;
      color: ${b.accentColor};
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
      background: ${b.accentColor};
      font-family: ${b.headingFont};
      font-weight: 700;
      font-size: 1.25rem;
      color: #fff;
      margin-bottom: 16px;
    }
    .step__title {
      font-family: ${b.headingFont};
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
    .site-footer__links a:hover { color: ${b.primaryColor}; }
    .site-footer__social a {
      color: #ccc;
      font-size: 0.85rem;
    }
    .site-footer__social a:hover { color: ${b.accentColor}; }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="site-header">
    <a href="${homePath}" class="site-header__brand">
      <img src="${b.logoUrl}"
           alt="${b.name} logo"
           class="site-header__logo" />
      <span class="site-header__title">Connect</span>
    </a>

    <button class="nav-toggle" aria-label="Toggle navigation"
            onclick="document.querySelector('.site-header__nav').classList.toggle('open')">
      <span></span><span></span><span></span>
    </button>

    <nav>
      <ul class="site-header__nav">
        <li><a href="#features">Features</a></li>
        <li><a href="#how-it-works">How It Works</a></li>
        <li><a href="${b.docsUrl}">Docs</a></li>
        <li><a href="${loginPath}" class="btn-signin">Sign In</a></li>
      </ul>
    </nav>
  </header>

  <!-- Hero -->
  <section class="hero">
    <div class="container">
      <h1 class="hero__headline reveal">${heroHeadline}</h1>
      <p class="hero__subtitle reveal reveal-d1">
        ${heroSubtitle}
      </p>
      <div class="hero__ctas reveal reveal-d2">
        <a href="${loginPath}" class="btn btn--primary">Get Started</a>
        <a href="#features" class="btn btn--outline">Learn More</a>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section id="features" class="section features">
    <div class="container">
      <h2 class="features__heading reveal">Why Connect?</h2>
      <div class="features__grid">
        <div class="feature-card reveal reveal-d1">
          <div class="feature-card__icon">&#128274;</div>
          <h3 class="feature-card__title">Secure Connections</h3>
          <p class="feature-card__desc">Route AI agent requests through authenticated, audited connections. Every call is logged and traceable.</p>
        </div>
        <div class="feature-card reveal reveal-d2">
          <div class="feature-card__icon">&#128279;</div>
          <h3 class="feature-card__title">All Your Tools</h3>
          <p class="feature-card__desc">Connect all the tools your team already uses from one platform. No per-tool setup headaches.</p>
        </div>
        <div class="feature-card reveal reveal-d3">
          <div class="feature-card__icon">&#128101;</div>
          <h3 class="feature-card__title">Team Management</h3>
          <p class="feature-card__desc">Role-based access, API keys, and usage tracking per organization. Control who accesses what.</p>
        </div>
        <div class="feature-card reveal reveal-d4">
          <div class="feature-card__icon">&#127912;</div>
          <h3 class="feature-card__title">Your Brand</h3>
          <p class="feature-card__desc">Your brand, your domain, your team's trust. Fully customizable to match your organization.</p>
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
          <h3 class="step__title">Connect Your Tools</h3>
          <p class="step__desc">Add your credentials for the tools your team uses every day.</p>
        </div>
        <div class="step reveal reveal-d3">
          <div class="step__number">3</div>
          <h3 class="step__title">Configure Your AI</h3>
          <p class="step__desc">Point your AI agent at your Connect server URL.</p>
        </div>
        <div class="step reveal reveal-d4">
          <div class="step__number">4</div>
          <h3 class="step__title">Go Live</h3>
          <p class="step__desc">Your AI agent securely accesses your tools through the gateway. Done.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="site-footer">
    <div class="site-footer__inner">
      <div class="site-footer__copy">
        &copy; ${new Date().getFullYear()} ${b.name}. All rights reserved.
      </div>
      <ul class="site-footer__links">
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
        <li><a href="${b.supportUrl || "/support"}">Support</a></li>
      </ul>
    </div>
  </footer>

</body>
</html>`;
}
