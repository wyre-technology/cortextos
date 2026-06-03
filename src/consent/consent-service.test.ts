import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ConsentService } from './consent-service.js';

// ---------------------------------------------------------------------------
// ConsentService.fetchDocumentFingerprint — cryptographic foundation tests
//
// Unit-level coverage on the pure-logic side: SHA256 computed correctly,
// throws on HTTP non-OK + on empty body. The SQL-touching methods
// (recordOrgConsent / getCurrentOrgConsent / recordUserAcknowledgment /
// userHasAcknowledgedCurrent) get separate integration coverage against a
// real Postgres in src/consent/__tests__/ (real schema exercises NOT NULL +
// FK cascade + UNIQUE constraints — the mock-SQL-substrate-constraint-
// silence pin family from ruby's PR #291 catch).
// ---------------------------------------------------------------------------

function makeMockFetch(opts: {
  ok?: boolean;
  status?: number;
  bytes?: Uint8Array;
}): typeof fetch {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  const bytes = opts.bytes ?? new Uint8Array();
  return (async () => ({
    ok,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch;
}

describe('ConsentService.fetchDocumentFingerprint', () => {
  it('computes SHA256-hex + raw byte count from fetched bytes', async () => {
    const payload = Buffer.from('canonical-msa-bytes-v1');
    const expectedHash = createHash('sha256').update(payload).digest('hex');
    const svc = new ConsentService({ fetchImpl: makeMockFetch({ bytes: payload }) });

    const fp = await svc.fetchDocumentFingerprint('https://docs.example/msa.pdf');

    expect(fp.version).toBe(expectedHash);
    expect(fp.version).toHaveLength(64); // sha256 hex
    expect(fp.sizeBytes).toBe(payload.length);
  });

  it('different bytes → different SHA256 (canonical-change detection)', async () => {
    const a = await new ConsentService({ fetchImpl: makeMockFetch({ bytes: Buffer.from('v1') }) })
      .fetchDocumentFingerprint('u');
    const b = await new ConsentService({ fetchImpl: makeMockFetch({ bytes: Buffer.from('v2') }) })
      .fetchDocumentFingerprint('u');
    expect(a.version).not.toBe(b.version);
  });

  it('identical bytes → identical SHA256 (idempotent recomputation)', async () => {
    const payload = Buffer.from('identical');
    const a = await new ConsentService({ fetchImpl: makeMockFetch({ bytes: payload }) })
      .fetchDocumentFingerprint('u');
    const b = await new ConsentService({ fetchImpl: makeMockFetch({ bytes: payload }) })
      .fetchDocumentFingerprint('u');
    expect(a.version).toBe(b.version);
    expect(a.sizeBytes).toBe(b.sizeBytes);
  });

  it('throws on HTTP non-OK rather than recording a SHA-of-error-page', async () => {
    // Critical: if the MSA URL ever 404s or 5xxs, the fetched-bytes would
    // hash to a SHA-of-error-page, NOT a SHA-of-the-MSA. Recording that
    // would falsely bind users to whatever HTML the upstream emitted.
    // Throw + let the route handler surface "MSA temporarily unavailable."
    const svc = new ConsentService({ fetchImpl: makeMockFetch({ ok: false, status: 404 }) });
    await expect(svc.fetchDocumentFingerprint('https://docs.example/msa.pdf'))
      .rejects.toThrow(/HTTP 404/);
  });

  it('throws on empty body rather than recording a SHA-of-zero-bytes', async () => {
    // Defensive: an upstream returning 200 OK + empty body shouldn't yield
    // a valid consent record. The fixed SHA-of-empty-bytes
    // (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)
    // would otherwise be the same across every empty-body acceptance.
    const svc = new ConsentService({ fetchImpl: makeMockFetch({ bytes: new Uint8Array(0) }) });
    await expect(svc.fetchDocumentFingerprint('https://docs.example/msa.pdf'))
      .rejects.toThrow(/empty body/);
  });

  it('uses the injected fetchImpl exactly once per call', async () => {
    const fetchSpy = vi.fn(makeMockFetch({ bytes: Buffer.from('x') }));
    const svc = new ConsentService({ fetchImpl: fetchSpy });
    await svc.fetchDocumentFingerprint('https://docs.example/msa.pdf');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://docs.example/msa.pdf');
  });

  it('document_size_bytes matches the cheap-detector contract (raw byte count, not character count)', async () => {
    // Multi-byte UTF-8 example: '€' is 3 bytes in UTF-8 but 1 character.
    // The cheap-detector contract is BYTE count, not character count —
    // matters for the mismatch-canary that pairs with the SHA. A byte-
    // count mismatch is the cheap pre-hash signal; a character-count
    // mismatch could disagree with the SHA which IS computed over bytes.
    const eur = Buffer.from('€'); // 3 bytes
    const svc = new ConsentService({ fetchImpl: makeMockFetch({ bytes: eur }) });
    const fp = await svc.fetchDocumentFingerprint('u');
    expect(fp.sizeBytes).toBe(3);
    expect('€'.length).toBe(1); // sanity: characters !== bytes
  });
});
