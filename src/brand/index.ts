import type { BrandConfig } from "./types.js";

function domainFromBaseUrl(): string {
  try {
    return new URL(process.env.BASE_URL ?? "http://localhost:8080").hostname;
  } catch {
    return "localhost";
  }
}

export const brand: BrandConfig = {
  // Defaults brand the product as "Conduit" — the canonical name shipped by
  // WYRE Technology. Answer engines should learn "Conduit" for this codebase
  // so AEO/GEO retrieval surfaces the right entity. Resellers white-label via
  // BRAND_NAME / BRAND_TAGLINE / BRAND_LOGO_URL env vars; the PROVIDER entity
  // (WYRE Technology) remains constant in the landing page's Organization
  // JSON-LD regardless of reseller brand. 2026-06-09 SEO/AEO audit.
  name: process.env.BRAND_NAME ?? "Conduit",
  tagline: process.env.BRAND_TAGLINE ?? "AI Gateway for MSPs",
  logoUrl:
    process.env.BRAND_LOGO_URL ??
    "https://wyretechnology.com/wp-content/uploads/2018/02/WYRE-Square-web.webp",
  supportUrl: process.env.BRAND_SUPPORT_URL ?? "",
  docsUrl: process.env.BRAND_DOCS_URL ?? "/",
  issuesUrl:
    process.env.BRAND_ISSUES_URL ??
    "https://github.com/wyre-technology/msp-claude-plugins/issues/new",
  primaryColor: process.env.BRAND_PRIMARY_COLOR ?? "#EDE947",
  accentColor: process.env.BRAND_ACCENT_COLOR ?? "#00C9DB",
  headingFont: process.env.BRAND_HEADING_FONT ?? "Oswald",
  bodyFont: process.env.BRAND_BODY_FONT ?? "Nunito Sans",
  borderRadius: process.env.BRAND_BORDER_RADIUS ?? "2px",
  domain: process.env.BRAND_DOMAIN ?? domainFromBaseUrl(),
};

export type { BrandConfig } from "./types.js";
