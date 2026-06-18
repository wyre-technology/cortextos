import { describe, it, expect } from 'vitest';
import {
  classifyByoTool,
  byoRequiredTier,
  classifyByoTools,
} from './byo-tool-classifier.js';
import { tierForToolConfig } from '../auth/tier-check.js';

const tool = (name: string, description?: string) => ({ name, description });

describe('classifyByoTool / byoRequiredTier', () => {
  it('read-shaped leading verbs on non-secret targets → read', () => {
    for (const n of ['get_ticket', 'list_devices', 'search_companies', 'fetchReport', 'describe-asset', 'status', 'view_dashboard']) {
      expect(byoRequiredTier(tool(n))).toBe('read');
    }
  });

  it('mutating leading verbs on ordinary targets → write', () => {
    for (const n of ['create_ticket', 'update_company', 'delete_ticket', 'send_message', 'resolve_alert', 'run_job', 'archive_record']) {
      expect(byoRequiredTier(tool(n))).toBe('write');
    }
  });

  it('an UNRECOGNIZED leading verb is conservative — write, never read', () => {
    expect(byoRequiredTier(tool('frobnicate_widget'))).toBe('write');
    expect(byoRequiredTier(tool('zorp'))).toBe('write');
  });

  it('hard admin verbs → admin regardless of target', () => {
    for (const n of ['grant_access', 'revoke_token', 'impersonate_user', 'rotate_key', 'disable_account']) {
      expect(byoRequiredTier(tool(n))).toBe('admin');
    }
  });

  it('mutating a privileged domain (roles/members/billing/settings/api keys) → admin', () => {
    for (const n of ['delete_user', 'update_role', 'create_member', 'set_billing', 'update_org_settings', 'create_api_key']) {
      expect(byoRequiredTier(tool(n))).toBe('admin');
    }
  });

  it('READING a privileged-but-non-secret domain stays read (viewing is not admin)', () => {
    expect(byoRequiredTier(tool('get_user'))).toBe('read');
    expect(byoRequiredTier(tool('list_roles'))).toBe('read');
  });

  it('any secret/credential noun escalates to admin — even on a read verb (reading a secret is privileged)', () => {
    for (const n of ['get_password', 'read_credential', 'export_secrets', 'list_api_keys', 'download_private_key']) {
      expect(byoRequiredTier(tool(n))).toBe('admin');
    }
  });

  it('the description can surface a secret/privileged noun the name hides', () => {
    expect(byoRequiredTier(tool('fetch_blob', 'Returns the stored client_secret for the integration'))).toBe('admin');
  });

  it('produces a catalog-shaped generic ToolConfig and routes through the EXISTING tier resolver', () => {
    const cfg = classifyByoTool(tool('delete_user'));
    expect(cfg).toMatchObject({ entityType: 'generic', ttlMs: 0, isWrite: true, isAdmin: true });
    // Reuse, not reinvention: byoRequiredTier === tierForToolConfig∘classify.
    expect(byoRequiredTier(tool('delete_user'))).toBe(tierForToolConfig(cfg));
    expect(byoRequiredTier(tool('get_ticket'))).toBe(tierForToolConfig(classifyByoTool(tool('get_ticket'))));
  });

  it('classifyByoTools annotates a list, preserving tool fields (no overrides)', () => {
    const out = classifyByoTools([tool('get_ticket', 'd1'), tool('delete_user')]);
    expect(out).toEqual([
      { name: 'get_ticket', description: 'd1', tier: 'read', autoTier: 'read', overridden: false },
      { name: 'delete_user', description: undefined, tier: 'admin', autoTier: 'admin', overridden: false },
    ]);
  });

  it('a manual owner override WINS over the auto tier and is flagged (WYREAI-191)', () => {
    const overrides = new Map<string, 'read' | 'write' | 'admin'>([['get_ticket', 'admin']]);
    const out = classifyByoTools([tool('get_ticket'), tool('delete_user')], overrides);
    // get_ticket auto-classifies read but the owner pinned admin → effective admin.
    expect(out[0]).toEqual({ name: 'get_ticket', description: undefined, tier: 'admin', autoTier: 'read', overridden: true });
    // delete_user has no pin → effective == auto.
    expect(out[1]).toMatchObject({ tier: 'admin', autoTier: 'admin', overridden: false });
  });
});
