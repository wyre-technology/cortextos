import { describe, it, expect, vi } from 'vitest';
import { userHasAnyCredentials } from './authorization-server.js';
import type { OrgService } from '../org/org-service.js';

const creds = { accessToken: 'tok' };

function makeCredService(overrides: {
  hasPersonal?: boolean;
  orgCred?: Record<string, string> | null;
  teamCred?: Record<string, string> | null;
}) {
  return {
    has: vi.fn().mockResolvedValue(overrides.hasPersonal ?? false),
    getOrgCredential: vi.fn().mockResolvedValue(overrides.orgCred ?? null),
    getTeamCredentialsForTeams: vi.fn().mockResolvedValue(
      overrides.teamCred ? [{ teamId: 'team1', creds: overrides.teamCred }] : [],
    ),
  };
}

function makeOrgService(overrides: {
  orgs?: { id: string }[];
  teams?: { id: string }[];
  hasServerAccess?: boolean;
}): OrgService {
  return {
    getUserOrgs: vi.fn().mockResolvedValue(overrides.orgs ?? []),
    getUserTeams: vi.fn().mockResolvedValue(overrides.teams ?? []),
    hasServerAccess: vi.fn().mockResolvedValue(overrides.hasServerAccess ?? true),
  } as unknown as OrgService;
}

describe('userHasAnyCredentials', () => {
  it('returns true when personal credentials exist', async () => {
    const svc = makeCredService({ hasPersonal: true });
    expect(await userHasAnyCredentials('user1', 'autotask', svc)).toBe(true);
    expect(svc.getOrgCredential).not.toHaveBeenCalled();
  });

  it('returns false when no credentials exist anywhere', async () => {
    const svc = makeCredService({});
    const org = makeOrgService({ orgs: [{ id: 'org1' }] });
    expect(await userHasAnyCredentials('user1', 'autotask', svc, org)).toBe(false);
  });

  it('returns true when org-level credentials exist and user has access', async () => {
    const svc = makeCredService({ orgCred: creds });
    const org = makeOrgService({ orgs: [{ id: 'org1' }], hasServerAccess: true });
    expect(await userHasAnyCredentials('user1', 'autotask', svc, org)).toBe(true);
  });

  it('returns false when org-level credentials exist but user has no server access', async () => {
    const svc = makeCredService({ orgCred: creds });
    const org = makeOrgService({ orgs: [{ id: 'org1' }], hasServerAccess: false });
    expect(await userHasAnyCredentials('user1', 'autotask', svc, org)).toBe(false);
  });

  it('returns true when exactly one team credential exists and user has access', async () => {
    const svc = makeCredService({ teamCred: creds });
    const org = makeOrgService({
      orgs: [{ id: 'org1' }],
      teams: [{ id: 'team1' }],
      hasServerAccess: true,
    });
    expect(await userHasAnyCredentials('user1', 'autotask', svc, org)).toBe(true);
  });

  it('falls through to org tier when >1 team has credentials (ambiguous)', async () => {
    const svc = {
      has: vi.fn().mockResolvedValue(false),
      getOrgCredential: vi.fn().mockResolvedValue(creds),
      // Both team1 and team2 hold a credential → 2 hits → ambiguous.
      getTeamCredentialsForTeams: vi.fn().mockResolvedValue([
        { teamId: 'team1', creds },
        { teamId: 'team2', creds },
      ]),
    };
    const org = makeOrgService({
      orgs: [{ id: 'org1' }],
      teams: [{ id: 'team1' }, { id: 'team2' }],
      hasServerAccess: true,
    });
    // >1 team hits → skip team tier, land on org tier → true
    expect(await userHasAnyCredentials('user1', 'autotask', svc, org)).toBe(true);
  });

  it('returns false when orgService is not provided', async () => {
    const svc = makeCredService({ orgCred: creds });
    expect(await userHasAnyCredentials('user1', 'autotask', svc)).toBe(false);
  });
});
