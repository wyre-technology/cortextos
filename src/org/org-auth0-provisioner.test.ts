import { describe, it, expect, vi } from 'vitest';
import { createAuth0OrgProvisioner } from './org-auth0-provisioner.js';
import type { Auth0ManagementClient } from '../auth/auth0-management.js';

/**
 * Multi-IdP foundation slice 3 — unit tests for createAuth0OrgProvisioner
 * (the seam between OrgService.createOrg and the Auth0ManagementClient).
 *
 * BOTH-OR-NEITHER semantics live in OrgService.createOrg + are tested
 * there. This file locks the wire-format the seam emits to Auth0 (org
 * name derivation, metadata fields, rollback signature).
 */

function fakeClient(overrides: Partial<Auth0ManagementClient> = {}): Auth0ManagementClient {
  return {
    createOrganization: vi.fn().mockResolvedValue({ id: 'org_auth0_default' }),
    enableConnection: vi.fn().mockResolvedValue(undefined),
    deleteOrganization: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Auth0ManagementClient;
}

describe('createAuth0OrgProvisioner', () => {
  it('returns null when the Auth0ManagementClient is null (no-M2M-creds path)', () => {
    expect(createAuth0OrgProvisioner(null)).toBeNull();
  });

  it('returns a { provisioner, rollback } pair when the client is configured', () => {
    const pair = createAuth0OrgProvisioner(fakeClient());
    expect(pair).not.toBeNull();
    expect(typeof pair!.provisioner).toBe('function');
    expect(typeof pair!.rollback).toBe('function');
  });

  describe('provisioner', () => {
    it('derives Auth0 org name as `conduit-<lowercased-orgId>` (Auth0 alphanumeric+hyphen requirement)', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'org_auth0_xyz' });
      const client = fakeClient({ createOrganization: create as never });
      const { provisioner } = createAuth0OrgProvisioner(client)!;
      await provisioner({ orgId: 'abc123XYZ', orgName: 'Acme', orgType: 'standalone' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'conduit-abc123xyz' }),
      );
    });

    it('strips underscores from orgId in the Auth0 name (nanoid alphabet includes _; Auth0 does not)', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'org_auth0_xyz' });
      const client = fakeClient({ createOrganization: create as never });
      const { provisioner } = createAuth0OrgProvisioner(client)!;
      await provisioner({ orgId: 'a_b_c_1_2_3', orgName: 'Acme', orgType: 'standalone' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'conduit-a-b-c-1-2-3' }),
      );
    });

    it('passes display_name verbatim + stamps conduit metadata for ops-side round-trip', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'org_auth0_xyz' });
      const client = fakeClient({ createOrganization: create as never });
      const { provisioner } = createAuth0OrgProvisioner(client)!;
      await provisioner({ orgId: 'abc', orgName: 'Acme Corp', orgType: 'reseller' });
      expect(create).toHaveBeenCalledWith({
        name: 'conduit-abc',
        displayName: 'Acme Corp',
        metadata: {
          conduit_org_id: 'abc',
          conduit_org_type: 'reseller',
        },
      });
    });

    it('returns the Auth0 id verbatim for createOrg to persist on organizations.auth0_org_id', async () => {
      const client = fakeClient({
        createOrganization: vi.fn().mockResolvedValue({ id: 'org_auth0_xyz' }) as never,
      });
      const { provisioner } = createAuth0OrgProvisioner(client)!;
      const result = await provisioner({
        orgId: 'abc',
        orgName: 'Acme',
        orgType: 'standalone',
      });
      expect(result).toEqual({ auth0OrgId: 'org_auth0_xyz' });
    });

    it('propagates client.createOrganization errors (no swallowing — BOTH-OR-NEITHER needs the throw)', async () => {
      const client = fakeClient({
        createOrganization: vi.fn().mockRejectedValue(new Error('Auth0 503')) as never,
      });
      const { provisioner } = createAuth0OrgProvisioner(client)!;
      await expect(
        provisioner({ orgId: 'abc', orgName: 'Acme', orgType: 'standalone' }),
      ).rejects.toThrow('Auth0 503');
    });
  });

  describe('rollback', () => {
    it('calls client.deleteOrganization with the Auth0 org id', async () => {
      const del = vi.fn().mockResolvedValue(undefined);
      const client = fakeClient({ deleteOrganization: del as never });
      const { rollback } = createAuth0OrgProvisioner(client)!;
      await rollback('org_auth0_xyz');
      expect(del).toHaveBeenCalledWith('org_auth0_xyz');
    });

    it('propagates client.deleteOrganization errors (OrgService.createOrg logs + swallows)', async () => {
      const client = fakeClient({
        deleteOrganization: vi.fn().mockRejectedValue(new Error('Auth0 500')) as never,
      });
      const { rollback } = createAuth0OrgProvisioner(client)!;
      await expect(rollback('org_auth0_xyz')).rejects.toThrow('Auth0 500');
    });
  });
});
