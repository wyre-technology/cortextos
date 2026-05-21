/**
 * SCIM /Users handler — same logic for tenant + reseller scope, branched on
 * `connection.scope` at the membership-write step.
 *
 * Tenant scope:
 *   POST /Users  -> upsert users + insert/update org_members(role=default)
 *   PATCH active=false -> users.active=false + DELETE org_members(user)
 *   DELETE       -> DELETE org_members(user); users row kept (idempotent
 *                   re-activation; preserves audit trail).
 *
 * Reseller scope:
 *   Same shape but writes reseller_members instead. Default role must be a
 *   reseller_* value (validated at connection-create time).
 *
 * Dedupe: lower(email) — prevents the case where Entra and Okta send the
 * same human with different case.
 */

import { nanoid } from 'nanoid';
import type postgres from 'postgres';
import { getSql, type Sql } from '../db/context.js';
import { scimPatch } from 'scim-patch';
import { notifyNewSignup } from '../billing/sales-notifier.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  scimUserCreateSchema,
  scimUserReplaceSchema,
  scimPatchSchema,
  scimError,
} from './types.js';
import type {
  ScimConnection,
  ScimUserCreatePayload,
} from './types.js';
import { parseFilter, UnsupportedFilterError } from './filter.js';
import { normalizePatch } from './idp-quirks.js';
import {
  serializeUser,
  listResponse,
  type InternalUser,
} from './serializer.js';

const USER_COLS = `id, email, external_id, active, first_name, last_name,
                   display_name, created_at, last_login`;

type UserRow = InternalUser;

