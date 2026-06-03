import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getSql, type Sql } from '../db/context.js';
import type { AdminAuditService } from '../audit/admin-audit-service.js';

// ---------------------------------------------------------------------------
// ConsentService — WYREAI-98 AI MSA accept-at-signup binding-record + audit
// ---------------------------------------------------------------------------
//
// Owns the consent-recording surface per WYREAI-98 contract (architecture-of-
// record at the artifact). Three responsibilities:
//
//   1. CRYPTOGRAPHIC LAYER (mechanical): fetch the canonical MSA PDF and
//      compute SHA256 + byte count at consent-time. Pearl-owned, never
//      delegates to a stored value (the recompute happens at acceptance
//      moment so the SHA records EXACTLY the bytes the user saw).
//   2. BINDING RECORD (org_consents): one row per accepted MSA version per
//      org. Multiple rows per (org_id, consent_type) by design — re-accept
//      INSERTS a new row, preserving history. Newest-by-accepted_at is the
//      authoritative current row.
//   3. INFORMATIONAL USER LAYER (user_consent_acknowledgments): per-user
//      "I acknowledge" record, FK'd to a specific binding row. NOT legally
//      binding unless Aaron+counsel over-rule scribe's org-scoped lean
//      (pending [ARCHITECTURE-DECISION] in WYREAI-98 body); pearl models
//      org-scoped binding now + informational user-layer alongside.
//
// AUDIT: every binding + every user-acknowledgment fires an admin_audit_log
// entry via the injected AdminAuditService. The audit-trail is independent
// of the consent rows themselves (cascade-on-delete cleans rows; audit
// preserves history) per scribe's distinction.
//
// POLICY LAYER NOT HERE: material-change classification (does THIS update
// of the PDF require re-accept?) is a human call by scribe+Aaron-legal, NOT
// a SHA-diff threshold. The cryptographic-layer / policy-layer separation
// is a load-bearing discipline pin from the 2026-06-02 cycle. This service
// records bytes; humans decide policy.
//
// The cheap-detector + load-bearing-decider paired-canary pattern lives in
// the schema: document_size_bytes is the cheap pre-hash mismatch detector;
// document_version (SHA256) is the load-bearing canonical-change decider.

/** Canonical URL of the WYRE AI Master Service Agreement PDF. */
export const AI_MSA_DOCUMENT_URL = 'https://docs.ourterms.live/WYRE/AI-Attachment.pdf';

/** Consent type discriminator used in org_consents.consent_type. */
export const CONSENT_TYPE_AI_MSA = 'ai_msa' as const;
export type ConsentType = typeof CONSENT_TYPE_AI_MSA;

export interface DocumentFingerprint {
  /** SHA256 hex (64 chars) of the document bytes at fetch-time. */
  version: string;
  /** Raw byte count of the document at fetch-time. */
  sizeBytes: number;
}

export interface OrgConsentRow {
  id: string;
  orgId: string;
  consentType: ConsentType;
  documentUrl: string;
  documentVersion: string;
  documentSizeBytes: number;
  acceptedByUserId: string | null;
  acceptedAt: string;
  acceptedIp: string | null;
  userAgent: string | null;
}

interface OrgConsentDbRow {
  id: string;
  org_id: string;
  consent_type: string;
  document_url: string;
  document_version: string;
  document_size_bytes: string | number; // postgres BIGINT → string in node-pg
  accepted_by_user_id: string | null;
  accepted_at: string;
  accepted_ip: string | null;
  user_agent: string | null;
}

function fromOrgRow(r: OrgConsentDbRow): OrgConsentRow {
  return {
    id: r.id,
    orgId: r.org_id,
    consentType: r.consent_type as ConsentType,
    documentUrl: r.document_url,
    documentVersion: r.document_version,
    documentSizeBytes: typeof r.document_size_bytes === 'string'
      ? Number(r.document_size_bytes)
      : r.document_size_bytes,
    acceptedByUserId: r.accepted_by_user_id,
    acceptedAt: r.accepted_at,
    acceptedIp: r.accepted_ip,
    userAgent: r.user_agent,
  };
}

export interface ConsentServiceDeps {
  /** Optional override of the document-fetch primitive. Tests inject a
   *  stub that returns deterministic bytes; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** AdminAuditService for the audit-trail side-effect on every consent
   *  + acknowledgment. Optional in tests where audit isn't being asserted;
   *  the service silently skips the audit write when not provided so
   *  consent recording stays atomic with its own row insert. */
  adminAuditService?: AdminAuditService;
}

export class ConsentService {
  private readonly fetchImpl: typeof fetch;
  private readonly adminAuditService?: AdminAuditService;

  constructor(deps: ConsentServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.adminAuditService = deps.adminAuditService;
  }

  private get sql(): Sql {
    return getSql();
  }

