import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolCache } from './tool-cache.js';

describe('ToolCache', () => {
  let cache: ToolCache;

  beforeEach(() => {
    cache = new ToolCache();
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockTools = [
    { name: 'list_devices', description: 'List all devices' },
    { name: 'get_device', description: 'Get a device by ID' },
  ];

  /**
   * Mock the 3-request MCP handshake: initialize, notifications/initialized, tools/list.
   * Each call to mockSequentialResponse() queues one full set of 3 fetch mocks.
   */
  function mockSequentialResponse(tools = mockTools) {
    // Request 1: initialize
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1.0' } },
        }),
    } as Response);

    // Request 2: notifications/initialized (server acknowledges, no body needed)
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as Response);

    // Request 3: tools/list
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }),
    } as Response);
  }

  function mockSequentialSSEResponse(tools = mockTools) {
    // Request 1: initialize (JSON)
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
    } as Response);

    // Request 2: notifications/initialized
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as Response);

    // Request 3: tools/list (SSE)
    const toolsEvent = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => `data: ${toolsEvent}\n\n`,
    } as Response);
  }

  it('fetches tools from vendor and caches them', async () => {
    mockSequentialResponse();

    const tools = await cache.getTools('datto-rmm', 'http://datto:8080', { 'X-Key': 'abc' });
    expect(tools).toEqual(mockTools);
    expect(fetch).toHaveBeenCalledTimes(3); // initialize + notifications/initialized + tools/list

    // Second call should use cache — no additional fetches
    const tools2 = await cache.getTools('datto-rmm', 'http://datto:8080', { 'X-Key': 'abc' });
    expect(tools2).toEqual(mockTools);
    expect(fetch).toHaveBeenCalledTimes(3); // still 3
  });

  it('handles SSE response for tools/list', async () => {
    mockSequentialSSEResponse();

    const tools = await cache.getTools('datto-rmm', 'http://datto:8080', {});
    expect(tools).toEqual(mockTools);
  });

  it('sends session ID header when server returns one', async () => {
    // initialize returns a session ID
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'sess-123' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    } as Response);
    // notifications/initialized
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as Response);
    // tools/list
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: mockTools } }),
    } as Response);

    await cache.getTools('datto-rmm', 'http://datto:8080', {});

    // notifications/initialized and tools/list should include the session ID header
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'Mcp-Session-Id': 'sess-123' }) }),
    );
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'Mcp-Session-Id': 'sess-123' }) }),
    );
  });

  it('throws on network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    await expect(cache.getTools('datto-rmm', 'http://datto:8080', {})).rejects.toThrow(
      'Network error',
    );
  });

  it('throws on non-ok HTTP response from initialize', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    await expect(cache.getTools('datto-rmm', 'http://datto:8080', {})).rejects.toThrow(
      'HTTP 401',
    );
  });

  it('throws on non-ok HTTP response from tools/list', async () => {
    // initialize succeeds
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    } as Response);
    // notifications/initialized succeeds
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as Response);
    // tools/list fails
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    await expect(cache.getTools('datto-rmm', 'http://datto:8080', {})).rejects.toThrow(
      'HTTP 500',
    );
  });

  it('deduplicates concurrent fetches for same vendor', async () => {
    let resolveInit!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInit = resolve;
      }),
    );
    // Queue mocks for notifications/initialized and tools/list
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: mockTools } }),
    } as Response);

    const p1 = cache.getTools('datto-rmm', 'http://datto:8080', {});
    const p2 = cache.getTools('datto-rmm', 'http://datto:8080', {});

    resolveInit({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    } as Response);

    const [tools1, tools2] = await Promise.all([p1, p2]);
    expect(tools1).toEqual(mockTools);
    expect(tools2).toEqual(mockTools);
    // Only 3 fetches total (one set of initialize+notif+tools/list), not 6
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('invalidate clears cache for specific vendor', async () => {
    mockSequentialResponse();
    mockSequentialResponse();

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    expect(fetch).toHaveBeenCalledTimes(3);

    cache.invalidate('datto-rmm');

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('invalidate with no args clears all cache', async () => {
    mockSequentialResponse();
    mockSequentialResponse();
    mockSequentialResponse();
    mockSequentialResponse();

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    await cache.getTools('itglue', 'http://itglue:8080', {});
    expect(fetch).toHaveBeenCalledTimes(6); // 3 per vendor

    cache.invalidate();

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    await cache.getTools('itglue', 'http://itglue:8080', {});
    expect(fetch).toHaveBeenCalledTimes(12);
  });

  it('refetches after TTL expires', async () => {
    mockSequentialResponse();
    mockSequentialResponse();
    vi.useFakeTimers();

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    expect(fetch).toHaveBeenCalledTimes(3);

    // Advance past 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await cache.getTools('datto-rmm', 'http://datto:8080', {});
    expect(fetch).toHaveBeenCalledTimes(6);

    vi.useRealTimers();
  });
});
