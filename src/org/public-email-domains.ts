/**
 * Free/public email-provider domains. Rejected as claimable for domain auto-join:
 * no one should be able to "own" gmail.com.
 *
 * Conservative list — the real safety net is DNS-TXT verification. This is the
 * UX fast-fail so users don't even see a claim prompt for public inboxes.
 * Extend as needed; consider swapping for the `free-email-domains` npm package
 * if this grows past ~200 entries.
 */
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk',
  // Yahoo
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.fr', 'yahoo.de',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // AOL
  'aol.com', 'aim.com',
  // Privacy-focused
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tutanota.de', 'tuta.io',
  // Other large free providers
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de',
  'fastmail.com', 'fastmail.fm',
  'hey.com',
  'mail.com', 'email.com',
  'zoho.com',
  'yandex.com', 'yandex.ru',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  // ISP legacy inboxes commonly used personally
  'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net', 'cox.net',
  'bellsouth.net', 'earthlink.net', 'charter.net', 'optonline.net',
  // Disposable (common)
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'trashmail.com', 'yopmail.com',
]);

/** Normalize an email domain for comparison. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

/** Extract the domain part of an email and normalize it. Returns null if malformed. */
export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(normalizeDomain(domain));
}
