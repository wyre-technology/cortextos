import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock requireAuth0
// ---------------------------------------------------------------------------

const mockRequireAuth0 = vi.fn();

vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = { sub: 'user-1', email: 'test@example.com', name: 'Test User' };

const PROFILE_ROW = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  first_name: 'Test',
  last_name: 'User',
  display_name: null as string | null,
};

function authenticateAs(user = TEST_USER): void {
  mockRequireAuth0.mockReturnValue(user);
}

function unauthenticated(): void {
  mockRequireAuth0.mockImplementation(
    (_request: unknown, reply: { redirect: (url: string, code: number) => void }) => {
      reply.redirect('/auth/login', 302);
      return null;
    },
  );
}

function createMockSql(rows: Record<string, unknown>[] = [PROFILE_ROW]) {
  const sqlFn = vi.fn().mockResolvedValue(rows);
  // Tagged template literal support: postgres.js uses sql`...` syntax
  const taggedFn = (...args: unknown[]) => {
    // When called as tagged template literal, first arg is template strings array
    if (Array.isArray(args[0])) {
      return sqlFn(...args);
    }
    return sqlFn(...args);
  };
  // Make it callable as both a function and tagged template
  return Object.assign(taggedFn, { mockResolvedValue: sqlFn.mockResolvedValue.bind(sqlFn), _fn: sqlFn }) as unknown;
}

async function buildApp(mockSql?: unknown): Promise<FastifyInstance> {
  const { profileRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  await app.register(profileRoutes({ sql: (mockSql ?? createMockSql()) as any }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profileRoutes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.resetModules();
    mockRequireAuth0.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /api/profile
  // -------------------------------------------------------------------------

  describe('GET /api/profile', () => {
    it('returns the user profile', async () => {
      authenticateAs();
      app = await buildApp();

      const response = await app.inject({
        method: 'GET',
        url: '/api/profile',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe('user-1');
      expect(body.email).toBe('test@example.com');
      expect(body.firstName).toBe('Test');
      expect(body.lastName).toBe('User');
      expect(body.displayName).toBeNull();
    });

    it('returns 404 when user not found in database', async () => {
      authenticateAs();
      app = await buildApp(createMockSql([]));

      const response = await app.inject({
        method: 'GET',
        url: '/api/profile',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('User not found');
    });

    it('redirects to login when not authenticated', async () => {
      unauthenticated();
      app = await buildApp();

      const response = await app.inject({
        method: 'GET',
        url: '/api/profile',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/auth/login');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/profile
  // -------------------------------------------------------------------------

  describe('PATCH /api/profile', () => {
    it('updates profile fields and returns updated profile', async () => {
      authenticateAs();
      const updatedRow = { ...PROFILE_ROW, first_name: 'Updated', last_name: 'Name' };
      const mockSql = createMockSql([updatedRow]);
      app = await buildApp(mockSql);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/profile',
        payload: { firstName: 'Updated', lastName: 'Name' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.firstName).toBe('Updated');
      expect(body.lastName).toBe('Name');
    });

    it('returns 400 when no fields are provided', async () => {
      authenticateAs();
      app = await buildApp();

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/profile',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('At least one field is required');
    });

    it('allows updating only displayName', async () => {
      authenticateAs();
      const updatedRow = { ...PROFILE_ROW, display_name: 'My Display Name' };
      const mockSql = createMockSql([updatedRow]);
      app = await buildApp(mockSql);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/profile',
        payload: { displayName: 'My Display Name' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().displayName).toBe('My Display Name');
    });

    it('redirects to login when not authenticated', async () => {
      unauthenticated();
      app = await buildApp();

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/profile',
        payload: { firstName: 'Test' },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/auth/login');
    });
  });
});
