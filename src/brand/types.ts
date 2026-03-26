export interface BrandConfig {
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
  /** Public domain (derived from BASE_URL if not set) */
  domain: string;
}
