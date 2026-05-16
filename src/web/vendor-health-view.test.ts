import { describe, it, expect } from 'vitest';
import {
  statusDotClass,
  statusLabel,
  hasErrorContext,
  formatLastChecked,
  type VendorHealthStatus,
} from './vendor-health-view.js';

const ALL_STATUSES: VendorHealthStatus[] = ['healthy', 'degraded', 'down', 'unknown'];

describe('statusDotClass', () => {
  it('maps every status to a distinct dot class', () => {
    const classes = ALL_STATUSES.map(statusDotClass);
    expect(new Set(classes).size).toBe(ALL_STATUSES.length);
    expect(classes.every((c) => c.startsWith('vc-dot-'))).toBe(true);
  });
});

describe('statusLabel', () => {
  it('maps every status to dignified tenant-facing copy', () => {
    expect(statusLabel('healthy')).toBe('Connected');
    expect(statusLabel('degraded')).toBe('Degraded');
    expect(statusLabel('down')).toBe('Not responding');
    expect(statusLabel('unknown')).toBe('Checking…');
  });
});

describe('hasErrorContext', () => {
  it('is true only for degraded and down (the states with errorDetail)', () => {
    expect(hasErrorContext('degraded')).toBe(true);
    expect(hasErrorContext('down')).toBe(true);
    expect(hasErrorContext('healthy')).toBe(false);
    expect(hasErrorContext('unknown')).toBe(false);
  });
});

describe('formatLastChecked', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('renders sub-minute as "just now"', () => {
    expect(formatLastChecked('2026-05-16T11:59:30Z', now)).toBe('just now');
  });

  it('renders minutes', () => {
    expect(formatLastChecked('2026-05-16T11:58:00Z', now)).toBe('2m ago');
  });

  it('renders hours', () => {
    expect(formatLastChecked('2026-05-16T09:00:00Z', now)).toBe('3h ago');
  });

  it('renders days', () => {
    expect(formatLastChecked('2026-05-14T12:00:00Z', now)).toBe('2d ago');
  });

  it('handles an unparseable timestamp gracefully', () => {
    expect(formatLastChecked('not-a-date', now)).toBe('unknown');
  });

  it('renders "never checked" for a null timestamp (unprobed vendor)', () => {
    expect(formatLastChecked(null, now)).toBe('never checked');
  });

  it('clamps a future timestamp to "just now"', () => {
    expect(formatLastChecked('2026-05-16T12:05:00Z', now)).toBe('just now');
  });
});
