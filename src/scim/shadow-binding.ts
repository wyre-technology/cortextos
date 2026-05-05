/**
 * Shadow-id binding: on first SSO login for an email, promote a SCIM-created
 * `users.id LIKE 'shadow:%'` row to the IdP-supplied subject id.
 *
 * Called from src/auth/auth0.ts (and any future SSO callback) before the
 * user upsert.
 *
 * Strategy: the FKs into users(id) lack ON UPDATE CASCADE, so we cannot
 * just `UPDATE users SET id = sub`. Instead we INSERT a sibling row at
 * `sub`, re-point every users-referencing FK, then delete the shadow row.
 * `email` is parked under a sentinel so the UNIQUE(email) constraint frees
 * up between INSERT and DELETE.
 *
 * No-ops:
 *   - empty `email` (skip)
 *   - no shadow row (silent)
 *   - shadow id already equal to `sub` (idempotent)
 */

import type postgres from 'postgres';

/**
 * The FKs into `users.id` (org_members, org_team_members, reseller_members,
 * etc.) do not have ON UPDATE CASCADE — adding it would touch many existing
 * constraints. Instead, on bind we explicitly re-point each known reference,
 * then delete the shadow row.
 *
 * If a new FK to users(id) is added later without being listed here, the
 * final DELETE will fail loudly with a FK violation — that's intentional;
 * silent drift would be worse.
 */
const USER_REF_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'org_members', column: 'user_id' },
  { table: 'org_team_members', column: 'user_id' },
  { table: 'reseller_members', column: 'user_id' },
];

export async function bindShadowUserOnLogin(
  sql: postgres.Sql,
  sub: string,
  email: string,
): Promise<void> {
  if (!email) return;
  await sql.begin(async (tx) => {
    const shadow = await tx<{ id: string; email: string }[]>`
      SELECT id, email FROM users
       WHERE id LIKE 'shadow:%'
         AND lower(email) = lower(${email})
       LIMIT 1
    `;
    if (!shadow[0] || shadow[0].id === sub) return;
    const shadowId = shadow[0].id;
    const realEmail = shadow[0].email;

    // 1. Park the shadow's email under a sentinel so the UNIQUE(email)
    //    constraint frees up before we insert the new row.
    const parked = `${realEmail}::pending-unbind:${shadowId}`;
    await tx`UPDATE users SET email = ${parked} WHERE id = ${shadowId}`;

    // 2. Materialize the auth0 row (copy other profile fields from shadow).
    //    ON CONFLICT lets us skip when the user has logged in before.
    await tx`
      INSERT INTO users (id, email, name, first_name, last_name,
                         display_name, external_id, active, created_at, last_login)
      SELECT ${sub}, ${realEmail}, name, first_name, last_name,
             display_name, external_id, active, created_at, NOW()
        FROM users WHERE id = ${shadowId}
      ON CONFLICT (id) DO NOTHING
    `;

    // 3. Re-point every known FK from shadow -> sub.
    for (const { table, column } of USER_REF_TABLES) {
      await tx.unsafe(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [sub, shadowId],
      );
    }

    // 4. Drop the shadow row. FK violation here means a new users-ref FK
    //    was added without being listed in USER_REF_TABLES — fix the list.
    await tx`DELETE FROM users WHERE id = ${shadowId}`;
  });
}
