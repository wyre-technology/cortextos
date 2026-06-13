// =============================================================================
// src/brand/merge-tags.ts
//
// RC2 PR-A — single-source merge-tag-payload shape for Loops + transactional
// email fire-sites (15+ consumers per boss msg-1780673136515 enumeration).
// Dev's PR-B will import this from every fire-site so all 15+ surfaces emit
// the SAME merge-tag keys against the SAME field-mapping. Avoids per-site
// drift on which BrandConfig fields map to which Loops template variable.
//
// ARCHITECTURE-OF-RECORD: the merge-tag payload-shape lives at this single
// site; consumers ride it. New merge-tag additions land here once + propagate
// to every consumer by-construction (no per-site edits). Same shape as the
// canonical-pattern-as-construction-form discipline.
//
// ESCAPE-BOUNDARY DISCIPLINE: every string field on BrandConfig is already
// HTML-escaped at the brand-resolver's toBrandConfig boundary (see
// src/brand/resolver.ts escapeHtmlString docstring). This helper is a PURE
// FIELD-NAME REMAP — it does NOT escape again (double-escape would mangle
// the values; the resolver-boundary is the single defense point). If a
// consumer EVER needs raw unescaped values, they must fetch from
// brand_profiles directly, NOT through this helper.
// =============================================================================

import type { BrandConfig } from './types.js';

/**
 * Merge-tag payload shape consumed by Loops events + transactional emails.
 * Stringly-typed at the wire because Loops's merge-tag API accepts strings;
 * the BrandConfig-field-to-merge-tag-key mapping is the single source of
 * truth for which {{brand_*}} interpolations are available across all 15+
 * fire-sites.
 *
 * Field naming convention: `brand_<snake_case_field>`. Matches the merge-tag
 * shape Loops templates use ({{brand_name}}, {{brand_logo_url}}, etc.).
 *
 * Defensive fallbacks for the few nullable fields:
 * - brand_logo_dark_url defaults to brand_logo_url (light-mode logo) when
 *   the brand has no explicit dark variant — most resellers won't have
 *   uploaded a dark logo; Loops should still render something.
 * - brand_support_contact_email falls back to brand_support_url because
 *   some brands publish only a URL (a contact-form page) not an email.
 * - brand_from_display_name falls back to brand_name when the brand hasn't
 *   set a custom from-line — matches the existing email-sending convention.
 */
export interface BrandMergeTags {
  /** Display name of the brand. From BrandConfig.name. */
  brand_name: string;
  /** Tagline / short subtitle. From BrandConfig.tagline. */
  brand_tagline: string;
  /** Light-mode logo URL (always present; defaults to '' if brand has none). */
  brand_logo_url: string;
  /** Dark-mode logo URL; falls back to brand_logo_url. */
  brand_logo_dark_url: string;
  /** Support URL (help center, contact page). From BrandConfig.supportUrl. */
  brand_support_url: string;
  /** Support contact email; falls back to brand_support_url. */
  brand_support_contact_email: string;
  /** Docs URL. From BrandConfig.docsUrl. */
  brand_docs_url: string;
  /** Display-name used as the "From" line in emails; falls back to brand_name. */
  brand_from_display_name: string;
  /** Primary brand accent color (hex). From BrandConfig.accentColor. */
  brand_accent_color: string;
  /** Primary brand color (hex). From BrandConfig.primaryColor. */
  brand_primary_color: string;
  /** Brand tier in the inheritance model. Useful for tier-aware copy. */
  brand_tier: 'wyre_default' | 'reseller' | 'customer';
}

/**
 * Build the merge-tag payload from a BrandConfig. Use this from EVERY Loops
 * event-fire + transactional-email send-site that needs brand-aware output.
 *
 * Inputs are presumed HTML-escaped (BrandConfig is escaped at the resolver
 * boundary per src/brand/resolver.ts escapeHtmlString). DO NOT re-escape
 * here — double-escape would render `&amp;amp;` to the recipient.
 *
 * Defensive fallbacks for fields with null/undefined values per BrandMergeTags
 * docstring; the contract guarantees a string for every key so Loops never
 * sees `undefined` (which would render as the literal merge-tag e.g.
 * `{{brand_logo_dark_url}}`).
 */
