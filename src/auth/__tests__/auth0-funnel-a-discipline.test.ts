import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-grep regression-guards for WYREAI-113 Funnel A wire-in discipline.
 *
 * The wire-in adds an auth-callback path that creates orgs + binds AI MSA
 * consent based on signup_intents row from pearl's PR #306. Several
 * security-critical invariants must hold even under refactor:
 *
 *  1. BOTH-OR-NEITHER deps — funnel block requires orgService AND
 *     consentService AND emailVerified AND email; drop any of those and
 *     the block must skip (graceful-degraded, NOT silent execution).
 *
 *  2. signup_intent lookup is replay-safe — SELECT must include
 *     `consumed_at IS NULL` so a second callback finds zero rows.
 *
 *  3. signup_intent email match is case-insensitive — LOWER() on both
 *     sides of the comparison so signup_intents.email (as-typed) and
 *     Auth0 claim email (case-variant) reconcile.
 *
 *  4. Bulk-discharge UPDATE matches all unconsumed for this email
 *     (pearl D pattern: orphan-rot closed by-construction).
 *
 *  5. runAsSystem wraps the funnel work (background-process-needs-
 *     context-wrap canonical-pattern from #303 thin-wrap discipline).
 *
 *  6. STRICT consent_accepted=false path rejects + redirects /signup
 *     per pearl B default; the rejection must also mark consumed_at to
 *     prevent loop.
 *
 *  7. SHA + size flow VERBATIM from signup_intents.consent_* to
 *     consentService.recordOrgConsent (warden lens d — trust transit
 *     not re-fetch; reference pearl's PR #306 paired-canary pin).
 *
 * Catches a future refactor that silently drops one of these invariants
 * before any auth flow runs in CI.
 */

const AUTH0_TS = join(__dirname, '..', 'auth0.ts');

describe('WYREAI-113 Funnel A wire-in discipline (source-grep regression guards)', () => {
  const src = readFileSync(AUTH0_TS, 'utf8');

  it('imports the WYREAI-113 deps + the Funnel A helpers', () => {
    expect(src).toMatch(/import\s+\{\s*nanoid\s*\}\s+from\s+'nanoid'/);
    expect(src).toMatch(/runAsSystem/);
    expect(src).toMatch(/import\s+type\s+\{\s*OrgService\s*\}/);
    expect(src).toMatch(/import\s+type\s+\{\s*ConsentService\s*\}/);
    expect(src).toMatch(/CONSENT_TYPE_AI_MSA/);
  });

  it('Auth0PluginDeps interface declares both Funnel A deps as optional', () => {
    expect(src).toMatch(/interface\s+Auth0PluginDeps\s*\{[\s\S]*?orgService\?:\s*OrgService;[\s\S]*?consentService\?:\s*ConsentService;[\s\S]*?\}/);
  });

  it('Funnel A block is BOTH-OR-NEITHER gated on orgService AND consentService AND emailVerified AND email', () => {
    expect(src).toMatch(/if\s*\(\s*orgService\s*&&\s*consentService\s*&&\s*emailVerified\s*&&\s*email\s*\)/);
  });

  it('signup_intent SELECT is replay-safe (consumed_at IS NULL clause)', () => {
    // The funnel SELECT must explicitly require consumed_at IS NULL to
    // reject the second callback that would otherwise replay.
    expect(src).toMatch(/SELECT[\s\S]*?FROM\s+signup_intents[\s\S]*?WHERE[\s\S]*?consumed_at\s+IS\s+NULL/i);
  });

  it('signup_intent lookup is case-insensitive on email (LOWER on both sides)', () => {
    expect(src).toMatch(/WHERE\s+LOWER\(\s*email\s*\)\s*=\s*LOWER\(\s*\$\{\s*email\s*\}\s*\)/);
  });

  it('bulk-discharge UPDATE marks ALL unconsumed signup_intents for this email (pearl D)', () => {
    expect(src).toMatch(/UPDATE\s+signup_intents[\s\S]*?SET\s+consumed_at\s*=\s*NOW\(\)[\s\S]*?WHERE\s+LOWER\(\s*email\s*\)\s*=\s*LOWER\(\s*\$\{\s*email\s*\}\s*\)[\s\S]*?consumed_at\s+IS\s+NULL/i);
  });

  it('orgService.createOrg wraps in runAsSystem', () => {
    expect(src).toMatch(/runAsSystem\(\s*\(\)\s*=>\s*[\s\S]{0,40}?orgService\.createOrg\(/);
  });

  it('STRICT consent_accepted=false branch rejects + marks consumed (pearl B default)', () => {
    // The else-branch for consent_accepted=false must (1) mark consumed_at
    // so the orphan does not loop, and (2) return a 400 with a re-signup
    // hint per pearl's [POLICY-DECISION] default.
    expect(src).toMatch(/consent_accepted=false[\s\S]*?rejecting/);
    expect(src).toMatch(/UPDATE\s+signup_intents[\s\S]*?SET\s+consumed_at\s*=\s*NOW\(\)/);
    expect(src).toMatch(/reply\.code\(400\)[\s\S]*?MSA acceptance is required/);
  });

  it('SHA + size flow VERBATIM from signup_intents to recordOrgConsent (warden lens d)', () => {
    // documentVersion + documentSizeBytes must be sourced from the intent
    // row, NOT re-fetched / recomputed at callback-time. Reference pearl's
    // PR #306 paired-canary + SHA-at-click discipline.
    expect(src).toMatch(/const\s+documentVersion\s*=\s*intent\.consent_document_version/);
    expect(src).toMatch(/const\s+documentSizeBytes\s*=\s*Number\(intent\.consent_document_size_bytes\)/);
    expect(src).toMatch(/consentService\.recordOrgConsent\([\s\S]*?documentUrl,[\s\S]*?documentVersion,[\s\S]*?documentSizeBytes,/);
  });

  it('recordUserAcknowledgment chains to the just-created consent row id', () => {
    expect(src).toMatch(/const\s+consent\s*=\s*await\s+consentService\.recordOrgConsent/);
    expect(src).toMatch(/consentService\.recordUserAcknowledgment\([\s\S]*?consentId:\s*consent\.id/);
  });

  it('onboarding_progress INSERT lands on (user, org, funnel) with reseller funnel', () => {
    expect(src).toMatch(/INSERT\s+INTO\s+onboarding_progress[\s\S]*?'reseller'[\s\S]*?'org_created'/);
    expect(src).toMatch(/ON\s+CONFLICT\s*\(\s*user_id,\s*org_id,\s*funnel\s*\)\s+DO\s+NOTHING/i);
  });

  it('Funnel A block sits AFTER user upsert + BEFORE setSessionCookie', () => {
    const userUpsertIdx = src.indexOf('INSERT INTO users');
    const funnelBlockIdx = src.indexOf('WYREAI-113 — Funnel A signup completion');
    const setCookieIdx = src.indexOf('setSessionCookie(reply, user)');
    expect(userUpsertIdx).toBeGreaterThan(0);
    expect(funnelBlockIdx).toBeGreaterThan(userUpsertIdx);
    expect(setCookieIdx).toBeGreaterThan(funnelBlockIdx);
  });
});
