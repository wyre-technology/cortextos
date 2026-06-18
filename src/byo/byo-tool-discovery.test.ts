import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../credentials/safe-fetch.js', () => ({
  validateVendorBaseUrl: vi.fn().mockResolvedValue(undefined),
}));

import {
  ByoToolDiscoveryService,
  ByoToolDiscoveryError,
  byoCacheKey,
} from './byo-tool-discovery.js';
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';

function makeService() {
  return { get: vi.fn() };
}
function makeCache() {
  return { getTools: vi.fn(), invalidate: vi.fn() };
}

const SERVER = {
  id: 'srv-1',
  name: 's',
  endpointUrl: 'https://byo.example.com/mcp',
  transport: 'streamable-http' as const,
  createdAt: 'now',
  updatedAt: 'now',
  headers: { Authorization: 'Bearer AT-1' },
};

describe('ByoToolDiscoveryService', () => {
  beforeEach(() => {
    vi.mocked(validateVendorBaseUrl).mockReset().mockResolvedValue(undefined);
  });

  it('loads the owner\'s server, SSRF-validates, then reuses ToolCache with an owner-scoped key + mcpPath=""', async () => {
    const service = makeService();
    const cache = makeCache();
    service.get.mockResolvedValue(SERVER);
    cache.getTools.mockResolvedValue([{ name: 'do_thing' }]);

    const disco = new ByoToolDiscoveryService(service as never, cache as never);
    const tools = await disco.discover('user-a', 'srv-1');

    expect(tools).toEqual([{ name: 'do_thing' }]);
    expect(service.get).toHaveBeenCalledWith('user-a', 'srv-1');
    // SSRF validated the user-supplied endpoint.
    expect(validateVendorBaseUrl).toHaveBeenCalledWith('https://byo.example.com/mcp');
    // Reuse: getTools called with namespaced key, full endpoint, decrypted
    // headers, and mcpPath='' (endpoint already includes the path).
    expect(cache.getTools).toHaveBeenCalledWith(
      'byo:user-a:srv-1',
      'https://byo.example.com/mcp',
      { Authorization: 'Bearer AT-1' },
      '',
    );
  });

  it('discoverClassified() annotates each discovered tool with its required permission tier (WYREAI-190)', async () => {
    const service = makeService();
    const cache = makeCache();
    service.get.mockResolvedValue(SERVER);
    cache.getTools.mockResolvedValue([{ name: 'get_ticket' }, { name: 'delete_user' }, { name: 'create_ticket' }]);

    const disco = new ByoToolDiscoveryService(service as never, cache as never);
    const tools = await disco.discoverClassified('user-a', 'srv-1');

    expect(tools).toEqual([
      { name: 'get_ticket', tier: 'read' },
      { name: 'delete_user', tier: 'admin' },
      { name: 'create_ticket', tier: 'write' },
    ]);
    // Same owner-scoping + SSRF as discover() — classification is a pure post-step.
    expect(validateVendorBaseUrl).toHaveBeenCalledWith('https://byo.example.com/mcp');
  });

  it('SSRF-validates BEFORE touching the cache (rejected endpoint never fetches)', async () => {
    const service = makeService();
    const cache = makeCache();
    service.get.mockResolvedValue({ ...SERVER, endpointUrl: 'http://169.254.169.254/mcp' });
    vi.mocked(validateVendorBaseUrl).mockRejectedValueOnce(new Error('rejected: non-public host'));

    const disco = new ByoToolDiscoveryService(service as never, cache as never);
    await expect(disco.discover('user-a', 'srv-1')).rejects.toThrow(/rejected/);
    expect(cache.getTools).not.toHaveBeenCalled();
  });

  it('throws ByoToolDiscoveryError when the server is not found / not owned (RLS null), without fetching', async () => {
    const service = makeService();
    const cache = makeCache();
    service.get.mockResolvedValue(null);

    const disco = new ByoToolDiscoveryService(service as never, cache as never);
    await expect(disco.discover('user-a', 'srv-x')).rejects.toBeInstanceOf(ByoToolDiscoveryError);
    expect(validateVendorBaseUrl).not.toHaveBeenCalled();
    expect(cache.getTools).not.toHaveBeenCalled();
  });

  it('two users discovering different servers get distinct cache keys (no cross-user collision)', () => {
    expect(byoCacheKey('user-a', 'srv-1')).toBe('byo:user-a:srv-1');
    expect(byoCacheKey('user-b', 'srv-1')).toBe('byo:user-b:srv-1');
    expect(byoCacheKey('user-a', 'srv-1')).not.toBe(byoCacheKey('user-b', 'srv-1'));
  });

  it('invalidate() drops the owner-scoped cache entry', () => {
    const cache = makeCache();
    const disco = new ByoToolDiscoveryService(makeService() as never, cache as never);
    disco.invalidate('user-a', 'srv-1');
    expect(cache.invalidate).toHaveBeenCalledWith('byo:user-a:srv-1');
  });
});