export function buildBrandMergeTags(brand: BrandConfig): BrandMergeTags {
  return {
    brand_name: brand.name,
    brand_tagline: brand.tagline,
    brand_logo_url: brand.logoUrl,
    // Dark logo defaults to light logo (rationale in BrandMergeTags docstring).
    brand_logo_dark_url: brand.logoDarkUrl ?? brand.logoUrl,
    brand_support_url: brand.supportUrl,
    // Support contact: prefer explicit email, fall back to URL.
    brand_support_contact_email: brand.supportEmail ?? brand.supportUrl,
    brand_docs_url: brand.docsUrl,
    // From display name: prefer explicit, fall back to brand name.
    brand_from_display_name: brand.fromEmailDisplayName ?? brand.name,
    brand_accent_color: brand.accentColor,
    brand_primary_color: brand.primaryColor,
    brand_tier: brand.tier ?? 'wyre_default',
  };
}

/**
 * Result of resolveTemplateSlug — carries the resolved slug PLUS the
 * `isOverride` discriminator so the consumer can distinguish "override
 * declared and applied" from "default applied" at fire-time.
 *
 * Analyst-surfaced 2026-06-05 (msg-1780703922567): consumers need this
 * discriminator to decide upstream-Loops-rejection handling per fire-site.
 * If an OVERRIDE slug is rejected by Loops (slug typo / deleted / etc.),
 * the consumer can fall through to the default-slug + warn-log. If the
 * DEFAULT slug is rejected, that's a real upstream error and should
 * surface, not silently fall back to nothing. Same shape as the cheap-
 * detector + load-bearing-decider paired roles pin — `isOverride` is the
 * cheap-detector for "which slug is this?"; the consumer's try/catch on
 * the Loops API result is the load-bearing decision-source for "did it
 * work?" Existence-check is UPSTREAM (Loops API), not resolver-side —
 * the resolver does a pure data-lookup with zero remote calls.
 */
export interface ResolvedTemplateSlug {
  /** The slug to attempt firing — override if declared, default otherwise. */
  slug: string;
  /**
   * TRUE when the slug came from brand.templateOverrides[eventName].
   * FALSE when the override was absent + the supplied defaultSlug was used.
   * Lets the consumer branch its upstream-Loops-rejection handling:
   *   - isOverride=true + Loops-not-found → fall through to default + warn
   *   - isOverride=false + Loops-not-found → real upstream error, surface
   */
  isOverride: boolean;
}

/**
 * Resolve the Loops event-slug for an event-name on a given brand. Honors
 * the brand's template_overrides JSONB (mig 045) if present — otherwise
 * returns the supplied default-slug.
 *
 * Boss-locked HYBRID strategy at msg-1780673136515: single-slug-with-merge-
 * tags is the DEFAULT path (~95% of resellers); per-reseller-slug-override
 * is the OPT-IN ESCAPE-HATCH. This helper centralizes the override-lookup
 * so every fire-site composes the lookup the same way.
 *
 * Usage (from dev's PR-B fire-sites):
 *   const resolved = resolveTemplateSlug('trial-converted', brand,
 *                                        DEFAULT_SLUGS['trial-converted']);
 *   try {
 *     await loops.send({ slug: resolved.slug, properties: buildBrandMergeTags(brand) });
 *   } catch (err) {
 *     if (isLoopsSlugNotFoundError(err) && resolved.isOverride) {
 *       // Override slug missing upstream — fall through to default + warn.
 *       log.warn({ orgId, eventName, badOverride: resolved.slug },
 *                'override slug not found in Loops, falling through to default');
 *       await loops.send({ slug: DEFAULT_SLUGS['trial-converted'], properties: tags });
 *     } else {
 *       throw err; // default slug also missing = real upstream error, surface
 *     }
 *   }
 *
 * Existence-check semantics: resolveTemplateSlug performs a PURE DATA
 * LOOKUP against the BrandConfig.templateOverrides Record. It has NO
 * knowledge of which slugs exist in Loops upstream — that's an API-time
 * concern handled by the consumer's try/catch around the Loops fire.
 * Layering rationale: the resolver doesn't make remote calls + can't
 * stale-detect deleted slugs; pushing existence-validation to the
 * consumer fire-site keeps the resolver cheap + lets each fire-site
 * pick (a) fall-through-to-default vs (b) error-and-skip per its
 * cost-of-skip-vs-wrong-template trade-off.
 *
 * The eventName string is intentionally NOT narrowed to LoopsEventName here
 * — dev's PR-B owns the LoopsEventName union + the DEFAULT_SLUGS map at
 * src/email/loops.ts (consumer-discipline lives at the consumer-site per
 * architecture-of-record-at-the-artifact). This helper accepts any string
 * to keep PR-A consumer-agnostic.
 */
export function resolveTemplateSlug(
  eventName: string,
  brand: BrandConfig,
  defaultSlug: string,
): ResolvedTemplateSlug {
  const override = brand.templateOverrides?.[eventName];
  if (override !== undefined) {
    return { slug: override, isOverride: true };
  }
  return { slug: defaultSlug, isOverride: false };
}
