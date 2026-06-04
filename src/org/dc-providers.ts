/**
 * Domain Connect (DC) provider registry — WYREAI-134 + WYREAI-135.
 *
 * Maps the NS-pattern observed at `dig +short NS <domain>` to a known DC
 * Service Provider's "apply" endpoint, so the frontend can show a one-click
 * DC button alongside the existing manual TXT-record flow at
 * src/web/templates/team-domains.ts.
 *
 * COVERAGE (from 2026-06-03 cohort research on 38 founder-welcome signup
 * domains): Cloudflare 39.5% (15) + GoDaddy 26.3% (10) + Vercel 2.6% (1) =
 * 68.4% Tier-1 DC-only coverage. Long-tail 31.6% (10 providers × 1 customer
 * each) handled by the existing manual TXT-record UI as universal fallback.
 *
 * UPSTREAM CONTRACT NOTE — DC template JSON is NOT publicly hosted by the
 * Service Provider (us); per DC spec draft-02 §3 it is registered out-of-
 * band with each DNS Provider during their onboarding process. Tracked
 * separately at WYREAI-137 (ops sub-track, Aaron/business-owned). This
 * engineering surface produces the apply-URLs that will work ONLY after
 * the corresponding DNS Provider has finished onboarding our template
 * (providerId='conduit.wyre.ai', serviceId='domain-verify').
 *
 * The set of providers here is INTENTIONALLY narrow — Tier-1 only. Adding
 * a new provider is one entry in PROVIDERS below + an onboarding ticket
 * with that DNS provider; no other code changes.
 */

import { resolveNs as nodeResolveNs } from 'node:dns/promises';

/** DC-supported provider slugs the frontend can show a one-click button for. */
export type DcProviderSlug = 'cloudflare' | 'godaddy' | 'vercel';

/** All other NS patterns fall here — frontend shows manual TXT flow only. */
export type ProviderSlug = DcProviderSlug | 'unsupported';

interface ProviderEntry {
  /** Human-readable name shown in the DC button label ("Add to Cloudflare"). */
  name: string;
  /**
   * NS-host substrings that identify this provider. Match is case-insensitive
   * substring against any of the domain's NS records.
   *
   * E.g. CF's NS records look like `adel.ns.cloudflare.com.` — the substring
   * `ns.cloudflare.com` matches every CF-managed domain.
   */
  nsPatterns: readonly string[];
  /**
   * DC v2 sync apply endpoint host. The full URL the frontend redirects to
   * is built by `buildDcApplyUrl()` below using DC spec draft-02 §4 format:
   *
   *   GET https://{applyHost}/v2/domainTemplates/providers/{providerId}/
   *       services/{serviceId}/apply?
   *       domain={domain}&{props}&redirect_uri={callbackUrl}
   *
   * EXACT host depends on the DNS provider's DC implementation — the spec
   * does not standardize the host; each provider publishes their own at
   * onboarding time. Values here are the DOCUMENTED current values per each
   * provider's DC onboarding docs (correct as of 2026-06-03; verify before
   * production by running the template-support query at GET {applyHost}/v2/
   * domainTemplates/providers/{providerId}/services/{serviceId}).
   */
  applyHost: string;
}

const PROVIDERS: Record<DcProviderSlug, ProviderEntry> = {
  cloudflare: {
    name: 'Cloudflare',
    nsPatterns: ['ns.cloudflare.com'],
    applyHost: 'domainconnect.cloudflare.com',
  },
  godaddy: {
    name: 'GoDaddy',
    nsPatterns: ['domaincontrol.com'],
    applyHost: 'dcc.godaddy.com',
  },
  vercel: {
    name: 'Vercel',
    nsPatterns: ['vercel-dns.com'],
    applyHost: 'domainconnect.vercel.com',
  },
};

