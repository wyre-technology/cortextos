import { describe, it, expect } from 'vitest';
import { renderTeamMembers, type TeamMembersData } from './team-members.js';
import { mockSeatBilling } from '../../billing/seat-billing.js';

function data(over: Partial<TeamMembersData> = {}): TeamMembersData {
  return {
    orgId: 'org_1',
    viewerUserId: 'u1',
    viewerRole: 'owner',
    members: [{ userId: 'u1', role: 'owner', joinedAt: null, email: 'a@x.com', name: 'A' }],
    seatBilling: mockSeatBilling(1, 0),
    ...over,
  };
}

describe('renderTeamMembers — §8 seat-cost note', () => {
  it('states each member is a $20/mo seat', () => {
    const html = renderTeamMembers(data());
    expect(html).toContain('$20/mo seat');
    expect(html).toContain('prorates your next bill');
  });
});
