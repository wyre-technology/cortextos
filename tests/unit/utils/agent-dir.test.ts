import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseQualifiedName, resolveAgentDir } from '../../../src/utils/agent-dir';

describe('parseQualifiedName', () => {
  it('parses a bare (shared) agent name', () => {
    expect(parseQualifiedName('boss')).toEqual({ agent: 'boss' });
  });

  it('parses an engineer-qualified agent name', () => {
    expect(parseQualifiedName('aaron/dev')).toEqual({ engineer: 'aaron', agent: 'dev' });
  });

  it('rejects a name with more than one slash', () => {
    expect(() => parseQualifiedName('a/b/c')).toThrow(/qualified/i);
  });

  it('rejects an invalid engineer segment', () => {
    expect(() => parseQualifiedName('Aaron/dev')).toThrow(/engineer/i);
  });

  it('rejects an invalid agent segment', () => {
    expect(() => parseQualifiedName('aaron/Dev')).toThrow(/agent/i);
  });
});

describe('resolveAgentDir', () => {
  const root = '/fw';

  it('resolves a shared agent under orgs/<org>/agents', () => {
    expect(resolveAgentDir(root, 'wyre', 'boss'))
      .toBe(join(root, 'orgs', 'wyre', 'agents', 'boss'));
  });

  it('resolves a namespaced agent under engineers/<engineer>/agents', () => {
    expect(resolveAgentDir(root, 'wyre', 'aaron/dev'))
      .toBe(join(root, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev'));
  });
});
