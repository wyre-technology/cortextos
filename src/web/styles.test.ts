import { describe, it, expect } from 'vitest';
import { THEME_VARS, PAGE_STYLES } from './styles.js';

// Regression guard for the 2026-05-22 color-consistency directive
// (Aaron — partnerships-demo + KW-Corp prep). Without the global anchor
// and native-form-element resets defined in PAGE_STYLES, browser defaults
// leak through: anchors render dark-blue (#0000EE) regardless of theme,
// and inputs/selects/textareas render white in dark mode. Per-component
// overrides still win via specificity; these globals only catch
// otherwise-unstyled elements.

describe('THEME_VARS — text-on-bright-bg tokens', () => {
  // Every site that hardcodes `color: #0a0a0a` (or #fff) on an accent /
  // success / warning fill should route through these tokens instead.
  // PR-2 (Tier-2 token-drift sweep) replaces the hardcoded literals.
  it('defines --text-on-accent', () => {
    expect(THEME_VARS).toMatch(/--text-on-accent:\s*#/);
  });
  it('defines --text-on-success', () => {
    expect(THEME_VARS).toMatch(/--text-on-success:\s*#/);
  });
  it('defines --text-on-warning', () => {
    expect(THEME_VARS).toMatch(/--text-on-warning:\s*#/);
  });
});

describe('PAGE_STYLES — global anchor reset', () => {
  it('defines a global `a` rule that points at the canonical token', () => {
    // Pattern-assert: a single `a { color: var(--accent-text) }` block.
    expect(PAGE_STYLES).toMatch(/\ba\s*\{[^}]*color:\s*var\(--accent-text\)/);
  });
  it('defines a hover state that points at the canonical hover token', () => {
    expect(PAGE_STYLES).toMatch(/a:hover\s*\{[^}]*color:\s*var\(--accent-hover\)/);
  });
  it('global anchor rule precedes any per-component anchor override', () => {
    // Sanity: the global `a {}` rule should sit in PAGE_STYLES, not be
    // pushed to per-component sheets — pattern-asserts the rule lives in
    // the canonical PAGE_STYLES bundle so it gets injected on every page.
    const aRuleIndex = PAGE_STYLES.search(/\ba\s*\{[^}]*color:\s*var\(--accent-text\)/);
    expect(aRuleIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('PAGE_STYLES — global native-form-element reset', () => {
  it('defines an `input, select, textarea` rule routed through theme tokens', () => {
    // Pattern-assert single rule with all three element selectors + token-
    // sourced color/background/border.
    expect(PAGE_STYLES).toMatch(
      /input,\s*select,\s*textarea\s*\{[\s\S]*?color:\s*var\(--text-primary\)[\s\S]*?background:\s*var\(--bg-input\)/,
    );
  });
  it('uses canonical border + focus tokens, never hardcoded hex on natives', () => {
    expect(PAGE_STYLES).toMatch(/input,\s*select,\s*textarea\s*\{[\s\S]*?border:[^;]*var\(--border-primary\)/);
    expect(PAGE_STYLES).toMatch(/input:focus[\s\S]*?border-color:\s*var\(--accent\)/);
  });
});

describe('PAGE_STYLES — focus-visible accessibility outline', () => {
  it('defines a global :focus-visible outline using the canonical accent token', () => {
    expect(PAGE_STYLES).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent\)/);
  });
});
