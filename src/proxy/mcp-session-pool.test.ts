import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpSessionPool } from './mcp-session-pool.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockInitResponse(sessionId: string | null) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['mcp-session-id', sessionId]]) as unknown as Headers & { get(key: string): string | null },
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
  };
}

describe('McpSessionPool', () => {
  let pool: McpSessionPool;

  beforeEach(() => {
    pool = new McpSessionPool();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('performs handshake on first call and caches session', async () => {
    // Initialize returns a session ID
    mockFetch
      .mockResolvedValueOnce(mockInitResponse('sess-abc'))
      .mockResolvedValueOnce({ ok: true }); // notifications/initialized

    const session = await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });

    expect(session.sessionId).toBe('sess-abc');
    expect(mockFetch).toHaveBeenCalledTimes(2); // init + notify

    // Second call should return cached session (no new fetch calls)
    mockFetch.mockReset();
    const session2 = await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });

    expect(session2.sessionId).toBe('sess-abc');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates separate sessions for different credentials', async () => {
    mockFetch
      .mockResolvedValueOnce(mockInitResponse('sess-user1'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(mockInitResponse('sess-user2'))
      .mockResolvedValueOnce({ ok: true });

    const s1 = await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });
    const s2 = await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key2' });

    expect(s1.sessionId).toBe('sess-user1');
    expect(s2.sessionId).toBe('sess-user2');
  });

  it('handles stateless servers (no session ID)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockInitResponse(null))
      .mockResolvedValueOnce({ ok: true });

    const session = await pool.getSession('datto-rmm', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });

    expect(session.sessionId).toBeNull();
    // baseHeaders should not include Mcp-Session-Id
    expect(session.baseHeaders['Mcp-Session-Id']).toBeUndefined();
  });

  it('evict() forces a fresh handshake on next call', async () => {
    mockFetch
      .mockResolvedValueOnce(mockInitResponse('sess-old'))
      .mockResolvedValueOnce({ ok: true });

    await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });

    pool.evict('autotask', { 'X-Api-Key': 'key1' });

    mockFetch
      .mockResolvedValueOnce(mockInitResponse('sess-new'))
      .mockResolvedValueOnce({ ok: true });

    const session = await pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });
    expect(session.sessionId).toBe('sess-new');
  });

  it('deduplicates concurrent handshakes for the same key', async () => {
    let resolveInit: (v: unknown) => void;
    const initPromise = new Promise((resolve) => { resolveInit = resolve; });

    mockFetch
      .mockImplementationOnce(() => initPromise)
      .mockResolvedValue({ ok: true }); // notify

    const p1 = pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });
    const p2 = pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' });

    // Both should be waiting on the same promise
    resolveInit!(mockInitResponse('sess-dedup'));

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.sessionId).toBe('sess-dedup');
    expect(s2.sessionId).toBe('sess-dedup');
  });

  it('throws when vendor returns non-OK for initialize', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(
      pool.getSession('autotask', 'http://vendor:8080/mcp', { 'X-Api-Key': 'key1' }),
    ).rejects.toThrow('MCP server returned 503');
  });
});
