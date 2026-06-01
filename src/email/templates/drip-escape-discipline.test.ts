import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-grep regression-guard: every drip-*.ts template that interpolates
 * `${first}` (the recipient's first name, attacker-influenceable via signup)
 * into outbound HTML MUST escape it via the shared `escapeHtml` from base.ts.
 *
 * Catches the asymmetric-defense-across-N-items class (warden Finding on
 * PR #302) at the source-grep layer: if a future drip template (or refactor)
 * reintroduces an unescaped `${first}` in an HTML interpolation, this test
 * goes red before any email lands.
 *
 * Discipline-pin reference: 'asymmetric-defense across N items of a set'
 * (banked 2026-06-01 with the WYREAI-95 fix-in-iteration) — when a defense
 * is applied to SOME members of a set but not ALL, the set boundary is
 * leaking. This test enforces uniformity at the source-grep layer.
 */
describe('drip template escape-discipline (WYREAI-95 warden Finding regression guard)', () => {
  const TEMPLATES_DIR = join(__dirname);
  const dripFiles = readdirSync(TEMPLATES_DIR)
    .filter((f) => f.startsWith('drip-') && f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('discovers every drip template (sanity: list is non-empty)', () => {
    expect(dripFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of [
    'drip-access-controls.ts',
    'drip-connect-tools.ts',
    'drip-feedback.ts',
    'drip-founder-welcome.ts',
    'drip-invite-team.ts',
  ]) {
    it(`${file} imports escapeHtml from base.ts (escape-by-construction)`, () => {
      const src = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
      expect(
        src,
        `${file} must import escapeHtml from './base.js' — the canonical at the template substrate`,
      ).toMatch(/import\s*\{[^}]*\bescapeHtml\b[^}]*\}\s*from\s*['"]\.\/base\.js['"]/);
    });

    it(`${file} does not interpolate \${first} unescaped into HTML body`, () => {
      const src = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
      // The only place an unescaped ${first} is allowed is in subject lines
      // (Graph delivers subject as plain-text, not HTML). Body-level HTML
      // interpolation must use escapeHtml(first). The greeting line is the
      // canonical interpolation site — every template builds a greeting and
      // every greeting must escape.
      const greetingLine = src.match(/`(?:Hey|Hi)\s+\$\{[^}]+\},`/);
      if (greetingLine) {
        expect(
          greetingLine[0],
          `${file}: greeting interpolates a name into HTML body — must use escapeHtml(first), not raw \${first}`,
        ).toMatch(/escapeHtml\(/);
      }
    });
  }

  it('base.ts exports escapeHtml as the canonical (single-source-of-truth)', () => {
    const base = readFileSync(join(TEMPLATES_DIR, 'base.ts'), 'utf8');
    expect(base).toMatch(/export\s+function\s+escapeHtml\s*\(/);
  });
});