  /**
   * Fetch the canonical document and return its SHA256 + size. The SHA
   * computed here is what gets recorded in the binding row — capturing
   * at click-time eliminates the race where the document might change
   * between user-click and the eventual org_consents INSERT (the gap is
   * normally tiny, but cryptographic-evidence is the point — record
   * EXACTLY what the user saw).
   *
   * Throws on network failure / non-OK HTTP / empty body so the caller
   * can surface "MSA temporarily unavailable" rather than recording a
   * SHA-of-zero-bytes. The route handler converts the throw into an
   * appropriate user-facing response.
   */
  async fetchDocumentFingerprint(url: string): Promise<DocumentFingerprint> {
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`ConsentService: fetch ${url} failed with HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error(`ConsentService: fetch ${url} returned empty body`);
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    return { version: hash, sizeBytes: buf.length };
  }

  /**
   * Insert a new org_consents row (binding-record) + fire the audit-log
   * event. Multiple rows per (orgId, consentType) by design — re-accept
   * after a material change is a new INSERT, not an UPDATE. The newest-by-
   * accepted_at row is the authoritative current consent (queried via
   * getCurrentOrgConsent).
   *
   * The role-gate (owner-only first-accept / owner-or-admin re-accept per
   * pending [ARCHITECTURE-DECISION] in WYREAI-98) is enforced at the route
   * handler, NOT here — this service trusts its caller to have done the
   * authorization check. Same pattern as OrgService.updateOrgPlan etc.
   */
  async recordOrgConsent(input: {
    orgId: string;
    consentType: ConsentType;
    documentUrl: string;
    documentVersion: string;
    documentSizeBytes: number;
    acceptedByUserId: string;
    acceptedIp: string | null;
    userAgent: string | null;
  }): Promise<OrgConsentRow> {
    const id = nanoid();
    const rows = await this.sql<OrgConsentDbRow[]>`
      INSERT INTO org_consents (
        id, org_id, consent_type, document_url,
        document_version, document_size_bytes,
        accepted_by_user_id, accepted_ip, user_agent
      ) VALUES (
        ${id}, ${input.orgId}, ${input.consentType}, ${input.documentUrl},
        ${input.documentVersion}, ${input.documentSizeBytes},
        ${input.acceptedByUserId}, ${input.acceptedIp}, ${input.userAgent}
      )
      RETURNING
        id, org_id, consent_type, document_url,
        document_version, document_size_bytes,
        accepted_by_user_id, accepted_at, accepted_ip, user_agent
    `;
    const consent = fromOrgRow(rows[0]);

    // Audit-trail side-effect. Skipped silently if no adminAuditService
    // injected (tests). The .catch swallows audit-failure so consent
    // recording never blocks on audit-write — the row is the binding
    // record; the audit is the secondary history.
    if (this.adminAuditService) {
      await this.adminAuditService.log({
        orgId: input.orgId,
        actorId: input.acceptedByUserId,
        targetId: id,
        eventType: 'org_consent_accepted',
        metadata: {
          consentType: input.consentType,
          documentUrl: input.documentUrl,
          documentVersion: input.documentVersion,
          documentSizeBytes: input.documentSizeBytes,
        },
      }).catch(() => undefined);
    }
    return consent;
  }

  /**
   * Return the newest binding consent row for (orgId, consentType), or
   * null if none exists. The "current" row is always the newest-by-
   * accepted_at — same newest-row-authoritative pattern as subscriptions.
   * Used by the gate ("has this org accepted the current canonical MSA
   * version?") and by the user-acknowledgment flow ("which consent_id
   * should this user's acknowledgment FK to?").
   */
  async getCurrentOrgConsent(orgId: string, consentType: ConsentType): Promise<OrgConsentRow | null> {
    const rows = await this.sql<OrgConsentDbRow[]>`
      SELECT id, org_id, consent_type, document_url,
             document_version, document_size_bytes,
             accepted_by_user_id, accepted_at, accepted_ip, user_agent
        FROM org_consents
       WHERE org_id = ${orgId} AND consent_type = ${consentType}
       ORDER BY accepted_at DESC
       LIMIT 1
    `;
    return rows.length === 0 ? null : fromOrgRow(rows[0]);
  }

  /**
   * Record a per-user acknowledgment of a specific consent binding. UNIQUE
   * on (user_id, consent_id) at the schema level — calling twice for the
   * same pair is a no-op (ON CONFLICT DO NOTHING). Returns true if a row
   * was inserted, false if the acknowledgment already existed.
   *
   * Fires the user_consent_acknowledged audit event ONLY on first-insert,
   * not on the no-op path — avoids audit-log spam on idempotent calls.
   */
  async recordUserAcknowledgment(input: {
    userId: string;
    orgId: string;
    consentId: string;
    acknowledgedIp: string | null;
    userAgent: string | null;
  }): Promise<boolean> {
    const id = nanoid();
    const result = await this.sql`
      INSERT INTO user_consent_acknowledgments (
        id, user_id, org_id, consent_id, acknowledged_ip, user_agent
      ) VALUES (
        ${id}, ${input.userId}, ${input.orgId}, ${input.consentId},
        ${input.acknowledgedIp}, ${input.userAgent}
      )
      ON CONFLICT (user_id, consent_id) DO NOTHING
    `;
    const inserted = result.count > 0;
    if (inserted && this.adminAuditService) {
      await this.adminAuditService.log({
        orgId: input.orgId,
        actorId: input.userId,
        targetId: input.consentId,
        eventType: 'user_consent_acknowledged',
        metadata: { consentType: CONSENT_TYPE_AI_MSA },
      }).catch(() => undefined);
    }
    return inserted;
  }

  /**
   * Has this user already acknowledged the current binding consent for
   * this org? Returns false if no current binding exists (caller should
   * route to the no-consent flow instead).
   */
  async userHasAcknowledgedCurrent(userId: string, orgId: string, consentType: ConsentType): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM user_consent_acknowledgments uca
          JOIN org_consents oc ON oc.id = uca.consent_id
         WHERE uca.user_id = ${userId}
           AND uca.org_id = ${orgId}
           AND oc.consent_type = ${consentType}
           AND oc.id = (
             SELECT id FROM org_consents
              WHERE org_id = ${orgId} AND consent_type = ${consentType}
              ORDER BY accepted_at DESC
              LIMIT 1
           )
      ) AS exists
    `;
    return rows[0]?.exists === true;
  }
}
