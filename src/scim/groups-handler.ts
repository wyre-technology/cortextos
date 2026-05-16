/**
 * SCIM /Groups handler — Group <-> org_teams.
 *
 * Membership writes (`org_team_members`) use `connection.createdBy` for the
 * required `added_by` / `created_by` columns so audit trails point back to
 * the human admin who set up the SCIM connection.
 *
 * Tenant + reseller scope: org_teams.org_id accepts any organization, so the
 * same handler works for both. Teams live on whichever org the connection
 * binds to.
 */

import { nanoid } from 'nanoid';
import type postgres from 'postgres';
import { getSql, type Sql } from '../db/context.js';
import { scimPatch } from 'scim-patch';
import {
  scimGroupCreateSchema,
  scimPatchSchema,
  scimError,
} from './types.js';
import type { ScimConnection } from './types.js';
import { parseFilter, UnsupportedFilterError } from './filter.js';
import { normalizePatch } from './idp-quirks.js';
import {
  serializeGroup,
  listResponse,
  type InternalTeam,
} from './serializer.js';

const TEAM_COLS = `id, org_id, name, external_id, scim_connection_id, created_at`;

type TeamRow = InternalTeam;

interface MemberRefRow {
  user_id: string;
  email: string;
}

export class ScimGroupsHandler {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  // -------------------------------------------------------------------------
  // GET /Groups
  // -------------------------------------------------------------------------
  async list(
    connection: ScimConnection,
    opts: { filter?: string; startIndex?: number; count?: number },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const startIndex = Math.max(1, opts.startIndex ?? 1);
    const count = Math.min(200, Math.max(0, opts.count ?? 100));

    let attrFragment: postgres.PendingQuery<postgres.Row[]> | null = null;
    if (opts.filter) {
      let parsed;
      try {
        parsed = parseFilter(opts.filter);
      } catch (err) {
        if (err instanceof UnsupportedFilterError) {
          return { status: 400, body: scimError(400, err.message, 'invalidFilter') };
        }
        throw err;
      }
      // Map userName -> displayName at the Group resource level.
      attrFragment =
        parsed.attribute === 'userName'
          ? this.sql`AND t.name = ${parsed.value}`
          : this.sql`AND t.external_id = ${parsed.value}`;
    }

    const cols = this.sql.unsafe(TEAM_COLS);
    const [rows, totalRow] = await Promise.all([
      this.sql<TeamRow[]>`
        SELECT ${cols} FROM org_teams t
         WHERE t.org_id = ${connection.orgId}
           ${attrFragment ?? this.sql``}
         ORDER BY t.created_at
         OFFSET ${startIndex - 1} LIMIT ${count}
      `,
      this.sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM org_teams t
         WHERE t.org_id = ${connection.orgId}
           ${attrFragment ?? this.sql``}
      `,
    ]);

    const memberMap = await this.fetchMembersFor(rows.map((r) => r.id));
    return {
      status: 200,
      body: listResponse(
        rows.map((t) => serializeGroup(t, connection, memberMap.get(t.id) ?? [])),
        totalRow[0]?.c ?? rows.length,
        startIndex,
        rows.length,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // GET /Groups/:id
  // -------------------------------------------------------------------------
  async getById(
    connection: ScimConnection,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const team = await this.fetchTeamInScope(connection, id);
    if (!team) return { status: 404, body: scimError(404, 'Group not found') };
    const members = (await this.fetchMembersFor([id])).get(id) ?? [];
    return { status: 200, body: serializeGroup(team, connection, members) };
  }

  // -------------------------------------------------------------------------
  // POST /Groups
  // -------------------------------------------------------------------------
  async create(
    connection: ScimConnection,
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = scimGroupCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: scimError(400, parsed.error.message, 'invalidSyntax') };
    }
    if (!connection.createdBy) {
      // org_teams.created_by is NOT NULL — we need a real user to attribute.
      return {
        status: 500,
        body: scimError(500, 'SCIM connection has no created_by; cannot create groups'),
      };
    }
    const payload = parsed.data;
    const id = `team_${nanoid()}`;

    return await this.sql.begin(async (tx) => {
      const inserted = await tx<TeamRow[]>`
        INSERT INTO org_teams
          (id, org_id, name, external_id, scim_connection_id, created_by)
        VALUES
          (${id}, ${connection.orgId}, ${payload.displayName},
           ${payload.externalId ?? null}, ${connection.id}, ${connection.createdBy!})
        ON CONFLICT (org_id, name) DO UPDATE SET
          external_id = EXCLUDED.external_id,
          scim_connection_id = EXCLUDED.scim_connection_id
        RETURNING ${tx.unsafe(TEAM_COLS)}
      `;
      const team = inserted[0];

      const memberRefs = payload.members ?? [];
      if (memberRefs.length > 0) {
        await this.addMembers(tx, connection, team.id, memberRefs.map((m) => m.value));
      }

      const members = (await this.fetchMembersFor([team.id], tx)).get(team.id) ?? [];
      return { status: 201, body: serializeGroup(team, connection, members) };
    });
  }

  // -------------------------------------------------------------------------
  // PUT /Groups/:id  — full replace.
  // -------------------------------------------------------------------------
  async replace(
    connection: ScimConnection,
    id: string,
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = scimGroupCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: scimError(400, parsed.error.message, 'invalidSyntax') };
    }
    const team = await this.fetchTeamInScope(connection, id);
    if (!team) return { status: 404, body: scimError(404, 'Group not found') };
    const payload = parsed.data;

    return await this.sql.begin(async (tx) => {
      const updated = await tx<TeamRow[]>`
        UPDATE org_teams
           SET name        = ${payload.displayName},
               external_id = ${payload.externalId ?? null}
         WHERE id = ${id}
         RETURNING ${tx.unsafe(TEAM_COLS)}
      `;

      // Replace member set.
      await tx`DELETE FROM org_team_members WHERE team_id = ${id}`;
      const memberRefs = payload.members ?? [];
      if (memberRefs.length > 0) {
        await this.addMembers(tx, connection, id, memberRefs.map((m) => m.value));
      }

      const members = (await this.fetchMembersFor([id], tx)).get(id) ?? [];
      return { status: 200, body: serializeGroup(updated[0], connection, members) };
    });
  }

  // -------------------------------------------------------------------------
  // PATCH /Groups/:id
  //
  // The hot path is `Add`/`Remove` on `members` — Entra never PUTs full
  // group resources. We special-case those before falling through to the
  // generic scim-patch applier so we don't have to round-trip the entire
  // group representation through pure-JSON patching.
  // -------------------------------------------------------------------------
  async patch(
    connection: ScimConnection,
    id: string,
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = scimPatchSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: scimError(400, parsed.error.message, 'invalidSyntax') };
    }
    const team = await this.fetchTeamInScope(connection, id);
    if (!team) return { status: 404, body: scimError(404, 'Group not found') };

    const normalized = normalizePatch(parsed.data, connection.idpType);
    const memberOps = normalized.Operations.filter((op) => isMemberOp(op));
    const otherOps = normalized.Operations.filter((op) => !isMemberOp(op));

    return await this.sql.begin(async (tx) => {
      // 1. Apply member-targeted ops directly.
      for (const op of memberOps) {
        await this.applyMemberOp(tx, connection, id, op);
      }

      // 2. Apply non-member ops (displayName, externalId) via scim-patch.
      let mutated = team;
      if (otherOps.length > 0) {
        const before = serializeGroup(mutated, connection, []);
        let after: Record<string, unknown>;
        try {
          after = scimPatch(before as never, otherOps as never) as Record<string, unknown>;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'PATCH failed';
          throw new ScimPatchError(msg);
        }
        const updated = await tx<TeamRow[]>`
          UPDATE org_teams
             SET name = ${(after.displayName as string) ?? mutated.name},
                 external_id = ${(after.externalId as string) ?? mutated.external_id}
           WHERE id = ${id}
           RETURNING ${tx.unsafe(TEAM_COLS)}
        `;
        mutated = updated[0];
      }

      const members = (await this.fetchMembersFor([id], tx)).get(id) ?? [];
      return { status: 200, body: serializeGroup(mutated, connection, members) };
    }).catch((err: unknown) => {
      if (err instanceof ScimPatchError) {
        return { status: 400, body: scimError(400, err.message, 'invalidPath') };
      }
      throw err;
    });
  }

  // -------------------------------------------------------------------------
  // DELETE /Groups/:id  — hard-delete the team. org_team_members cascades.
  // -------------------------------------------------------------------------
  async delete(
    connection: ScimConnection,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const team = await this.fetchTeamInScope(connection, id);
    if (!team) return { status: 404, body: scimError(404, 'Group not found') };
    await this.sql`DELETE FROM org_teams WHERE id = ${id}`;
    return { status: 204, body: null };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async fetchTeamInScope(
    connection: ScimConnection,
    id: string,
  ): Promise<TeamRow | null> {
    const cols = this.sql.unsafe(TEAM_COLS);
    const rows = await this.sql<TeamRow[]>`
      SELECT ${cols} FROM org_teams t
       WHERE t.id = ${id} AND t.org_id = ${connection.orgId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async fetchMembersFor(
    teamIds: string[],
    tx?: postgres.TransactionSql,
  ): Promise<Map<string, MemberRefRow[]>> {
    if (teamIds.length === 0) return new Map();
    const sql = tx ?? this.sql;
    const rows = await sql<{ team_id: string; user_id: string; email: string }[]>`
      SELECT tm.team_id, tm.user_id, u.email
        FROM org_team_members tm
        JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id IN ${sql(teamIds)}
       ORDER BY tm.added_at
    `;
    const map = new Map<string, MemberRefRow[]>();
    for (const r of rows) {
      const list = map.get(r.team_id) ?? [];
      list.push({ user_id: r.user_id, email: r.email });
      map.set(r.team_id, list);
    }
    return map;
  }

  private async addMembers(
    tx: postgres.TransactionSql,
    connection: ScimConnection,
    teamId: string,
    userIds: string[],
  ): Promise<void> {
    const addedBy = connection.createdBy!;
    for (const userId of userIds) {
      await tx`
        INSERT INTO org_team_members (id, team_id, org_id, user_id, added_by)
        VALUES (${nanoid()}, ${teamId}, ${connection.orgId}, ${userId}, ${addedBy})
        ON CONFLICT (team_id, user_id) DO NOTHING
      `;
    }
  }

  private async applyMemberOp(
    tx: postgres.TransactionSql,
    connection: ScimConnection,
    teamId: string,
    op: { op: string; path?: string; value?: unknown },
  ): Promise<void> {
    const opName = op.op.toLowerCase();
    if (opName === 'add') {
      const refs = extractMemberRefs(op.value);
      if (refs.length > 0) {
        await this.addMembers(tx, connection, teamId, refs);
      }
    } else if (opName === 'remove') {
      // Entra paths: members[value eq "<id>"]  or  members
      const idFromPath = matchMemberValueFromPath(op.path);
      if (idFromPath) {
        await tx`
          DELETE FROM org_team_members
           WHERE team_id = ${teamId} AND user_id = ${idFromPath}
        `;
      } else if (op.path === 'members' || !op.path) {
        // bulk wipe (Okta sometimes sends this)
        await tx`DELETE FROM org_team_members WHERE team_id = ${teamId}`;
      }
    } else if (opName === 'replace') {
      const refs = extractMemberRefs(op.value);
      await tx`DELETE FROM org_team_members WHERE team_id = ${teamId}`;
      if (refs.length > 0) {
        await this.addMembers(tx, connection, teamId, refs);
      }
    }
  }
}

class ScimPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScimPatchError';
  }
}

function isMemberOp(op: { path?: string }): boolean {
  if (!op.path) return false;
  return op.path === 'members' || op.path.startsWith('members[');
}

function extractMemberRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v && typeof v === 'object' && 'value' in v ? (v as { value: string }).value : null))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const MEMBER_PATH_RE = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i;
function matchMemberValueFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const m = path.match(MEMBER_PATH_RE);
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}
