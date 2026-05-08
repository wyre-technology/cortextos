import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getRequestBaseUrl } from './base-url.js';

function mockRequest(host: string, proto = 'https'): FastifyRequest {
  return {
    headers: { host, 'x-forwarded-proto': proto },
    protocol: proto,
  } as unknown as FastifyRequest;
}

describe('getRequestBaseUrl', () => {
  const allowed = ['mcp.wyre.ai', 'mcp.wyretechnology.com', 'localhost:8080'];

  it('returns https://host for an allowed host', () => {
    expect(getRequestBaseUrl(mockRequest('mcp.wyre.ai'), allowed)).toBe('https://mcp.wyre.ai');
    expect(getRequestBaseUrl(mockRequest('mcp.wyretechnology.com'), allowed)).toBe('https://mcp.wyretechnology.com');
  });

  it('respects x-forwarded-proto for localhost http', () => {
    expect(getRequestBaseUrl(mockRequest('localhost:8080', 'http'), allowed)).toBe('http://localhost:8080');
  });

  it('falls back to the first allowed host for an unknown Host header', () => {
    expect(getRequestBaseUrl(mockRequest('attacker.example'), allowed)).toBe('https://mcp.wyre.ai');
  });

  it('falls back when Host header is missing', () => {
    const req = { headers: {}, protocol: 'https' } as unknown as FastifyRequest;
    expect(getRequestBaseUrl(req, allowed)).toBe('https://mcp.wyre.ai');
  });
});