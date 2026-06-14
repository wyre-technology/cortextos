import type { Organization } from "../../org/org-service.js";
import type { AdminAuditEntry } from "../../audit/admin-audit-service.js";
import { escapeHtml } from "../helpers.js";

/**
 * Reseller-side Audit Log surface — replaces the stub at
 * /org/reseller/audit.
 *
 * 2026-06-14 sweep-2 cluster-2 (c) finding (Aaron, "We need this fully
 * functional by launch date"): the reseller console's Audit Log nav
 * item was a `resellerStubBody('/org/reseller/audit', ...)` placeholder.
 * AdminAuditService.query() already supports org-scoped filtering +
 * pagination; this template just renders the entries for the reseller's
 * own org_id. Customer-org-internal events stay scoped to the customer
 * audit view (privacy boundary preserved).
 *
 * v1 scope:
 *   - Paginated server-rendered table (prev / next, page-size = 50)
 *   - Optional event_type filter dropdown (URL query param)
 *   - No CSV export at v1 (admin surface has it; can lift later)
 *
 * Events captured by org_id = resellerOrgId at v1:
 *   - customer_org_created — reseller_admin provisioned a customer
 *   - member_invited / member_removed — reseller staff changes
 *   - role_changed — reseller member role changes
 *   - invitation_accepted / invitation_revoked
 *   - org_credential_created / org_credential_deleted (reseller-scoped)
 *   - idp_connection_created / idp_connection_deleted (slice 6+7 wizard)
 *   - msp_operator_session_* (PR #386 — once dev wires session-handling)
 */

export interface ResellerAuditData {
  org: Organization;
  entries: AdminAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Active event-type filter, or null when showing all. Surfaces as a
   *  selected dropdown option + included on prev/next URLs so paging
   *  preserves the filter context. */
  eventTypeFilter: string | null;
  /** Distinct event types present in the underlying log — populates the
   *  filter dropdown. Calculated by the route handler. */
  availableEventTypes: string[];
}

function formatTimestamp(iso: string): string {
  // Render as YYYY-MM-DD HH:MM UTC — deterministic, ops-friendly,
  // doesn't drift across viewer timezones.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function renderEventBadge(eventType: string): string {
  return `<span class="event-badge">${escapeHtml(eventType)}</span>`;
}

function renderActor(entry: AdminAuditEntry): string {
  const name = entry.actorName || entry.actorEmail || entry.actorId;
  if (entry.actorEmail && entry.actorName) {
    return `${escapeHtml(name)} <span class="actor-email">&lt;${escapeHtml(entry.actorEmail)}&gt;</span>`;
  }
  return escapeHtml(name);
}

function renderTarget(entry: AdminAuditEntry): string {
  if (!entry.targetId && !entry.targetEmail) return "&mdash;";
  const name = entry.targetName || entry.targetEmail || entry.targetId || "";
  return escapeHtml(String(name));
}

function renderMetadataPreview(
  metadata: Record<string, unknown> | null,
): string {
  if (!metadata) return "&mdash;";
  const keys = Object.keys(metadata);
  if (keys.length === 0) return "&mdash;";
  // Render first 2 keys inline; show "+N more" suffix when truncated.
  // Full payload is in the DB for SRE / ops queries; this is a glance-
  // value summary, not the source of truth.
  const previewKeys = keys.slice(0, 2);
  const preview = previewKeys
    .map(
      (k) => `${escapeHtml(k)}=${escapeHtml(String(metadata[k]).slice(0, 32))}`,
    )
    .join(", ");
  const more =
    keys.length > 2
      ? ` <span class="meta-more">+${keys.length - 2} more</span>`
      : "";
  return `<span class="meta-preview">${preview}${more}</span>`;
}