export class ScimUsersHandler {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  // -------------------------------------------------------------------------
  // GET /Users  (with optional ?filter=)
  // -------------------------------------------------------------------------
  async list(
    connection: ScimConnection,
    opts: { filter?: string; startIndex?: number; count?: number },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const startIndex = Math.max(1, opts.startIndex ?? 1);
    const count = Math.min(200, Math.max(0, opts.count ?? 100));

    const memberFragment = this.membershipFragment(connection);

    let attrFragment: postgres.PendingQuery<postgres.Row[]> | null = null;
    if (opts.filter) {
      let parsed;
      try {
        parsed = parseFilter(opts.filter);
      } catch (err) {
        if (err instanceof UnsupportedFilterError) {
          return {
            status: 400,
            body: scimError(400, err.message, 'invalidFilter'),
          };
        }
        throw err;
      }
      attrFragment =
        parsed.attribute === 'userName'
          ? this.sql`AND lower(u.email) = lower(${parsed.value})`
          : this.sql`AND u.external_id = ${parsed.value}`;
    }

    const cols = this.sql.unsafe(USER_COLS);
    const [rows, totalRow] = await Promise.all([
      this.sql<UserRow[]>`
        SELECT ${cols} FROM users u
         WHERE ${memberFragment}
           ${attrFragment ?? this.sql``}
         ORDER BY u.created_at
         OFFSET ${startIndex - 1} LIMIT ${count}
      `,
      this.sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM users u
         WHERE ${memberFragment}
           ${attrFragment ?? this.sql``}
      `,
    ]);
    const total = totalRow[0]?.c ?? rows.length;

    return {
      status: 200,
      body: listResponse(
        rows.map((u) => serializeUser(u, connection)),
        total,
        startIndex,
        rows.length,
      ),
    };
  }

  /** Parameterized EXISTS fragment — user is a member of the connection's scope. */
  private membershipFragment(connection: ScimConnection): postgres.PendingQuery<postgres.Row[]> {
    return connection.scope === 'tenant'
      ? this.sql`EXISTS (SELECT 1 FROM org_members m
                          WHERE m.user_id = u.id AND m.org_id = ${connection.orgId})`
      : this.sql`EXISTS (SELECT 1 FROM reseller_members rm
                          WHERE rm.user_id = u.id AND rm.reseller_org_id = ${connection.orgId})`;
  }

  // -------------------------------------------------------------------------
  // GET /Users/:id
  // -------------------------------------------------------------------------
  async getById(
    connection: ScimConnection,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const user = await this.fetchUserInScope(connection, id);
    if (!user) return { status: 404, body: scimError(404, 'User not found') };
    return { status: 200, body: serializeUser(user, connection) };
  }

  // -------------------------------------------------------------------------
  // POST /Users  — create-or-attach.
  // -------------------------------------------------------------------------
  async create(
    connection: ScimConnection,
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = scimUserCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 400,
        body: scimError(400, parsed.error.message, 'invalidSyntax'),
      };
    }
    const payload = parsed.data;
    const email = primaryEmail(payload);
    if (!email) {
      return {
        status: 400,
        body: scimError(400, 'userName/emails missing', 'invalidValue'),
      };
    }

    return await this.sql.begin(async (tx) => {
      // 1. Look up existing user by lower(email).
      const existing = await tx<UserRow[]>`
        SELECT ${tx.unsafe(USER_COLS)} FROM users u
          WHERE lower(u.email) = lower(${email})
          LIMIT 1
      `;

      let user: UserRow;
      if (existing[0]) {
        user = existing[0];
        // Idempotent: refresh externalId/profile if the IdP now provides one.
        const updated = await tx<UserRow[]>`
          UPDATE users
             SET external_id  = COALESCE(${payload.externalId ?? null}, external_id),
                 first_name   = COALESCE(${payload.name?.givenName ?? null}, first_name),
                 last_name    = COALESCE(${payload.name?.familyName ?? null}, last_name),
                 display_name = COALESCE(${payload.displayName ?? null}, display_name),
                 active       = TRUE,
                 deactivated_at = NULL
           WHERE id = ${user.id}
           RETURNING ${tx.unsafe(USER_COLS)}
        `;
        user = updated[0];
      } else {
        // Shadow user: id = 'shadow:<nanoid>', bound to auth0 sub on first login.
        const newId = `shadow:${nanoid()}`;
        const inserted = await tx<UserRow[]>`
          INSERT INTO users
            (id, email, external_id, first_name, last_name, display_name, active)
          VALUES
            (${newId}, ${email}, ${payload.externalId ?? null},
             ${payload.name?.givenName ?? null},
             ${payload.name?.familyName ?? null},
             ${payload.displayName ?? null},
             ${payload.active ?? true})
          RETURNING ${tx.unsafe(USER_COLS)}
        `;
        user = inserted[0];
      }

      // 2. Attach membership in the connection's scope.
      await this.attachMembership(tx, connection, user.id, console);

      return {
        status: 201,
        body: serializeUser(user, connection),
      };
    });
  }

  // -------------------------------------------------------------------------
  // PUT /Users/:id  — full replace.
  // -------------------------------------------------------------------------
  async replace(
    connection: ScimConnection,
    id: string,
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = scimUserReplaceSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: scimError(400, parsed.error.message, 'invalidSyntax') };
    }
    const user = await this.fetchUserInScope(connection, id);
    if (!user) return { status: 404, body: scimError(404, 'User not found') };

    const payload = parsed.data;
    const email = primaryEmail(payload) ?? user.email;
    const nextActive = payload.active ?? true;
    const willDeactivate = nextActive === false && user.active;
    const willReactivate = nextActive === true && !user.active;
    // Stamp deactivated_at on the deactivation transition; clear it on
    // reactivation; otherwise leave the prior value untouched.
    const deactivatedAtFragment = willDeactivate
      ? this.sql`, deactivated_at = NOW()`
      : willReactivate
        ? this.sql`, deactivated_at = NULL`
        : this.sql``;

    return await this.sql.begin(async (tx) => {
      const cols = tx.unsafe(USER_COLS);
      const updated = await tx<UserRow[]>`
        UPDATE users
           SET email        = ${email},
               external_id  = ${payload.externalId ?? null},
               first_name   = ${payload.name?.givenName ?? null},
               last_name    = ${payload.name?.familyName ?? null},
               display_name = ${payload.displayName ?? null},
               active       = ${nextActive}
               ${deactivatedAtFragment}
         WHERE id = ${id}
         RETURNING ${cols}
      `;
      if (willDeactivate) {
        await this.detachMembership(tx, connection, id);
      } else if (willReactivate) {
        await this.attachMembership(tx, connection, id, console);
      }
      return { status: 200, body: serializeUser(updated[0], connection) };
    });
  }

  // -------------------------------------------------------------------------
  // PATCH /Users/:id  — apply ops via scim-patch, then reconcile.
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
    const user = await this.fetchUserInScope(connection, id);
    if (!user) return { status: 404, body: scimError(404, 'User not found') };

    const before = serializeUser(user, connection);
    const normalized = normalizePatch(parsed.data, connection.idpType);

    let after: Record<string, unknown>;
    try {
      after = scimPatch(before as never, normalized.Operations as never) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PATCH failed';
      return { status: 400, body: scimError(400, msg, 'invalidPath') };
    }

    // Re-run replace logic against the patched representation.
    return this.replace(connection, id, after);
  }

  // -------------------------------------------------------------------------
  // DELETE /Users/:id  — detach membership; keep users row for idempotent
  // re-activation. Hard-delete is reserved for future GC.
  // -------------------------------------------------------------------------
  async delete(
    connection: ScimConnection,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const user = await this.fetchUserInScope(connection, id);
    if (!user) return { status: 404, body: scimError(404, 'User not found') };

    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE users SET active = FALSE, deactivated_at = NOW() WHERE id = ${id}
      `;
      await this.detachMembership(tx, connection, id);
    });
    return { status: 204, body: null };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async fetchUserInScope(
    connection: ScimConnection,
    id: string,
  ): Promise<UserRow | null> {
    const cols = this.sql.unsafe(USER_COLS);
    const rows = await this.sql<UserRow[]>`
      SELECT ${cols} FROM users u
       WHERE u.id = ${id}
         AND ${this.membershipFragment(connection)}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async attachMembership(
    tx: postgres.TransactionSql,
    connection: ScimConnection,
    userId: string,
    log?: Pick<FastifyBaseLogger, 'warn'>,
  ): Promise<void> {
    if (connection.scope === 'tenant') {
      await tx`
        INSERT INTO org_members (id, org_id, user_id, role, joined_at)
        VALUES (${nanoid()}, ${connection.orgId}, ${userId},
                ${connection.defaultRole}, NOW())
        ON CONFLICT (org_id, user_id) DO NOTHING
      `;

      // Notify new signup for tenant scope only (not reseller_members)
      if (log) {
        void notifyNewSignup(tx, { userId, orgId: connection.orgId, isOwner: false }, log);
      }
    } else {
      await tx`
        INSERT INTO reseller_members
          (id, reseller_org_id, user_id, role, joined_at, created_at, updated_at)
        VALUES
          (${nanoid()}, ${connection.orgId}, ${userId},
           ${connection.defaultRole}, NOW(), NOW(), NOW())
        ON CONFLICT (reseller_org_id, user_id) DO NOTHING
      `;
    }
  }

  private async detachMembership(
    tx: postgres.TransactionSql,
    connection: ScimConnection,
    userId: string,
  ): Promise<void> {
    if (connection.scope === 'tenant') {
      await tx`
        DELETE FROM org_members
         WHERE org_id = ${connection.orgId} AND user_id = ${userId}
      `;
    } else {
      await tx`
        DELETE FROM reseller_members
         WHERE reseller_org_id = ${connection.orgId} AND user_id = ${userId}
      `;
    }
  }
}

function primaryEmail(payload: ScimUserCreatePayload): string | null {
  if (payload.userName && payload.userName.includes('@')) return payload.userName;
  const primary = payload.emails?.find((e: { primary?: boolean; value: string }) => e.primary)?.value;
  if (primary) return primary;
  const first = payload.emails?.[0]?.value;
  return first ?? null;
}
