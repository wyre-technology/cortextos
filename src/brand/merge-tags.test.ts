import { describe, it, expect } from 'vitest';
import { buildBrandMergeTags, resolveTemplateSlug } from './merge-tags.js';
import type { BrandConfig } from './types.js';

// ---------------------------------------------------------------------------
// buildBrandMergeTags — shape + fallback coverage
//
// Sibling-tests to the consentDocumentUrl-XSS escape pattern (WYREAI-98
// #306): the SHAPE is the contract dev's PR-B consumers ride; if any field
// is renamed or removed, every consumer breaks AT COMPILE TIME via the
// BrandMergeTags interface. These tests pin the field-mapping + the
// fallback-chain so the contract is stable across PR-A/PR-B reviews.
// ---------------------------------------------------------------------------

function makeBrand(overrides: Partial<BrandConfig> = {}): BrandConfig {
  return {
    // Required (non-null legacy fields)
    name: 'Acme MSP',
    tagline: 'Local-IT, done right',
    logoUrl: 'https://cdn.acme.example/logo.svg',
    supportUrl: 'https://acme.example/support',
    docsUrl: 'https://acme.example/docs',
    issuesUrl: 'https://acme.example/bugs',
    primaryColor: '#0066ff',
    accentColor: '#00cc88',
    headingFont: 'Inter',
    bodyFont: 'Inter',
    borderRadius: '8px',
    domain: 'acme.example',
    // DB-backed defaults
    tier: 'reseller',
    ...overrides,
  };
}

