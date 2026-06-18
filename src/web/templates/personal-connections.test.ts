import { describe, it, expect } from 'vitest';
import { renderPersonalConnections, type PersonalConnectionsData } from './personal-connections.js';
import type { Organization } from '../../org/org-service.js';
import type { SeatBilling } from '../../billing/seat-service.js';
import type { TrialState } from './team-billing.js';

const org: Organization = {
  id: 'org_alice',
  name: 'Acme MSP',
  ownerId: 'auth0|1',
  plan: 'conduit',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'standalone',
  parentOrgId: null,
  auth0OrgId: null,
  suspendedAt: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-06-04T00:00:00Z',
};

function baseData(over: Partial<PersonalConnectionsData> = {}): PersonalConnectionsData {
  return {
    connectedVendors: [],
    org,
    orgVendors: [],
    memberCount: 1,
    connectionLimit: Infinity,
    upgraded: false,
    isOwner: true,
    stripeEnabled: true,
    ...over,
  };
}

/**
 * Regression-guards for ruby's org-creation sweep (2026-06-04). These lock
 * the four customer-facing inversions that shipped on /settings before
 * launch:
 *   OC1: hardcoded "Pro" plan badge under flat-pricing (no Pro tier)
 *   OC2: upgrade-banner copy claimed "upgraded to Pro / unlimited
 *        connections / audit logging" — none of which describe the
 *        actual flat-pricing trial-converted transition
 *   OC3: invite_code input that the backend (src/org/routes.ts:102) drops
 *        with `void inviteCode` — UX-deceptive form field
 *   OC6 (T1 elevation): trial banner missing from /settings (was only on
 *        /org/billing), so a trialing user who lands on /settings does
 *        not see countdown / first-charge info
 */
describe('renderPersonalConnections — ruby OC1+OC2+OC3+OC6 regression-guards', () => {
  it('OC1: org header has NO plan-badge Pro span (flat-pricing, no Pro tier)', () => {
    const { body } = renderPersonalConnections(baseData());
    expect(body).not.toContain('plan-badge pro');
    expect(body).not.toMatch(/<span[^>]*plan-badge[^>]*>Pro<\/span>/);
    expect(body).toContain('Acme MSP'); // org name still renders
  });

  it('OC2: upgrade banner uses trial-converted copy (not the stale Pro/unlimited claim) when ?upgraded=true', () => {
    const { body } = renderPersonalConnections(baseData({ upgraded: true }));
    expect(body).toContain('upgrade-banner');
    expect(body).toContain('trial converted');
    // Stale copy must be gone — these are the false claims:
    expect(body).not.toContain('upgraded to Pro');
    expect(body).not.toContain('unlimited connections');
    expect(body).not.toContain('audit logging');
  });

  it('OC2: upgrade banner is absent when ?upgraded is not set', () => {
    const { body } = renderPersonalConnections(baseData({ upgraded: false }));
    expect(body).not.toContain('upgrade-banner');
  });

  it('OC3: create-team form has NO invite_code field (backend drops it via `void inviteCode`)', () => {
    const noOrg = baseData({ org: null });
    const { body } = renderPersonalConnections(noOrg);
    expect(body).toContain('id="create-team-form"');
    expect(body).toContain('name="team_name"');
    expect(body).not.toContain('name="invite_code"');
    expect(body).not.toContain('placeholder="Invite code');
    // JS body posted to /api/orgs must not carry invite_code either.
    expect(body).not.toContain('invite_code:');
  });

  it('OC6: trial banner renders when trial + seatBilling are passed (T1-on-/settings elevation)', () => {
    const trial: TrialState = { endsAt: '2026-06-18T00:00:00.000Z' };
    const seatBilling: SeatBilling = Object.freeze({
      humans: 1,
      agents: 0,
      includedHumans: 0,
      includedAgents: 0,
      billableHumans: 1,
      billableAgents: 0,
      perHumanCents: 3900,
      perAgentCents: 3900,
      baseFeeCents: 39900,
      monthlyTotalCents: 39900 + 1 * 3900,
      currency: 'usd',
    } as unknown as SeatBilling);
    const { body } = renderPersonalConnections(baseData({ trial, seatBilling }));
    expect(body).toContain('trial-banner');
    expect(body).toContain('Free trial');
  });

  it('OC6: trial banner is absent when trial is null (the non-trialing default)', () => {
    const { body } = renderPersonalConnections(baseData({ trial: null }));
    expect(body).not.toContain('trial-banner');
  });
});

/**
 * Regression-guards for ruby PSR1 (2026-06-05). PR #345 D1 wired the
 * dunning banner + suspended-card to /settings but explicitly excluded
 * the recovered state — so a customer who paid a failed invoice and
 * landed on /settings during the 1h-TTL recovered window saw nothing,
 * while /org/billing showed "You're set." This restores symmetry across
 * the personal-default surfaces using the same shared-helper pattern.
 *
 * Falsifiable triad on the recovered substrate:
 *   (a) state='recovered' → toast rendered + DUNNING_TOAST_SCRIPT
 *       returned via pageScripts (auto-dismiss after 1h TTL)
 *   (b) non-recovered states → pageScripts undefined (no idle script)
 *   (c) recovered state does NOT additionally render the banner (toast
 *       is the only surface; banner is for active dunning only)
 */
describe('renderPersonalConnections — ruby PSR1 regression-guards (recovered-toast symmetry)', () => {
  const recoveredDunning = {
    state: 'recovered' as const,
    recoveredAt: '2026-06-05T11:00:00.000Z',
    amountCents: 39900,
    currency: 'usd',
    nextChargeDate: '2026-07-05T00:00:00.000Z',
  };

  it('PSR1 (a): recovered state renders the toast', () => {
    const { body } = renderPersonalConnections(baseData({ dunning: recoveredDunning }));
    expect(body).toContain('dunning-toast');
  });

  it('PSR1 (a): recovered state returns DUNNING_TOAST_SCRIPT as pageScripts', () => {
    const { pageScripts } = renderPersonalConnections(baseData({ dunning: recoveredDunning }));
    expect(pageScripts).toBeTruthy();
    // The auto-dismiss script targets the toast DOM node.
    expect(pageScripts).toContain('dunning-toast');
  });

  it('PSR1 (b): pageScripts is undefined for the non-recovered default (no idle script payload)', () => {
    const { pageScripts } = renderPersonalConnections(baseData({ dunning: { state: 'none' } }));
    expect(pageScripts).toBeUndefined();
  });

  it('PSR1 (c): recovered state does NOT additionally render the active-dunning banner', () => {
    const { body } = renderPersonalConnections(baseData({ dunning: recoveredDunning }));
    // The banner is for active dunning (payment-failing/past-due/final-warning).
    // Recovered uses the toast surface only.
    expect(body).not.toContain('dunning-banner');
  });
});
