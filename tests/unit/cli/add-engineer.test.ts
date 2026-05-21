import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldEngineer } from '../../../src/cli/add-engineer';

describe('scaffoldEngineer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-eng-'));
    mkdirSync(join(root, 'orgs', 'wyre'), { recursive: true });
    mkdirSync(join(root, 'templates', 'engineer', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'templates', 'engineer', 'README.md'),
      'Namespace for {{engineer}} in {{org}}.\n',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('scaffolds an engineer namespace with substituted placeholders', () => {
    scaffoldEngineer(root, 'wyre', 'aaron');
    const nsDir = join(root, 'orgs', 'wyre', 'engineers', 'aaron');
    expect(existsSync(join(nsDir, 'agents'))).toBe(true);
    expect(readFileSync(join(nsDir, 'README.md'), 'utf-8'))
      .toBe('Namespace for aaron in wyre.\n');
  });

  it('rejects an invalid engineer name', () => {
    expect(() => scaffoldEngineer(root, 'wyre', 'Aaron')).toThrow(/name/i);
  });

  it('rejects scaffolding an engineer that already exists', () => {
    scaffoldEngineer(root, 'wyre', 'aaron');
    expect(() => scaffoldEngineer(root, 'wyre', 'aaron')).toThrow(/exists/i);
  });
});
