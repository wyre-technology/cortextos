import { describe, it, expect } from 'vitest';
import { renderTeamDomains, type TeamDomainsData } from './team-domains.js';

function data(over: Partial<TeamDomainsData> = {}): TeamDomainsData {
  return {
    orgId: 'org_1',
    domains: [],
    ...over,
  };
}

describe('renderTeamDomains — §8 auto-join seat-cost note', () => {
  it('warns that auto-join takes a $39/mo member seat without a per-person confirm', () => {
    const html = renderTeamDomains(data());
    expect(html).toContain('$39/mo member');
    expect(html).toContain('auto-join');
    expect(html).toContain('without a');
  });
});
