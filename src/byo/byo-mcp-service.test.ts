import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fake of the request-path sql (getSql). Routes by SQL text and
// stores inserted rows so create()→get() exercises the real encrypt/decrypt.
const store: Record<string, unknown>[] = [];
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
  const text = strings.join(' ');
  if (text.includes('INSERT INTO byo_mcp_servers')) {
    const [id, user_id, name, endpoint_url, transport, encrypted_data, iv, auth_tag, salt] = values;
    store.push({ id, user_id, name, endpoint_url, transport, encrypted_data, iv, auth_tag, salt, created_at: 'now', updated_at: 'now' });
    return Promise.resolve([{ id }]);
  }
  if (text.includes('encrypted_data') && text.includes('SELECT')) {
    const [userId, id] = values;
    return Promise.resolve(store.filter((r) => r.user_id === userId && r.id === id));
  }
  if (text.includes('SELECT id, name')) {
    const [userId] = values;
    return Promise.resolve(store.filter((r) => r.user_id === userId));
  }
  if (text.includes('DELETE')) {
    const [userId, id] = values;
    const before = store.length;
    const keep = store.filter((r) => !(r.user_id === userId && r.id === id));
    store.length = 0;
    store.push(...keep);
    return Promise.resolve(Object.assign([], { count: before - store.length }));
  }
  return Promise.resolve([]);
}

vi.mock('../db/context.js', () => ({ getSql: () => fakeSql }));
vi.mock('../credentials/safe-fetch.js', () => ({ validateVendorBaseUrl: vi.fn().mockResolvedValue(undefined) }));

import { ByoMcpServerService } from './byo-mcp-service.js';
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';

describe('ByoMcpServerService', () => {
  let svc: ByoMcpServerService;

  beforeEach(() => {
    store.length = 0;
    svc = new ByoMcpServerService();
    vi.mocked(validateVendorBaseUrl).mockReset().mockResolvedValue(undefined);
  });

  it('rejects a non-public endpoint before persisting (SSRF)', async () => {
    vi.mocked(validateVendorBaseUrl).mockRejectedValueOnce(new Error('rejected: non-public host'));
    await expect(
      svc.create('user-a', { name: 'evil', endpointUrl: 'http://169.254.169.254/mcp', headers: { Authorization: 'Bearer x' } }),
    ).rejects.toThrow(/rejected/);
    expect(store).toHaveLength(0); // nothing stored
  });

  it('encrypts headers at rest and round-trips them via get()', async () => {
    const id = await svc.create('user-a', {
      name: 'my-server',
      endpointUrl: 'https://byo.example.com/mcp',
      headers: { Authorization: 'Bearer super-secret-token' },
    });

    // At rest: the ciphertext must NOT contain the plaintext token.
    const row = store[0];
    expect(JSON.stringify(row)).not.toContain('super-secret-token');
    expect(row.encrypted_data).toBeTruthy();

    const got = await svc.get('user-a', id);
    expect(got).not.toBeNull();
    expect(got!.endpointUrl).toBe('https://byo.example.com/mcp');
    expect(got!.transport).toBe('streamable-http');
    expect(got!.headers).toEqual({ Authorization: 'Bearer super-secret-token' });
  });

  it('list() returns metadata without decrypted headers', async () => {
    await svc.create('user-a', { name: 's1', endpointUrl: 'https://a.example.com/mcp', headers: { Authorization: 'Bearer t' } });
    const list = await svc.list('user-a');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 's1', endpointUrl: 'https://a.example.com/mcp', transport: 'streamable-http' });
    expect(list[0]).not.toHaveProperty('headers');
  });

  it('get() returns null for another user (no cross-user read at the query layer; RLS is the DB belt)', async () => {
    const id = await svc.create('user-a', { name: 's', endpointUrl: 'https://a.example.com/mcp', headers: {} });
    expect(await svc.get('user-b', id)).toBeNull();
  });

  it('delete() removes only the owner\'s row', async () => {
    const id = await svc.create('user-a', { name: 's', endpointUrl: 'https://a.example.com/mcp', headers: {} });
    expect(await svc.delete('user-b', id)).toBe(false);
    expect(await svc.delete('user-a', id)).toBe(true);
    expect(store).toHaveLength(0);
  });
});
