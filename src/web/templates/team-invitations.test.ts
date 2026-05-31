import { describe, it, expect } from 'vitest';
import { renderTeamInvitations, type TeamInvitationsData } from './team-invitations.js';

function data(over: Partial<TeamInvitationsData> = {}): TeamInvitationsData {
  return {
    orgId: 'org_1',
    baseUrl: 'https://conduit.wyre.ai',
    invitations: [],
    ...over,
  };
}

describe('renderTeamInvitations — §8 seat-cost note', () => {
  it('states each joining colleague takes a $39/mo member seat', () => {
    const html = renderTeamInvitations(data());
    expect(html).toContain('$39/mo member seat');
  });
});
