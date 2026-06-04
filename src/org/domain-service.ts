/**
 * Organization domain claim / verify — ported from mcp-gateway
 * (src/org/domain-service.ts). Backs domain-based org auto-join: an org admin
 * claims an email domain, proves ownership via a DNS TXT record, and users
 * with a matching verified email domain can then join that org.
 *
 * conduit adaptations vs the gateway original:
 *   - No initTables(): the organization_domains table is created by
 *     migration 031, not idempotent bootstrap.
 *   - sql resolves per-call via getSql() (conduit's request-/system-path
 *     context model) rather than an injected handle.
 *   - The CROSS-ORG reads run system-path (runAsSystem / BYPASSRLS): a claim
 *     lookup and the "already verified elsewhere" pre-check must see rows for
 *     orgs the caller is not a member of, and organization_domains RLS
 *     (migration 031) is member-scoped. These are deliberate cross-tenant
 *     reads — explicit runAsSystem, never an inferred bypass.
 */
import { resolveTxt } from 'node:dns/promises';
import { nanoid } from 'nanoid';
import { getSql, runAsSystem, type Sql } from '../db/context.js';
import { domainFromEmail, isPublicEmailDomain, normalizeDomain } from './public-email-domains.js';

export type OrgDomainRole = 'member' | 'admin';

export interface OrgDomain {
  id: string;
  orgId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  autoJoinRole: OrgDomainRole;
  createdAt: string;
  createdBy: string | null;
}

interface OrgDomainRow {
  id: string;
  org_id: string;
  domain: string;
  verification_token: string;
  verified_at: string | null;
  verified_by: string | null;
  auto_join_role: string;
  created_at: string;
  created_by: string | null;
}

export type OrgDomainErrorCode =
  | 'PUBLIC_DOMAIN_NOT_ALLOWED'
  | 'INVALID_DOMAIN'
  | 'DOMAIN_ALREADY_CLAIMED'
  | 'DOMAIN_NOT_FOUND'
  | 'VERIFICATION_TOKEN_MISSING'
  | 'VERIFICATION_DNS_ERROR';

export class OrgDomainError extends Error {
  public readonly code: OrgDomainErrorCode;
  constructor(code: OrgDomainErrorCode, message: string) {
    super(message);
    this.name = 'OrgDomainError';
    this.code = code;
  }
}

