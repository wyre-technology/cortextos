import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { waitlistRoutes } from './routes.js';
import { enterTestContext } from '../db/context.js';

function createMockSql() {
  const rows: Record<string, unknown>[] = [];

  // Tagged template function that mimics postgres.js
  const sql = vi.fn((...args: unknown[]) => {
    // Handle tagged template calls
    const strings = args[0] as TemplateStringsArray;
    if (Array.isArray(strings)) {
      const query = strings.join('?');

      if (query.includes('CREATE TABLE')) {
        return Promise.resolve([]);
      }
      if (query.includes('INSERT INTO waitlist')) {
        return Promise.resolve([]);
      }
      if (query.includes('SELECT COUNT')) {
        return Promise.resolve([{ count: rows.length }]);
      }
    }
    return Promise.resolve([]);
  }) as unknown as import('postgres').Sql;

  return { rows, sql };
}

describe('waitlist routes', () => {
  let app: ReturnType<typeof Fastify>;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(async () => {
    mockSql = createMockSql();
    app = Fastify();
    enterTestContext(mockSql.sql);
    await app.register(waitlistRoutes());
    await app.ready();
  });

  describe('POST /waitlist', () => {
    it('accepts a valid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/waitlist',
        payload: { email: 'test@example.com', name: 'Test User' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().message).toContain('on the list');
    });

    it('rejects missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/waitlist',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/waitlist',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid email address');
    });
  });

  describe('GET /waitlist', () => {
    it('returns an HTML signup page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/waitlist',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Join the Waitlist');
      expect(res.body).toContain('waitlistForm');
    });
  });

  describe('GET /waitlist/count', () => {
    it('returns the count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/waitlist/count',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('count');
    });
  });
});
