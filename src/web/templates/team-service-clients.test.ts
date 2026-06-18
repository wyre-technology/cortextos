import { describe, it, expect } from 'vitest';
import {
  renderTeamServiceClients,
  type TeamServiceClientsData,
} from './team-service-clients.js';
import { makeSeatBilling } from './test-helpers/seat-billing-fixture.js';

function data(over: Partial<TeamServiceClientsData> = {}): TeamServiceClientsData {
  return {
    orgId: 'org_1',
    baseUrl: 'https://conduit.wyre.ai',
    serviceClients: [],
    seatBilling: makeSeatBilling(5, 0),
    trialing: false,
    ...over,
  };
}

describe('renderTeamServiceClients — §8 at-creation cost copy', () => {
  // AGENTS-BILLABLE (Aaron 2026-06-17, WYREAI-25, boss msg-1781747082415):
  // INCLUDED_AGENT_SEATS=0 — every agent bills $39 from seat 1, identical
  // to a human. No "$0 included" copy path exists.
  it('first agent → "$39/mo" copy with plain proration', () => {
    const html = renderTeamServiceClients(data({ seatBilling: makeSeatBilling(5, 0) }));
    expect(html).toContain('$39/mo');
    expect(html).toContain('prorated for the remainder of this cycle');
  });

  it('Nth agent → still "$39/mo" — no inclusion tier, every agent is billable', () => {
    // 2 agents now → next agent is #3; same $39 line as the first add.
    const html = renderTeamServiceClients(data({ seatBilling: makeSeatBilling(5, 2) }));
    expect(html).toContain('$39/mo');
    expect(html).toContain('prorated for the remainder of this cycle');
  });

  it('during a trial, a billed agent is framed at trial-end', () => {
    const html = renderTeamServiceClients(data({
      seatBilling: makeSeatBilling(5, 2),
      trialing: true,
    }));
    expect(html).toContain('applied when your trial ends');
  });

  it('never renders a computed dollar proration figure', () => {
    const html = renderTeamServiceClients(data({ seatBilling: makeSeatBilling(5, 8) }));
    expect(html).not.toMatch(/\$\d+\.\d\d this cycle/);
  });

  it('escapes the org id (no HTML injection via the inline script)', () => {
    const html = renderTeamServiceClients(data({ orgId: "x'</script>" }));
    expect(html).not.toContain("x'</script>");
  });
});
