import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { requireAdmin } from './admin-auth.js';

describe('requireAdmin — session-cookie path', () => {
  const original = {
    adminEmails: new Set(config.adminEmails),
    adminApiKey: config.adminApiKey,
  };

  beforeEach(() => {
    (config as { adminEmails: Set<string> }).adminEmails = new Set(['admin@example.com']);
    (config as { adminApiKey: string }).adminApiKey = '';
  });

  afterEach(() => {
    (config as { adminEmails: Set<string> }).adminEmails = original.adminEmails;
    (config as { adminApiKey: string }).adminApiKey = original.adminApiKey;
  });

  function fakeReq(opts: {
    auth0User?: { sub: string; email: string; name: string; emailVerified: boolean } | null;
  } = {}): FastifyRequest {
    return {
      headers: {},
      auth0User: opts.auth0User ?? null,
    } as unknown as FastifyRequest;
  }

  function fakeReply(): FastifyReply & { _status?: number; _payload?: unknown } {
    const r = {
      _status: undefined as number | undefined,
      _payload: undefined as unknown,
      code(s: number) {
        r._status = s;
        return r;
      },
      type() {
        return r;
      },
      send(p: unknown) {
        r._payload = p;
        return r;
      },
    };
    return r as unknown as FastifyReply & { _status?: number; _payload?: unknown };
  }

  it('rejects no session', () => {
    const req = fakeReq();
    const reply = fakeReply();
    expect(requireAdmin(req, reply)).toBe(false);
  });

  it('rejects allowlisted email when emailVerified is false (the actual security gate)', () => {
    const req = fakeReq({
      auth0User: { sub: 'auth0|x', email: 'admin@example.com', name: 'A', emailVerified: false },
    });
    const reply = fakeReply();
    expect(requireAdmin(req, reply)).toBe(false);
  });

  it('rejects allowlisted email when emailVerified is missing (legacy cookie)', () => {
    const req = fakeReq({
      // Simulate cookie that predates this PR (no emailVerified field).
      auth0User: {
        sub: 'auth0|x',
        email: 'admin@example.com',
        name: 'A',
      } as unknown as { sub: string; email: string; name: string; emailVerified: boolean },
    });
    const reply = fakeReply();
    expect(requireAdmin(req, reply)).toBe(false);
  });

  it('accepts allowlisted email when emailVerified is true', () => {
    const req = fakeReq({
      auth0User: { sub: 'auth0|x', email: 'admin@example.com', name: 'A', emailVerified: true },
    });
    const reply = fakeReply();
    expect(requireAdmin(req, reply)).toBe(true);
  });

  it('rejects non-allowlisted email even when verified', () => {
    const req = fakeReq({
      auth0User: { sub: 'auth0|x', email: 'attacker@evil.com', name: 'A', emailVerified: true },
    });
    const reply = fakeReply();
    expect(requireAdmin(req, reply)).toBe(false);
  });
});
