import { describe, it, expect } from 'vitest';
import { tierForOrgRole } from './caller-tier.js';
import type { OrgRole } from '../org/org-service.js';

describe('tierForOrgRole — boss-locked mapping (Phase-2 dispatch 1781788686408)', () => {
  it('owner → admin', () => {
    expect(tierForOrgRole('owner')).toBe('admin');
  });

  it('admin → admin', () => {
    expect(tierForOrgRole('admin')).toBe('admin');
  });

  it('member → write', () => {
    expect(tierForOrgRole('member')).toBe('write');
  });

  it('null → null (FAIL-CLOSED — unresolvable caller never silently maps to read)', () => {
    expect(tierForOrgRole(null)).toBeNull();
  });

  it('undefined → null (FAIL-CLOSED)', () => {
    expect(tierForOrgRole(undefined)).toBeNull();
  });

  it('unknown role string → null (FAIL-CLOSED — future OrgRole additions are denied until explicitly mapped)', () => {
    // Cast to OrgRole simulates a runtime value not in the type. The exhaustive
    // switch's default-branch is what enforces fail-closed for new roles added
    // to the OrgRole union without a matching mapping here.
    expect(tierForOrgRole('superuser' as OrgRole)).toBeNull();
  });
});
