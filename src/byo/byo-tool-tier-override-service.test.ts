import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fake of the request-path sql, routed by statement text.
const store: Record<string, unknown>[] = [];
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
  const text = strings.join(' ');
  if (text.includes('SELECT tool_name, tier')) {
    const [userId, serverId] = values;
    return Promise.resolve(store.filter((r) => r.user_id === userId && r.byo_server_id === serverId));
  }
  if (text.includes('INSERT INTO byo_tool_tier_overrides')) {
    const [id, user_id, byo_server_id, tool_name, tier] = values;
    const existing = store.find(
      (r) => r.user_id === user_id && r.byo_server_id === byo_server_id && r.tool_name === tool_name,
    );
    if (existing) existing.tier = tier; // ON CONFLICT DO UPDATE
    else store.push({ id, user_id, byo_server_id, tool_name, tier });
    return Promise.resolve([]);
  }
  if (text.includes('DELETE FROM byo_tool_tier_overrides')) {
    const [userId, serverId, toolName] = values;
    const before = store.length;
    const keep = store.filter(
      (r) => !(r.user_id === userId && r.byo_server_id === serverId && r.tool_name === toolName),
    );
    store.length = 0;
    store.push(...keep);
    return Promise.resolve(Object.assign([], { count: before - store.length }));
  }
  return Promise.resolve([]);
}

vi.mock('../db/context.js', () => ({ getSql: () => fakeSql }));

import { ByoToolTierOverrideService } from './byo-tool-tier-override-service.js';

describe('ByoToolTierOverrideService', () => {
  let svc: ByoToolTierOverrideService;
  beforeEach(() => {
    store.length = 0;
    svc = new ByoToolTierOverrideService();
  });

  it('setOverride then getOverrides round-trips a pin as a map', async () => {
    await svc.setOverride('user-a', 'srv-1', 'delete_thing', 'admin');
    const map = await svc.getOverrides('user-a', 'srv-1');
    expect(map.get('delete_thing')).toBe('admin');
    expect(map.size).toBe(1);
  });

  it('setOverride upserts (re-pinning the same tool replaces, not duplicates)', async () => {
    await svc.setOverride('user-a', 'srv-1', 'tool_x', 'read');
    await svc.setOverride('user-a', 'srv-1', 'tool_x', 'write');
    const map = await svc.getOverrides('user-a', 'srv-1');
    expect(map.get('tool_x')).toBe('write');
    expect(store).toHaveLength(1);
  });

  it('getOverrides is scoped to (user, server) — other users / servers excluded', async () => {
    await svc.setOverride('user-a', 'srv-1', 'tool_x', 'admin');
    await svc.setOverride('user-b', 'srv-1', 'tool_x', 'read');
    await svc.setOverride('user-a', 'srv-2', 'tool_x', 'read');
    const map = await svc.getOverrides('user-a', 'srv-1');
    expect(map.size).toBe(1);
    expect(map.get('tool_x')).toBe('admin');
  });

  it('clearOverride removes the pin and reports whether a row was removed', async () => {
    await svc.setOverride('user-a', 'srv-1', 'tool_x', 'admin');
    expect(await svc.clearOverride('user-a', 'srv-1', 'tool_x')).toBe(true);
    expect((await svc.getOverrides('user-a', 'srv-1')).size).toBe(0);
    // Clearing again is a no-op (0 rows).
    expect(await svc.clearOverride('user-a', 'srv-1', 'tool_x')).toBe(false);
  });
});
