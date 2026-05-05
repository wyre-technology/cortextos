import { describe, it, expect } from 'vitest';
import { renderTeamAudit } from './team-audit.js';

describe('renderTeamAudit capture banner', () => {
  it('shows the locked banner with upgrade link when plan does not allow capture (owner)', () => {
    const html = renderTeamAudit({
      orgId: 'org-1',
      captureEnabled: false,
      planAllowsCapture: false,
      isOwner: true,
    });
    expect(html).toContain('capture-banner--locked');
    expect(html).toContain('Pro/Business feature');
    expect(html).toContain('Upgrade to enable');
    expect(html).not.toContain('id="capture-toggle"');
  });

  it('shows the locked banner without upgrade link for non-owners', () => {
    const html = renderTeamAudit({
      orgId: 'org-1',
      captureEnabled: false,
      planAllowsCapture: false,
      isOwner: false,
    });
    expect(html).toContain('capture-banner--locked');
    expect(html).not.toContain('Upgrade to enable');
  });

  it('shows read-only banner to non-owners on a paid plan', () => {
    const html = renderTeamAudit({
      orgId: 'org-1',
      captureEnabled: true,
      planAllowsCapture: true,
      isOwner: false,
    });
    expect(html).toContain('capture-banner--readonly');
    expect(html).toContain('Prompt capture is on');
    expect(html).not.toContain('id="capture-toggle"');
  });

  it('shows the toggle to owners on a paid plan, checked when enabled', () => {
    const html = renderTeamAudit({
      orgId: 'org-1',
      captureEnabled: true,
      planAllowsCapture: true,
      isOwner: true,
    });
    expect(html).toContain('id="capture-toggle"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain('Enabled');
  });

  it('shows the toggle to owners on a paid plan, unchecked when disabled', () => {
    const html = renderTeamAudit({
      orgId: 'org-1',
      captureEnabled: false,
      planAllowsCapture: true,
      isOwner: true,
    });
    expect(html).toContain('id="capture-toggle"');
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain('Disabled');
  });
});
