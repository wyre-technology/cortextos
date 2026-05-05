/**
 * SCIM <-> internal model serialization.
 *
 * Internal users row shape (after migrations 016):
 *   id, email, name, first_name, last_name, display_name,
 *   external_id, active, deactivated_at, created_at, last_login
 *
 * Internal org_teams row shape (after migration 016):
 *   id, org_id, name, description, external_id, scim_connection_id, ...
 */

import type { ScimConnection } from './types.js';

// ---------------------------------------------------------------------------
// Domain rows (subset we need; mirrors what the queries actually SELECT)
// ---------------------------------------------------------------------------

export interface InternalUser {
  id: string;
  email: string;
  external_id: string | null;
  active: boolean;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  created_at: string;
  last_login: string | null;
}

export interface InternalTeam {
  id: string;
  org_id: string;
  name: string;
  external_id: string | null;
  scim_connection_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function userLocation(connection: ScimConnection, userId: string): string {
  const prefix = connection.scope === 'tenant' ? 't' : 'r';
  return `/scim/v2/${prefix}/${connection.orgId}/Users/${encodeURIComponent(userId)}`;
}

function groupLocation(connection: ScimConnection, groupId: string): string {
  const prefix = connection.scope === 'tenant' ? 't' : 'r';
  return `/scim/v2/${prefix}/${connection.orgId}/Groups/${encodeURIComponent(groupId)}`;
}

export function serializeUser(
  user: InternalUser,
  connection: ScimConnection,
  members: Array<{ team_id: string; team_name: string }> = [],
): Record<string, unknown> {
  const givenName = user.first_name ?? undefined;
  const familyName = user.last_name ?? undefined;
  const composed = [givenName, familyName].filter(Boolean).join(' ');
  const formatted = user.display_name ?? (composed.length > 0 ? composed : undefined);

  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    externalId: user.external_id ?? undefined,
    userName: user.email,
    active: user.active,
    name:
      givenName || familyName || formatted
        ? { givenName, familyName, formatted }
        : undefined,
    displayName: user.display_name ?? formatted,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    groups: members.map((m) => ({ value: m.team_id, display: m.team_name })),
    meta: {
      resourceType: 'User',
      created: user.created_at,
      lastModified: user.last_login ?? user.created_at,
      location: userLocation(connection, user.id),
    },
  };
}

export function serializeGroup(
  team: InternalTeam,
  connection: ScimConnection,
  members: Array<{ user_id: string; email: string }> = [],
): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: team.id,
    externalId: team.external_id ?? undefined,
    displayName: team.name,
    members: members.map((m) => ({
      value: m.user_id,
      display: m.email,
      type: 'User',
    })),
    meta: {
      resourceType: 'Group',
      created: team.created_at,
      lastModified: team.created_at,
      location: groupLocation(connection, team.id),
    },
  };
}

export function listResponse(
  resources: Array<Record<string, unknown>>,
  totalResults: number,
  startIndex: number,
  itemsPerPage: number,
): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}