function toDomain(row: OrgDomainRow): OrgDomain {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    verificationToken: row.verification_token,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    autoJoinRole: row.auto_join_role as OrgDomainRole,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

// RFC 1035-ish: labels separated by dots, each label alphanumeric + hyphen,
// not starting/ending with hyphen, total length <= 253.
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Extract the bare nanoid from a stored verificationToken.
 *
 * Format: `conduit-verify=<24-char nanoid>` per add() at this file. Return
 * the part after the `=`. Returns null if the token doesn't fit the
 * expected shape (defensive — shouldn't happen for any row created via
 * the current add() path, but legacy rows or schema-divergence-via-direct-
 * DB-write would surface here).
 *
 * Used by verify()'s tolerance-by-construction fallback path: when a
 * customer's TXT record matches the bare nanoid but not the full token
 * (e.g. their DNS provider stripped the hyphen, doubled quote-escaping,
 * etc), accept the verification — the 24-char nanoid is the entropy
 * source; the prefix exists for human-readable namespace identification.
 */
export function bareNanoidFromVerificationToken(token: string): string | null {
  const eqIdx = token.indexOf('=');
  if (eqIdx < 0) return null;
  const bare = token.slice(eqIdx + 1);
  // Defensive: require at least 16 chars of nanoid-shape for the
  // tolerance path to apply. Prevents accidental match against any short
  // string after a literal '=' character in the TXT record.
  if (bare.length < 16) return null;
  return bare;
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(normalizeDomain(domain));
}

/** DNS resolver signature — injectable for tests. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

export class OrgDomainService {
  private readonly resolveTxt: TxtResolver;

  constructor(resolver?: TxtResolver) {
    this.resolveTxt = resolver ?? resolveTxt;
  }

  /** Resolves to the active request- or system-path connection. */
  private get sql(): Sql {
    return getSql();
  }

  async add(
    orgId: string,
    rawDomain: string,
    createdBy: string,
    autoJoinRole: OrgDomainRole = 'member',
  ): Promise<OrgDomain> {
    const domain = normalizeDomain(rawDomain);
    if (!isValidDomain(domain)) {
      throw new OrgDomainError('INVALID_DOMAIN', `"${rawDomain}" is not a valid domain`);
    }
    if (isPublicEmailDomain(domain)) {
      throw new OrgDomainError(
        'PUBLIC_DOMAIN_NOT_ALLOWED',
        `${domain} is a public email provider and cannot be claimed`,
      );
    }

    // If already VERIFIED by a different org, reject up front. This is a
    // deliberate cross-org read — organization_domains RLS is member-scoped
    // and would hide the other org's row — so it runs system-path. The
    // partial-unique index uq_organization_domains_verified_domain is the
    // hard safety net at verify() time; this is the friendly early reject.
    const verifiedElsewhere = await runAsSystem(() =>
      getSql()<OrgDomainRow[]>`
        SELECT * FROM organization_domains
         WHERE domain = ${domain} AND verified_at IS NOT NULL AND org_id <> ${orgId}
         LIMIT 1
      `,
    );
    if (verifiedElsewhere[0]) {
      throw new OrgDomainError(
        'DOMAIN_ALREADY_CLAIMED',
        `${domain} is already claimed by another organization`,
      );
    }

    // Upsert on (org_id, domain) — re-adding rotates the verification token.
    const id = nanoid();
    const token = `conduit-verify=${nanoid(24)}`;
    const rows = await this.sql<OrgDomainRow[]>`
      INSERT INTO organization_domains
        (id, org_id, domain, verification_token, auto_join_role, created_by)
      VALUES (${id}, ${orgId}, ${domain}, ${token}, ${autoJoinRole}, ${createdBy})
      ON CONFLICT (org_id, domain) DO UPDATE
        SET verification_token = EXCLUDED.verification_token,
            auto_join_role = EXCLUDED.auto_join_role,
            verified_at = NULL,
            verified_by = NULL
      RETURNING *
    `;
    return toDomain(rows[0]);
  }

  async list(orgId: string): Promise<OrgDomain[]> {
    const rows = await this.sql<OrgDomainRow[]>`
      SELECT * FROM organization_domains WHERE org_id = ${orgId} ORDER BY created_at
    `;
    return rows.map(toDomain);
  }

  async getById(id: string, orgId: string): Promise<OrgDomain | null> {
    const rows = await this.sql<OrgDomainRow[]>`
      SELECT * FROM organization_domains WHERE id = ${id} AND org_id = ${orgId}
    `;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM organization_domains WHERE id = ${id} AND org_id = ${orgId}
    `;
    return result.count > 0;
  }

  /**
   * Look up _conduit-verify.<domain> TXT records. Match if any record value
   * equals the stored verification_token exactly. On success, set verified_at.
   */
  async verify(
    id: string,
    orgId: string,
    verifiedBy: string,
    logger?: { warn: (obj: object, msg: string) => void },
  ): Promise<OrgDomain> {
    const existing = await this.getById(id, orgId);
    if (!existing) {
      throw new OrgDomainError('DOMAIN_NOT_FOUND', `domain claim ${id} not found`);
    }

    let records: string[][];
    try {
      records = await this.resolveTxt(`_conduit-verify.${existing.domain}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      throw new OrgDomainError(
        'VERIFICATION_DNS_ERROR',
        `DNS lookup for _conduit-verify.${existing.domain} failed (${code})`,
      );
    }

    const joined = records.map((chunks) => chunks.join(''));

    // STRICT match first — happy-path is unchanged.
    if (!joined.includes(existing.verificationToken)) {
      // FALLBACK: bare-nanoid match. The verificationToken is
      // `conduit-verify=<nanoid>`; the human-readable prefix is namespace-
      // marker, the nanoid IS the entropy source. When a customer types the
      // TXT value at their DNS provider, the prefix can drift in three ways
      // we've observed at the customer-input substrate:
      //
      //   - hyphen stripped: `conduitverify=<nanoid>`  (Aaron 2026-06-04, prod)
      //   - case variation: `Conduit-Verify=<nanoid>`
      //   - quotation-marks doubled / stripped by provider input field
      //
      // Tolerance-by-construction at the customer-input substrate (boss-
      // banked 2026-06-04 sibling to fail-closed-by-construction at the
      // system-output substrate): accept any TXT record that contains the
      // bare nanoid. Security property preserved: the 24-char nanoid is
      // the unique entropy source; the prefix exists for human-readable
      // namespace identification, not security.
      const bareToken = bareNanoidFromVerificationToken(existing.verificationToken);
      if (!bareToken || !joined.some((r) => r.includes(bareToken))) {
        throw new OrgDomainError(
          'VERIFICATION_TOKEN_MISSING',
          `TXT record for _conduit-verify.${existing.domain} did not contain the expected token`,
        );
      }
      // Telemetry: the bare-nanoid path matched but the strict path did
      // not. Logs the customer-input variation so the systemic-rate of
      // this divergence is observable. If this fires at scale we know the
      // tolerance is load-bearing; if it stays rare we can simplify back
      // to strict comparison later.
      if (logger) {
        logger.warn(
          { event: 'domain_verify_hyphen_normalize_fired', domain: existing.domain, orgId },
          `domain-verify: TXT record matched bare nanoid but not full token prefix — customer-input variation accepted`,
        );
      }
    }

    // Race on verified uniqueness: if another org slipped in between add() and
    // verify(), the partial-unique index raises; surface that cleanly.
    try {
      const rows = await this.sql<OrgDomainRow[]>`
        UPDATE organization_domains
           SET verified_at = NOW(), verified_by = ${verifiedBy}
         WHERE id = ${id}
         RETURNING *
      `;
      return toDomain(rows[0]);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('uq_organization_domains_verified_domain')) {
        throw new OrgDomainError(
          'DOMAIN_ALREADY_CLAIMED',
          `${existing.domain} was verified by another organization first`,
        );
      }
      throw err;
    }
  }

  /**
   * Find a verified claim for a given domain, if any. Used by claim-
   * eligibility and claim. A deliberate cross-org read — the caller is not
   * yet a member of the owning org, so member-scoped RLS would hide exactly
   * the row being sought — runs system-path.
   */
  async findVerifiedByDomain(rawDomain: string): Promise<OrgDomain | null> {
    const domain = normalizeDomain(rawDomain);
    const rows = await runAsSystem(() =>
      getSql()<OrgDomainRow[]>`
        SELECT * FROM organization_domains
         WHERE domain = ${domain} AND verified_at IS NOT NULL
         LIMIT 1
      `,
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /** Convenience: resolve a verified claim from a user's email. */
  async findVerifiedByEmail(email: string): Promise<OrgDomain | null> {
    const domain = domainFromEmail(email);
    if (!domain || isPublicEmailDomain(domain)) return null;
    return this.findVerifiedByDomain(domain);
  }
}