export function renderResellerAudit(data: ResellerAuditData): string {
  const {
    org,
    entries,
    total,
    page,
    pageSize,
    eventTypeFilter,
    availableEventTypes,
  } = data;
  const orgName = escapeHtml(org.name);

  const rows = entries.length
    ? entries
        .map(
          (e) => `
        <tr>
          <td class="ts">${formatTimestamp(e.createdAt)}</td>
          <td>${renderEventBadge(e.eventType)}</td>
          <td>${renderActor(e)}</td>
          <td>${renderTarget(e)}</td>
          <td>${renderMetadataPreview(e.metadata)}</td>
        </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No audit events recorded for this organization yet.</td></tr>`;

  const filterOptions = ['<option value="">All events</option>']
    .concat(
      availableEventTypes.map(
        (t) =>
          `<option value="${escapeHtml(t)}"${t === eventTypeFilter ? " selected" : ""}>${escapeHtml(t)}</option>`,
      ),
    )
    .join("");

  // Pagination math
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const baseUrl = "/org/reseller/audit";
  // Use &amp; in the href per HTML5 spec — raw & in an attribute value
  // is tolerated but technically invalid; encoding satisfies validators
  // + downstream HTML parsers that handle entities strictly.
  const filterQs = eventTypeFilter
    ? `&amp;event_type=${encodeURIComponent(eventTypeFilter)}`
    : "";
  const prevHref = hasPrev ? `${baseUrl}?page=${page - 1}${filterQs}` : "";
  const nextHref = hasNext ? `${baseUrl}?page=${page + 1}${filterQs}` : "";

  return `
    <h1 style="margin-bottom:4px">Audit Log</h1>
    <p class="section-desc">${orgName} &middot; ${total} event${total === 1 ? "" : "s"}</p>

    <form method="GET" action="${baseUrl}" class="reseller-audit-filters">
      <label for="event_type" style="font-size:12px;color:var(--text-tertiary)">Filter:</label>
      <select id="event_type" name="event_type" onchange="this.form.submit()">
        ${filterOptions}
      </select>
    </form>

    <div class="reseller-audit-card">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${
      totalPages > 1
        ? `<div class="reseller-audit-pagination">
            ${hasPrev ? `<a href="${prevHref}" class="btn-secondary">&larr; Previous</a>` : `<span class="btn-secondary disabled">&larr; Previous</span>`}
            <span>Page ${page} of ${totalPages}</span>
            ${hasNext ? `<a href="${nextHref}" class="btn-secondary">Next &rarr;</a>` : `<span class="btn-secondary disabled">Next &rarr;</span>`}
          </div>`
        : ""
    }
  `;
}

export const RESELLER_AUDIT_STYLES = `
  .reseller-audit-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 16px 0;
  }
  .reseller-audit-filters select {
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  .reseller-audit-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    overflow: hidden;
  }
  .reseller-audit-card table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .reseller-audit-card th {
    text-align: left;
    color: var(--text-tertiary);
    font-weight: 500;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-tertiary);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .reseller-audit-card td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-label);
    vertical-align: top;
  }
  .reseller-audit-card td.ts { font-family: var(--mono, ui-monospace, monospace); color: var(--text-tertiary); white-space: nowrap; }
  .reseller-audit-card td.empty { text-align: center; color: var(--text-muted); padding: 24px; }
  .event-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(0,201,219,0.15);
    color: var(--accent-text);
    font-family: var(--mono, ui-monospace, monospace);
  }
  .actor-email { color: var(--text-tertiary); font-size: 12px; }
  .meta-preview { font-size: 12px; color: var(--text-tertiary); font-family: var(--mono, ui-monospace, monospace); }
  .meta-more { color: var(--text-muted); font-size: 11px; }
  .reseller-audit-pagination {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
    font-size: 13px;
    color: var(--text-tertiary);
  }
  .reseller-audit-pagination .btn-secondary {
    background: transparent;
    border: 1px solid var(--border-primary);
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: 6px;
    text-decoration: none;
    font-size: 12px;
  }
  .reseller-audit-pagination .btn-secondary:hover { color: var(--text-primary); border-color: var(--border-hover); }
  .reseller-audit-pagination .btn-secondary.disabled { opacity: 0.4; pointer-events: none; }
`;
