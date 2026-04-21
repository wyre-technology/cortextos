export interface BrandConfig {
  // -------------------------------------------------------------------------
  // Existing fields (env-driven, kept for backwards compatibility with
  // src/brand/index.ts and any caller reading brand config before the
  // FEATURE_DB_BRANDING flag flips on). Do not remove — see PRD §11.
  //
  // Note: PRD §13 / migration 008_brand_profiles.sql model several of these
  // (headingFont, bodyFont, docsUrl, issuesUrl, domain, borderRadius) as
  // nullable in the DB. We preserve the non-null string shape here to keep
  // existing env-only callers compiling; the DB loader in a later task will
  // coalesce null -> sensible default before populating BrandConfig.
  // -------------------------------------------------------------------------

  /** Company or product name displayed in UI */
  name: string;
  /** Short tagline shown in meta descriptions */
  tagline: string;
  /** URL to logo image */
  logoUrl: string;
  /** Support/help URL for customers */
  supportUrl: string;
  /** Documentation URL */
  docsUrl: string;
  /** URL for filing bug reports / feature requests */
  issuesUrl: string;
  /** Primary accent color (hex) */
  primaryColor: string;
  /** Secondary/accent color (hex) */
  accentColor: string;
  /** Heading font family name (Google Fonts) */
  headingFont: string;
  /** Body font family name (Google Fonts) */
  bodyFont: string;
  /** Global border-radius in px */
  borderRadius: string;
  /** Public domain (derived from BASE_URL if not set) */
  domain: string;

  // -------------------------------------------------------------------------
  // DB-backed white-label fields (PRD §13, migration 008_brand_profiles.sql).
  // All optional so existing env-only callers keep working unchanged; the DB
  // loader populates them once FEATURE_DB_BRANDING is enabled.
  // -------------------------------------------------------------------------

  /** Brand row primary key; 'wyre-default' for the seeded fallback. PRD §13 */
  id?: string;
  /** Owning organization; null for the wyre_default singleton row. PRD §13 */
  orgId?: string | null;
  /** Parent brand for inheritance walk (customer -> reseller). PRD §5, §13 */
  parentBrandId?: string | null;
  /** Brand tier in the inheritance model. PRD §5, §13 */
  tier?: 'wyre_default' | 'reseller' | 'customer';
  /** Display name used in outbound email "From" header. PRD §13 */
  fromEmailDisplayName?: string | null;
  /** Support contact email address. PRD §13 */
  supportEmail?: string | null;
  /** Dark-mode logo variant URL. PRD §6, §13 */
  logoDarkUrl?: string | null;
  /** Primary text color token (hex #RRGGBB). PRD §9, §13 */
  textPrimary?: string | null;
  /** Secondary text color token (hex #RRGGBB). PRD §9, §13 */
  textSecondary?: string | null;
  /** Primary background color token (hex #RRGGBB). PRD §9, §13 */
  bgPrimary?: string | null;
  /** Secondary background color token (hex #RRGGBB). PRD §9, §13 */
  bgSecondary?: string | null;
  /** Border color token (hex #RRGGBB). PRD §9, §13 */
  borderColor?: string | null;
  /** Border radius in px (0-32); app-layer validates range. PRD §9, §13 */
  borderRadiusPx?: number | null;
  /** MSP toggle: when true, customer-tier children may override. PRD §5, §13 */
  allowCustomerOverrides?: boolean;
  /** Optimistic-lock revision; bumped on every write; defaults to 1. PRD §12, §13 */
  version?: number;
  /** True for the singleton Wyre fallback brand row. PRD §13 */
  isWyreDefault?: boolean;
}
