import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fake of the request-path sql (getSql). Routes by SQL text and
// stores the inserted row so create()→consume() exercises real encrypt/decrypt.
const store: Record<string, unknown>[] = [];
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
  const text = strings.join(' ');
  if (text.includes('INSERT INTO byo_oauth_states')) {
    const [state_token, user_id, byo_server_id, client_id, encrypted_data, iv, auth_tag, salt, expires_at] = values;
    store.push({ state_token, user_id, byo_server_id, client_id, encrypted_data, iv, auth_tag, salt, expires_at });
    return Promise.resolve([]);
  }
  if (text.includes('DELETE FROM byo_oauth_states') && text.includes('RETURNING')) {
    const [stateToken] = values;
    const idx = store.findIndex((r) => r.state_token === stateToken);
    if (idx === -1) return Promise.resolve([]);
    const [row] = store.splice(idx, 1);
    return Promise.resolve([row]);
  }
  if (text.includes('DELETE FROM byo_oauth_states')) {
    return Promise.resolve(Object.assign([], { count: 0 }));
  }
  return Promise.resolve([]);
}

vi.mock('../db/context.js', () => ({ getSql: () => fakeSql }));

import { ByoOAuthStateStore } from './byo-oauth-state-store.js';

const masterKey = Buffer.alloc(32, 7);

describe('ByoOAuthStateStore', () => {
  let store_: ByoOAuthStateStore;

  beforeEach(() => {
    store.length = 0;
    store_ = new ByoOAuthStateStore(masterKey);
  });

  it('encrypts the code_verifier + client_secret at rest and round-trips via consume()', async () => {
    await store_.create({
      stateToken: 'st-1',
      userId: 'user-a',
      byoServerId: 'srv-1',
      clientId: 'client-xyz',
      codeVerifier: 'verifier-super-secret',
      clientSecret: 'shh-confidential',
    });

    // At rest: neither secret appears in plaintext; client_id (not secret) does.
    const row = store[0];
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('verifier-super-secret');
    expect(serialized).not.toContain('shh-confidential');
    expect(row.client_id).toBe('client-xyz');

    const consumed = await store_.consume('st-1');
    expect(consumed).toEqual({
      userId: 'user-a',
      byoServerId: 'srv-1',
      clientId: 'client-xyz',
      codeVerifier: 'verifier-super-secret',
      clientSecret: 'shh-confidential',
    });
  });

  it('round-trips a public client (no client_secret)', async () => {
    await store_.create({
      stateToken: 'st-2',
      userId: 'user-a',
      byoServerId: 'srv-1',
      clientId: 'public-client',
      codeVerifier: 'verifier-2',
    });
    const consumed = await store_.consume('st-2');
    expect(consumed).toMatchObject({ clientId: 'public-client', codeVerifier: 'verifier-2' });
    expect(consumed!.clientSecret).toBeUndefined();
  });

  it('consume() is single-use — a second consume returns null', async () => {
    await store_.create({ stateToken: 'st-3', userId: 'u', byoServerId: 's', clientId: 'c', codeVerifier: 'v' });
    expect(await store_.consume('st-3')).not.toBeNull();
    expect(await store_.consume('st-3')).toBeNull();
  });

  it('consume() returns null for an unknown state token', async () => {
    expect(await store_.consume('nope')).toBeNull();
  });

  it('consume() returns null for an expired state', async () => {
    await store_.create({
      stateToken: 'st-exp',
      userId: 'u',
      byoServerId: 's',
      clientId: 'c',
      codeVerifier: 'v',
      ttlSeconds: -1, // already expired
    });
    expect(await store_.consume('st-exp')).toBeNull();
  });

  it('consume() returns null when the ciphertext was tampered (auth-tag failure)', async () => {
    await store_.create({ stateToken: 'st-t', userId: 'u', byoServerId: 's', clientId: 'c', codeVerifier: 'v' });
    store[0].encrypted_data = Buffer.from('tampered').toString('base64');
    expect(await store_.consume('st-t')).toBeNull();
  });
});
