import type { Organization, OrgTeam } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

// WYREAI-63 (parity port of gateway #200 frontend): team-scoped tool-access
// admin UI. Renders the allowlist for a (team, vendor) pair WITH audit
// metadata (grantedBy + grantedAt) from the WYREAI-62 GET endpoint.
//
// v1 surface: READ-ONLY display + the inherit-org-defaults empty state copy.
// The PUT/DELETE controls (set/clear allowlist) are deferred to the v1.1
// fast-follow — admins can use the API directly today, and the audit-read
// surface is the load-bearing piece for "who granted what when" visibility
// (the alarming-allowlist-state-debug case). Keeping v1 read-only matches
// gateway #200's "effective-scope preview = v1.1 fast-follow" deferral
// shape (read first, write next).
//
// Empty state copy: `null = inherit org defaults, no lock-out warning`
// (gateway #200 Aaron-ruled product Q). The "this team has no team-scoped
// allowlist; the org-level allowlist applies" message anchors the mental
// model so a reviewer doesn't read empty-state as "this team has zero tools".

export interface TeamScopeToolAccessData {
  org: Organization;
  team: OrgTeam;
  vendorSlug: string;
  vendorName: string;
  /** Audit-extended response from WYREAI-62 GET endpoint, or null = inherit org defaults. */
  allowlist: {
    tools: string[];
    grantedBy: string | null;
    grantedAt: string | null;
  } | null;
}

/**
 * Relative-time staleness string from an ISO 8601 timestamp.
 * Matches the existing vendor-health-view.ts convention so the team
 * tool-access audit reads consistently with the connections dot.
 */
function formatGrantedAt(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  // Note: Date.now() is unavailable at workflow-script time but standard at
  // SSR-render time — this is a request-path template, not a workflow.
  const diffMs = Math.max(0, Date.now() - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function renderTeamScopeToolAccess(data: TeamScopeToolAccessData): string {
  const { org, team, vendorSlug, vendorName, allowlist } = data;
  const teamName = escapeHtml(team.name);
  const vendor = escapeHtml(vendorName);

  // Inherit-org-defaults empty state — the load-bearing copy beat
  // (gateway #200 Aaron-ruled). Anchors mental model: empty != deny-all.
  if (allowlist === null) {
    return `
      <div class="tsta-page">
        <nav class="tsta-breadcrumb">
          <a href="/org/teams">${escapeHtml(org.name)} · Teams</a>
          <span class="tsta-sep">›</span>
          <span>${teamName}</span>
          <span class="tsta-sep">›</span>
          <span>${vendor} tool access</span>
        </nav>
        <h1 class="tsta-title">${teamName} — ${vendor} tool access</h1>
        <div class="tsta-empty">
          <p class="tsta-empty-strong">No team-scoped allowlist set.</p>
          <p class="tsta-empty-body">
            This team inherits the org-level allowlist for ${vendor}. Tools
            available to ${teamName} members are governed by the same rules as
            org members of the same role.
          </p>
          <p class="tsta-empty-cta">
            To restrict ${teamName} to a narrower set of ${vendor} tools, set a
            team-scoped allowlist (admin-only, via the API or v1.1 UI).
          </p>
        </div>
      </div>
    `;
  }

  const grantedByLabel = allowlist.grantedBy
    ? escapeHtml(allowlist.grantedBy)
    : 'unknown';
  const grantedAtLabel = escapeHtml(formatGrantedAt(allowlist.grantedAt));
  const grantedAtTitle = allowlist.grantedAt
    ? `title="${escapeHtml(allowlist.grantedAt)}"`
    : '';

  const toolRows = allowlist.tools.length === 0
    ? `<p class="tsta-empty-body">This team's allowlist is empty for ${vendor} — no tools permitted (explicit deny-all).</p>`
    : `<ul class="tsta-tool-list">
        ${allowlist.tools
          .map((t) => `<li class="tsta-tool-row">${escapeHtml(t)}</li>`)
          .join('')}
      </ul>`;

  return `
    <div class="tsta-page">
      <nav class="tsta-breadcrumb">
        <a href="/org/teams">${escapeHtml(org.name)} · Teams</a>
        <span class="tsta-sep">›</span>
        <span>${teamName}</span>
        <span class="tsta-sep">›</span>
        <span>${vendor} tool access</span>
      </nav>
      <h1 class="tsta-title">${teamName} — ${vendor} tool access</h1>
      <div class="tsta-audit">
        <span class="tsta-audit-row">Granted by <strong>${grantedByLabel}</strong></span>
        <span class="tsta-audit-row">Granted <span ${grantedAtTitle}>${grantedAtLabel}</span></span>
      </div>
      <section class="tsta-tools">
        <h2 class="tsta-section-title">Permitted tools for ${teamName} via ${vendor} (${allowlist.tools.length})</h2>
        ${toolRows}
      </section>
      <p class="tsta-foot">
        Slug: <code>${escapeHtml(vendorSlug)}</code> · Team id:
        <code>${escapeHtml(team.id)}</code>
      </p>
    </div>
  `;
}

export const TEAM_SCOPE_TOOL_ACCESS_STYLES = `
  .tsta-page { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
  .tsta-breadcrumb { font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
  .tsta-breadcrumb a { color: var(--text-secondary); text-decoration: none; }
  .tsta-breadcrumb a:hover { text-decoration: underline; }
  .tsta-sep { margin: 0 6px; color: var(--text-muted); }
  .tsta-title { font-size: 22px; font-weight: 600; margin: 8px 0 16px; }
  .tsta-audit {
    display: flex; gap: 16px; padding: 12px 16px; border-radius: 8px;
    background: var(--bg-subtle); margin-bottom: 16px; font-size: 13px;
  }
  .tsta-audit-row { color: var(--text-secondary); }
  .tsta-audit-row strong { color: var(--text-primary); font-weight: 600; }
  .tsta-section-title { font-size: 15px; font-weight: 600; margin: 12px 0 8px; }
  .tsta-tool-list { list-style: none; padding: 0; margin: 0; }
  .tsta-tool-row {
    padding: 8px 12px; border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono); font-size: 13px;
  }
  .tsta-tool-row:last-child { border-bottom: none; }
  .tsta-empty {
    padding: 20px; border: 1px dashed var(--border-primary); border-radius: 8px;
    background: var(--bg-subtle);
  }
  .tsta-empty-strong {
    font-weight: 600; color: var(--text-primary); margin: 0 0 8px;
  }
  .tsta-empty-body { color: var(--text-secondary); line-height: 1.5; margin: 0 0 12px; }
  .tsta-empty-cta {
    color: var(--text-secondary); font-size: 13px; margin: 0;
    padding-top: 12px; border-top: 1px solid var(--border-subtle);
  }
  .tsta-foot { color: var(--text-muted); font-size: 12px; margin-top: 16px; }
  .tsta-foot code {
    background: var(--bg-subtle); padding: 1px 6px; border-radius: 4px;
    font-family: var(--font-mono);
  }
`;