/**
 * Classify a domain's DNS provider by NS-record pattern matching.
 *
 * Returns one of the DC-supported slugs when a known pattern matches, or
 * 'unsupported' for the long-tail of providers that don't support Domain
 * Connect (Route53 / Gandi / SiteGround / DNSMadeEasy / GCP DNS / etc).
 *
 * Injectable resolver makes this fully testable without network calls:
 *
 *   classifyProvider('example.com', async () => ['adel.ns.cloudflare.com.'])
 *
 * Failed NS lookups (NXDOMAIN, network error, etc) return 'unsupported' —
 * never throw — so the frontend uniformly falls back to the manual TXT
 * flow on any failure. (If a domain has no NS records at all, it's almost
 * certainly mistyped at signup; the manual flow's Verify button will surface
 * the actual problem on the user's next attempt.)
 */
export type NsResolver = (hostname: string) => Promise<string[]>;

export async function classifyProvider(
  domain: string,
  resolver: NsResolver = nodeResolveNs,
): Promise<ProviderSlug> {
  let nsRecords: string[];
  try {
    nsRecords = await resolver(domain);
  } catch {
    return 'unsupported';
  }
  if (!nsRecords || nsRecords.length === 0) {
    return 'unsupported';
  }
  // Normalize to lowercase for case-insensitive substring match. NS records
  // typically come back with trailing dots; the substring test ignores those.
  const haystack = nsRecords.map((r) => r.toLowerCase()).join('|');
  for (const slug of Object.keys(PROVIDERS) as DcProviderSlug[]) {
    if (PROVIDERS[slug].nsPatterns.some((pat) => haystack.includes(pat))) {
      return slug;
    }
  }
  return 'unsupported';
}

/**
 * Build the DC v2 synchronous apply URL for a (provider, domain, token,
 * callback) tuple. Returns null if the provider isn't DC-supported.
 *
 * The verification_token property in the URL is consumed by the DC template
 * at apply-time to substitute into the TXT record's data field — matching
 * the existing manual flow's `_conduit-verify.<domain> TXT <token>` shape
 * by-construction (DC template at WYREAI-137 declares the same host and
 * pulls `%verification_token%` from the URL params).
 *
 * Optional `sig`/`key` query params would carry a signed callback verification
 * per DC spec draft-02 §4.2 (Service Provider can include a signature so the
 * DNS provider can verify the redirect originated from the legitimate SP).
 * Production deployment SHOULD enable this; for V1 it's omitted until the
 * key-pair is provisioned and registered with each DNS provider (also out-of-
 * band as part of the onboarding tracked at WYREAI-137).
 */
export interface DcApplyUrlParams {
  provider: DcProviderSlug;
  domain: string;
  verificationToken: string;
  /** URL the DNS provider redirects the user back to after applying the template. */
  callbackUrl: string;
  /** Stable Service Provider id registered with each DNS provider. */
  providerId?: string;
  /** Stable service id within our SP's template registry. */
  serviceId?: string;
}

const DEFAULT_PROVIDER_ID = 'conduit.wyre.ai';
const DEFAULT_SERVICE_ID = 'domain-verify';

export function buildDcApplyUrl(params: DcApplyUrlParams): string | null {
  const entry = PROVIDERS[params.provider];
  if (!entry) return null;

  const providerId = params.providerId ?? DEFAULT_PROVIDER_ID;
  const serviceId = params.serviceId ?? DEFAULT_SERVICE_ID;

  const query = new URLSearchParams({
    domain: params.domain,
    verification_token: params.verificationToken,
    redirect_uri: params.callbackUrl,
  });

  return (
    `https://${entry.applyHost}` +
    `/v2/domainTemplates/providers/${encodeURIComponent(providerId)}` +
    `/services/${encodeURIComponent(serviceId)}/apply?` +
    query.toString()
  );
}

/** Stable list of DC-supported slugs for tests + frontend conditional rendering. */
export const DC_SUPPORTED_SLUGS: readonly DcProviderSlug[] = ['cloudflare', 'godaddy', 'vercel'];

/** Provider display name from a slug — used by the frontend button label. */
export function getProviderName(slug: DcProviderSlug): string {
  return PROVIDERS[slug].name;
}