describe('buildBrandMergeTags', () => {
  it('maps every BrandConfig field to its merge-tag key', () => {
    const brand = makeBrand({
      logoDarkUrl: 'https://cdn.acme.example/logo-dark.svg',
      supportEmail: 'help@acme.example',
      fromEmailDisplayName: 'Acme Support',
    });
    const tags = buildBrandMergeTags(brand);

    expect(tags.brand_name).toBe('Acme MSP');
    expect(tags.brand_tagline).toBe('Local-IT, done right');
    expect(tags.brand_logo_url).toBe('https://cdn.acme.example/logo.svg');
    expect(tags.brand_logo_dark_url).toBe('https://cdn.acme.example/logo-dark.svg');
    expect(tags.brand_support_url).toBe('https://acme.example/support');
    expect(tags.brand_support_contact_email).toBe('help@acme.example');
    expect(tags.brand_docs_url).toBe('https://acme.example/docs');
    expect(tags.brand_from_display_name).toBe('Acme Support');
    expect(tags.brand_accent_color).toBe('#00cc88');
    expect(tags.brand_primary_color).toBe('#0066ff');
    expect(tags.brand_tier).toBe('reseller');
  });

  it('brand_logo_dark_url falls back to brand_logo_url when no dark variant', () => {
    const brand = makeBrand({ logoDarkUrl: null });
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_logo_dark_url).toBe(brand.logoUrl);
  });

  it('brand_logo_dark_url falls back to brand_logo_url when undefined', () => {
    // Distinct from null per the optional-field shape on BrandConfig
    const brand = makeBrand();
    delete brand.logoDarkUrl;
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_logo_dark_url).toBe(brand.logoUrl);
  });

  it('brand_support_contact_email falls back to brand_support_url when no email', () => {
    const brand = makeBrand({ supportEmail: null });
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_support_contact_email).toBe(brand.supportUrl);
  });

  it('brand_from_display_name falls back to brand_name when no from-display-name', () => {
    const brand = makeBrand({ fromEmailDisplayName: null });
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_from_display_name).toBe(brand.name);
  });

  it('brand_tier defaults to wyre_default when tier is undefined', () => {
    // Defensive: BrandConfig.tier is optional; consumers that need a string
    // for the merge-tag get the wyre_default fallback rather than 'undefined'.
    const brand = makeBrand();
    delete brand.tier;
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_tier).toBe('wyre_default');
  });

  it('does NOT re-escape already-escaped strings (double-escape would mangle the wire)', () => {
    // Brand-resolver escapes at the toBrandConfig boundary; this helper is
    // pure field-mapping. If we double-escaped, '&amp;' would become
    // '&amp;amp;' on the wire and render as the literal '&amp;' to the
    // recipient instead of '&'. Contract pin.
    const brand = makeBrand({ name: 'A&amp;B Tech' }); // already-escaped form
    const tags = buildBrandMergeTags(brand);
    expect(tags.brand_name).toBe('A&amp;B Tech'); // unchanged — NOT re-escaped
  });

  it('contract stability: shape has exactly the named keys (catches accidental adds)', () => {
    // Regression guard: if a future PR adds a key without updating the
    // BrandMergeTags interface + this test, both the consumer-side
    // TypeScript types AND this assertion fail. Same shape as the
    // discipline-detectable-via-pattern-match pin (N=4 cross-cycle firings
    // banked).
    const brand = makeBrand();
    const tags = buildBrandMergeTags(brand);
    const keys = Object.keys(tags).sort();
    expect(keys).toEqual([
      'brand_accent_color',
      'brand_docs_url',
      'brand_from_display_name',
      'brand_logo_dark_url',
      'brand_logo_url',
      'brand_name',
      'brand_primary_color',
      'brand_support_contact_email',
      'brand_support_url',
      'brand_tagline',
      'brand_tier',
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateSlug — hybrid escape-hatch
//
// Boss-locked HYBRID at msg-1780673136515: default-slug for ~95% of cases
// (no override), per-reseller-override-slug for the ~5% bespoke-copy cases.
// Tests pin both axes + the absent-key fall-through pattern.
// ---------------------------------------------------------------------------

describe('resolveTemplateSlug', () => {
  it('returns the default-slug + isOverride=false when brand has no templateOverrides (~95% case)', () => {
    const brand = makeBrand(); // templateOverrides undefined
    const resolved = resolveTemplateSlug('trial-converted', brand, 'trial-converted-default');
    expect(resolved).toEqual({ slug: 'trial-converted-default', isOverride: false });
  });

  it('returns the default-slug + isOverride=false when templateOverrides is explicitly null', () => {
    const brand = makeBrand({ templateOverrides: null });
    const resolved = resolveTemplateSlug('trial-converted', brand, 'trial-converted-default');
    expect(resolved).toEqual({ slug: 'trial-converted-default', isOverride: false });
  });

  it('returns the default-slug + isOverride=false when override-map is empty', () => {
    const brand = makeBrand({ templateOverrides: {} });
    const resolved = resolveTemplateSlug('trial-converted', brand, 'trial-converted-default');
    expect(resolved).toEqual({ slug: 'trial-converted-default', isOverride: false });
  });

  it('returns the override-slug + isOverride=true when present for the requested event-name', () => {
    const brand = makeBrand({
      templateOverrides: {
        'trial-converted': 'trial-converted-acme',
        'dunning-past-due': 'dunning-past-due-acme',
      },
    });
    expect(resolveTemplateSlug('trial-converted', brand, 'trial-converted-default'))
      .toEqual({ slug: 'trial-converted-acme', isOverride: true });
    expect(resolveTemplateSlug('dunning-past-due', brand, 'dunning-past-due-default'))
      .toEqual({ slug: 'dunning-past-due-acme', isOverride: true });
  });

  it('returns the default-slug + isOverride=false for events absent from the override-map (sparse mapping)', () => {
    // Override-map is sparse — a reseller can override only the events
    // they care about, the rest fall through to defaults. Closes the
    // rot-vector "reseller overrode one event + we silently dropped all
    // other events" — each event-name is resolved independently.
    const brand = makeBrand({
      templateOverrides: { 'trial-converted': 'trial-converted-acme' },
    });
    expect(resolveTemplateSlug('trial-converted', brand, 'default-a'))
      .toEqual({ slug: 'trial-converted-acme', isOverride: true });
    expect(resolveTemplateSlug('member-removed', brand, 'default-b'))
      .toEqual({ slug: 'default-b', isOverride: false });
    expect(resolveTemplateSlug('role-changed', brand, 'default-c'))
      .toEqual({ slug: 'default-c', isOverride: false });
  });

  it('is event-name-string-agnostic — does not narrow to LoopsEventName (PR-B owns the union)', () => {
    // Per architecture-of-record-at-the-artifact: the LoopsEventName union
    // lives at the consumer-site (dev's PR-B src/email/loops.ts), not at
    // this helper. The helper accepts any string; the type-discipline is
    // applied at call-sites where the consumer wraps with the union.
    const brand = makeBrand({
      templateOverrides: { 'arbitrary-event-name-not-in-union': 'override-slug' },
    });
    expect(resolveTemplateSlug('arbitrary-event-name-not-in-union', brand, 'default'))
      .toEqual({ slug: 'override-slug', isOverride: true });
  });

  it('isOverride discriminator lets consumer branch on upstream-Loops-rejection handling (analyst-surfaced contract)', () => {
    // The load-bearing distinction the discriminator enables: consumer
    // at fire-time can distinguish "override declared and Loops rejected
    // → fall through to default + warn" from "default itself rejected →
    // real upstream error, surface". Without the discriminator, the
    // consumer cannot tell whether the slug-in-hand was an override
    // (safe to fall through) or the default (no fallback available).
    // analyst-surfaced 2026-06-05 (msg-1780703922567); contract resolved
    // by adding the explicit boolean rather than richer overrideExists +
    // booleans (only one meaningful distinction at this layer).
    const brandWithOverride = makeBrand({
      templateOverrides: { 'trial-converted': 'override-slug' },
    });
    const brandWithoutOverride = makeBrand({ templateOverrides: null });

    const overrideResult = resolveTemplateSlug('trial-converted', brandWithOverride, 'default-slug');
    const defaultResult = resolveTemplateSlug('trial-converted', brandWithoutOverride, 'default-slug');

    expect(overrideResult.isOverride).toBe(true);
    expect(defaultResult.isOverride).toBe(false);
    // Both return a slug — the discriminator is the consumer's branch-point,
    // not a presence/absence signal.
    expect(typeof overrideResult.slug).toBe('string');
    expect(typeof defaultResult.slug).toBe('string');
  });

  it('pure data-lookup — no upstream-existence-check (resolver does NOT validate slug against Loops)', () => {
    // Pinning the layering decision: resolveTemplateSlug returns whatever
    // value lives at templateOverrides[eventName], even if it's a typo /
    // deleted-from-Loops / nonsense string. Existence-validation is
    // UPSTREAM at the consumer's fire-time try/catch — pushing it there
    // keeps the resolver cheap + lets each fire-site pick fall-through-
    // vs-error per its cost-of-skip semantics. Contract-shape pin.
    const brand = makeBrand({
      templateOverrides: { 'trial-converted': 'this-slug-does-not-exist-in-loops' },
    });
    const resolved = resolveTemplateSlug('trial-converted', brand, 'default-slug');
    expect(resolved.slug).toBe('this-slug-does-not-exist-in-loops');
    expect(resolved.isOverride).toBe(true);
    // Consumer is responsible for try/catch on the Loops fire; resolver
    // returns the value verbatim.
  });
});
