/**
 * Profile API routes — view and update the authenticated user's profile.
 *
 *   GET   /api/profile  — return current user profile
 *   PATCH /api/profile  — update profile fields (firstName, lastName, displayName)
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { requireAuth0 } from '../auth/auth0.js';

export interface ProfileRouteDeps {
  sql: postgres.Sql;
}

interface ProfileRow {
  id: string;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
}

interface ProfileResponse {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}

function toProfileResponse(row: ProfileRow): ProfileResponse {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
  };
}

export function profileRoutes(deps: ProfileRouteDeps) {
  const { sql } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // GET /api/profile
    app.get('/api/profile', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const rows = await sql<ProfileRow[]>`
        SELECT id, email, name, first_name, last_name, display_name
        FROM users
        WHERE id = ${user.sub}
      `;

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return toProfileResponse(rows[0]);
    });

    // PATCH /api/profile
    app.patch<{
      Body: { firstName?: string; lastName?: string; displayName?: string };
    }>('/api/profile', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const { firstName, lastName, displayName } = request.body ?? {};

      // Validate at least one field is provided
      if (firstName === undefined && lastName === undefined && displayName === undefined) {
        return reply.code(400).send({ error: 'At least one field is required (firstName, lastName, displayName)' });
      }

      // Build dynamic update
      const updates: Record<string, string | null> = {};
      if (firstName !== undefined) updates.first_name = firstName?.trim() || null;
      if (lastName !== undefined) updates.last_name = lastName?.trim() || null;
      if (displayName !== undefined) updates.display_name = displayName?.trim() || null;

      const setClauses = Object.entries(updates);
      if (setClauses.length === 0) {
        return reply.code(400).send({ error: 'At least one field is required (firstName, lastName, displayName)' });
      }

      // Use individual column updates since postgres.js doesn't support dynamic SET easily
      if (updates.first_name !== undefined) {
        await sql`UPDATE users SET first_name = ${updates.first_name} WHERE id = ${user.sub}`;
      }
      if (updates.last_name !== undefined) {
        await sql`UPDATE users SET last_name = ${updates.last_name} WHERE id = ${user.sub}`;
      }
      if (updates.display_name !== undefined) {
        await sql`UPDATE users SET display_name = ${updates.display_name} WHERE id = ${user.sub}`;
      }

      // Return updated profile
      const rows = await sql<ProfileRow[]>`
        SELECT id, email, name, first_name, last_name, display_name
        FROM users
        WHERE id = ${user.sub}
      `;

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return toProfileResponse(rows[0]);
    });
  };
}
