import { describe, it, expect } from 'vitest';
import { normalizePatch } from '../idp-quirks.js';

describe('PATCH normalization', () => {
  it('lowercases capitalised Entra ops', () => {
    const out = normalizePatch(
      {
        Operations: [
          { op: 'Add', path: 'members', value: [{ value: 'u1' }] },
          { op: 'Replace', path: 'active', value: false },
          { op: 'Remove', path: 'displayName' },
        ],
      },
      'entra',
    );
    expect(out.Operations.map((o) => o.op)).toEqual(['add', 'replace', 'remove']);
  });

  it('injects default schemas if missing', () => {
    const out = normalizePatch(
      { Operations: [{ op: 'add', value: { foo: 'bar' } }] },
      'okta',
    );
    expect(out.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:PatchOp']);
  });

  it('preserves existing schemas', () => {
    const out = normalizePatch(
      {
        schemas: ['urn:custom:scim:schema'],
        Operations: [{ op: 'add', value: { foo: 'bar' } }],
      },
      'okta',
    );
    expect(out.schemas).toEqual(['urn:custom:scim:schema']);
  });
});
