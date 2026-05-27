// Vendor container health — view-model types + pure presentation mappings.
//
// Decision-independent foundation for the tenant-facing vendor-health UI
// (scoping doc: orgs/wyre/agents/pearl/memory/2026-05-16-vendor-container-
// health-ui-scoping.md). The endpoint contract is frozen by dev's Track C
// observability work (GET /api/orgs/:orgId/vendor-health); the open UX
// decision points (§6 of the scoping doc) do NOT touch this module — they
// shape the surrounding template, not the status→dot/label spine.
//
// This module is the spine: the consumed shape + the status-to-presentation
// pure functions. It is safe to land ahead of the UX-decision answers.

import type { VendorHealthState, VendorHealth } from '../monitoring/vendor-monitor.js';

/**
 * Health status of a vendor's backing MCP container. Aliased from the
 * monitor's `VendorHealthState` (single source of truth for the union —
 * cross-author contract conformance, not a redeclared copy).
 *  - healthy  — up + fast
 *  - degraded — up but slow, or 1–2 consecutive failures before the down threshold
 *  - down     — ≥3 consecutive failed probes
 *  - unknown  — not yet probed (just connected / probe pending)
 */
export type VendorHealthStatus = VendorHealthState;

/**
 * One vendor's health (response shape of GET /api/orgs/:orgId/vendor-health,
 * envelope `{ vendors: VendorHealth[] }`). Canonical definition lives in the
 * monitoring domain (`vendor-monitor.ts`); re-exported here so view consumers
 * import the shape from one place.
 */
export type { VendorHealth };

function assertNever(x: never): never {
  throw new Error('Unhandled vendor health status: ' + JSON.stringify(x));
}

/**
 * CSS modifier class for the status dot. Pairs with `.vc-dot` in
 * team-connections.ts / personal-connections.ts. The exact dot colors are
 * a Ruby design-token item; this function only owns the class name.
 */
export function statusDotClass(status: VendorHealthStatus): string {
  switch (status) {
    case 'healthy':   return 'vc-dot-healthy';
    case 'reachable': return 'vc-dot-reachable';
    case 'degraded':  return 'vc-dot-degraded';
    case 'down':      return 'vc-dot-down';
    case 'unknown':   return 'vc-dot-unknown';
    default:          return assertNever(status);
  }
}

/**
 * Tenant-facing status label. Dignified, plain-language copy — "Not
 * responding" not "FAILED" — consistent with the dunning-copy voice.
 */
export function statusLabel(status: VendorHealthStatus): string {
  switch (status) {
    case 'healthy':   return 'Connected';
    case 'reachable': return 'Reachable';
    case 'degraded':  return 'Degraded';
    case 'down':      return 'Not responding';
    case 'unknown':   return 'Checking…';
    default:          return assertNever(status);
  }
}

/**
 * True when the status carries actionable error context worth surfacing
 * in the hover/click affordance. `errorDetail` is only populated by the
 * endpoint for these states.
 */
export function hasErrorContext(status: VendorHealthStatus): boolean {
  return status === 'degraded' || status === 'down';
}

/**
 * Relative-time staleness string from an ISO 8601 timestamp:
 * "just now", "2m ago", "3h ago", "2d ago". Surfaced next to the dot so
 * a tenant can tell a healthy-but-stale check from a fresh one. Null
 * input (a vendor never probed) renders "never checked".
 */
export function formatLastChecked(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'never checked';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffMs = Math.max(0, now.getTime() - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Status-dot CSS — the 4-state modifier classes per Ruby's canonical
 * token spec (2026-05-16-health-state-dot-tokens.md). They modify the
 * existing `.vc-dot` base in team-connections.ts / personal-connections.ts.
 *
 * Treatment rule (from the spec):
 *   - healthy / degraded / down → soft static glow ring ("live reading").
 *     Static, never animated — calm-escalation.
 *   - unknown → flat, no ring ("no reading = no live signal").
 *   - Dot colors are constant across light/dark (saturated enough).
 *   - Ring alpha 0.25 on dark (default), 0.20 on light (`.light` override).
 *
 * Dot-tuned values — NOT the dunning accent tokens (those are text-tuned
 * and read muddy as a small solid mark). Same hue families, dot-context
 * saturation. Healthy reuses the shipped `--success` untouched.
 */
export const VENDOR_HEALTH_STYLES = `
  .vc-dot-healthy {
    background: var(--success);
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25);
  }
  /* Reachable: container is alive but the credless health-probe was auth-gated
     (401/403). A NEUTRAL/informational token (blue) — distinct from healthy-green,
     degraded-amber, and down-red — so an auth-gated-but-working vendor reads as
     "reachable", not a problem. (Ruby owns the final auth-gated token.) */
  .vc-dot-reachable {
    background: #0ea5e9;
    box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.25);
  }
  .vc-dot-degraded {
    background: var(--warning-text);
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.25);
  }
  .vc-dot-down {
    background: var(--error);
    box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.25);
  }
  .vc-dot-unknown {
    background: #9ca3af;
    box-shadow: none;
  }
  /* Light cards: ring is a low-alpha halo; dark bg eats it slightly, so
     light mode drops the alpha back to the spec's 0.20 baseline. */
  .light .vc-dot-healthy   { box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.20); }
  .light .vc-dot-reachable { box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.20); }
  .light .vc-dot-degraded  { box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.20); }
  .light .vc-dot-down      { box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.20); }
`;
