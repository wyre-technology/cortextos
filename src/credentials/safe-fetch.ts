import { promises as dns } from 'node:dns';
import net from 'node:net';

/**
 * Validate a user-supplied vendor base URL before fetch().
 *
 * Why: a number of vendor `validate()` smoke tests fetch a URL the user
 * just typed into the credentials form. Without this guard the gateway
 * becomes an SSRF primitive — any logged-in user can probe `169.254.169.254`
 * (Azure IMDS), `localhost:5432` (Postgres), internal sidecar containers,
 * and infer existence/state from response status + timing.
 *
 * Rules:
 *   - protocol must be `https:`.
 *   - hostname must resolve to at least one address, and EVERY resolved
 *     address must be a public, routable IP. Mixed-result rejection
 *     prevents DNS rebinding into a private range after validation.
 *   - rejects any URL whose hostname is itself a literal disallowed IP.
 *
 * The caller does its own fetch() afterwards; that re-resolves DNS, so
 * a TOCTOU window exists. For credential-validation smoke tests the
 * window is small and the impact is bounded by the vendor's own auth.
 */
export async function validateVendorBaseUrl(input: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('URL must use https.');
  }

  // URL parser returns IPv6 hostnames wrapped in brackets ("[::1]"); strip
  // them before passing to net.isIP / DNS.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('URL is missing a hostname.');

  if (net.isIP(hostname) && !isPublicIp(hostname)) {
    throw new Error('URL points to a non-public IP.');
  }

  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  const addrs = [...v4, ...v6];

  if (addrs.length === 0) {
    throw new Error('Hostname did not resolve.');
  }

  // DNS rebinding mitigation: every resolved address must be public.
  for (const ip of addrs) {
    if (!isPublicIp(ip)) {
      throw new Error('Hostname resolves to a non-public IP.');
    }
  }
}

/**
 * Returns true only if `ip` is a public, routable address.
 * Rejects: loopback, link-local, RFC1918, CGNAT (100.64.0.0/10),
 * IANA reserved (192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24,
 * 203.0.113.0/24, 240.0.0.0/4), the cloud-metadata addresses
 * (169.254.169.254, fd00:ec2::254), IPv6 ULA (fc00::/7), IPv6 link-local
 * (fe80::/10), unspecified, and IPv4-mapped IPv6 of any of the above.
 */
export function isPublicIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  // 0.0.0.0/8 — current network
  if (a === 0) return false;
  // 10.0.0.0/8
  if (a === 10) return false;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 127.0.0.0/8 — loopback
  if (a === 127) return false;
  // 169.254.0.0/16 — link-local + IMDS (169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 — IANA IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return false;
  // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return false;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 — benchmark
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return false;
  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return false;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return false;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return false;
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped) {
    const v4 = mapped[1];
    if (net.isIPv4(v4)) return isPublicIpv4(v4);
  }
  // Unspecified
  if (lower === '::' || lower === '::0') return false;
  // Loopback
  if (lower === '::1') return false;
  // ULA fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
  // Multicast ff00::/8
  if (/^ff[0-9a-f]{2}:/.test(lower)) return false;
  return true;
}
