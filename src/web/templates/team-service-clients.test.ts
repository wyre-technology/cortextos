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
  it('agent within the inclusion → "$0, included" copy', () => {
    // 1 agent now → the next agent is #2, still inside the 2-seat inclusion.
    const html = renderTeamServiceClients(data({ seatBilling: makeSeatBilling(5, 1) }));
    expect(html).toContain('included in your plan, $0');
  });

  it('agent beyond the inclusion → "$20/mo" copy with plain proration', () => {
    // 2 agents now → the next agent is #3, the first billed one.
    const html = renderTeamServiceClients(data({ seatBilling: makeSeatBilling(5, 2) }));
    expect(html).toContain('$20/mo');
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
