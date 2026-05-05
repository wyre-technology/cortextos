/**
 * SCIM 2.0 Fastify plugin.
 *
 * Routes:
 *   /scim/v2/ServiceProviderConfig          (no auth — discovery)
 *   /scim/v2/ResourceTypes                  (no auth — discovery)
 *   /scim/v2/Schemas                        (no auth — discovery)
 *   /scim/v2/{t|r}/:orgId/Users[…]          (bearer auth, scope-bound)
 *   /scim/v2/{t|r}/:orgId/Groups[…]         (bearer auth, scope-bound; later)
 *
 * The `t|r` prefix selects the scope (tenant vs reseller). The bearer token
 * is the source of truth for org/scope; the path component is a defense-in-
 * depth check — token-vs-path mismatch returns 401 (not 403, to avoid
 * leaking that the token is valid for *some* org).
 */

import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import type postgres from 'postgres';

import { ScimConnectionsService } from './connections-service.js';
import { ScimUsersHandler } from './users-handler.js';
import { ScimGroupsHandler } from './groups-handler.js';
import { resourceTypes, schemas, serviceProviderConfig } from './discovery.js';
import type { ScimConnection, ScimScope } from './types.js';
import { scimError } from './types.js';

const SCIM_CONTENT_TYPE = 'application/scim+json';

interface ScimPluginOptions extends FastifyPluginOptions {
  sql: postgres.Sql;
}

declare module 'fastify' {
  interface FastifyRequest {
    scimConnection?: ScimConnection;
  }
}

function sendScim(
  reply: FastifyReply,
  status: number,
  body: Record<string, unknown> | null,
): FastifyReply {
  reply.header('content-type', SCIM_CONTENT_TYPE);
  reply.status(status);
  return body === null ? reply.send() : reply.send(body);
}

export const scimPlugin = (opts: ScimPluginOptions) =>
  fp(async function plugin(app: FastifyInstance): Promise<void> {
    const sql = opts.sql;
    const connections = new ScimConnectionsService(sql);
    const users = new ScimUsersHandler(sql);
    const groups = new ScimGroupsHandler(sql);

    // -----------------------------------------------------------------------
    // Discovery (unauthenticated; no tenant context)
    // -----------------------------------------------------------------------
    app.get('/scim/v2/ServiceProviderConfig', async (_req, reply) =>
      sendScim(reply, 200, serviceProviderConfig as unknown as Record<string, unknown>),
    );
    app.get('/scim/v2/ResourceTypes', async (_req, reply) =>
      sendScim(reply, 200, resourceTypes as unknown as Record<string, unknown>),
    );
    app.get('/scim/v2/Schemas', async (_req, reply) =>
      sendScim(reply, 200, schemas as unknown as Record<string, unknown>),
    );

    // -----------------------------------------------------------------------
    // Bearer-token auth + scope/orgId binding
    // -----------------------------------------------------------------------
    async function authenticate(
      req: FastifyRequest<{ Params: { scope: 't' | 'r'; orgId: string } }>,
      reply: FastifyReply,
    ): Promise<ScimConnection | null> {
      const auth = req.headers.authorization ?? '';
      if (!auth.toLowerCase().startsWith('bearer ')) {
        sendScim(reply, 401, scimError(401, 'Bearer token required'));
        return null;
      }
      const token = auth.slice(7).trim();
      if (!token) {
        sendScim(reply, 401, scimError(401, 'Bearer token required'));
        return null;
      }

      const connection = await connections.verifyToken(token);
      if (!connection) {
        sendScim(reply, 401, scimError(401, 'Invalid token'));
        return null;
      }

      const expectedScope: ScimScope = req.params.scope === 't' ? 'tenant' : 'reseller';
      if (connection.scope !== expectedScope || connection.orgId !== req.params.orgId) {
        // Deliberately 401, not 403 — never confirm that the token is valid
        // for *some* org while the path is wrong.
        sendScim(reply, 401, scimError(401, 'Invalid token'));
        return null;
      }

      req.scimConnection = connection;
      return connection;
    }

    // -----------------------------------------------------------------------
    // /Users routes
    //
    // The path is the same for tenant and reseller scope; we register two
    // mounts that share handlers.
    // -----------------------------------------------------------------------
    type UsersParams = { scope: 't' | 'r'; orgId: string; id?: string };

    app.get<{ Params: UsersParams; Querystring: { filter?: string; startIndex?: string; count?: string } }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.list(conn, {
          filter: req.query.filter,
          startIndex: req.query.startIndex ? parseInt(req.query.startIndex, 10) : undefined,
          count: req.query.count ? parseInt(req.query.count, 10) : undefined,
        });
        return sendScim(reply, status, body);
      },
    );

    app.get<{ Params: Required<UsersParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.getById(conn, req.params.id);
        return sendScim(reply, status, body);
      },
    );

    app.post<{ Params: UsersParams }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.create(conn, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.put<{ Params: Required<UsersParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.replace(conn, req.params.id, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.patch<{ Params: Required<UsersParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.patch(conn, req.params.id, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.delete<{ Params: Required<UsersParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Users/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await users.delete(conn, req.params.id);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    // -----------------------------------------------------------------------
    // /Groups routes
    // -----------------------------------------------------------------------
    type GroupsParams = { scope: 't' | 'r'; orgId: string; id?: string };

    app.get<{ Params: GroupsParams; Querystring: { filter?: string; startIndex?: string; count?: string } }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.list(conn, {
          filter: req.query.filter,
          startIndex: req.query.startIndex ? parseInt(req.query.startIndex, 10) : undefined,
          count: req.query.count ? parseInt(req.query.count, 10) : undefined,
        });
        return sendScim(reply, status, body);
      },
    );

    app.get<{ Params: Required<GroupsParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.getById(conn, req.params.id);
        return sendScim(reply, status, body);
      },
    );

    app.post<{ Params: GroupsParams }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.create(conn, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.put<{ Params: Required<GroupsParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.replace(conn, req.params.id, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.patch<{ Params: Required<GroupsParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.patch(conn, req.params.id, req.body);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );

    app.delete<{ Params: Required<GroupsParams> }>(
      '/scim/v2/:scope(^[tr]$)/:orgId/Groups/:id',
      async (req, reply) => {
        const conn = await authenticate(req, reply);
        if (!conn) return reply;
        const { status, body } = await groups.delete(conn, req.params.id);
        await connections.recordSyncSuccess(conn.id);
        return sendScim(reply, status, body);
      },
    );
  });
