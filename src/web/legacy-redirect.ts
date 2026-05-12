/**
 * Legacy URL redirect: /settings/team/<x> + /settings/billing → /org/<x>.
 *
 * The IA hoist (2026-05-12) moved 11 team-management routes from
 * /settings/team/* to /org/* with permanent 301 redirects so external
 * bookmarks resolve forever. This is the pure transform extracted for
 * unit-testability; the Fastify onRequest hook in routes.ts is a thin
 * wrapper that emits the redirect when this function returns non-null.
 *
 * Bounded applicability: if a future redirect needs per-route transform
 * logic (query-param rewrite, segment add/remove), break that one out
 * as an explicit handler. Don't collapse a future per-route transform
 * into this general function just to preserve single-source.
 *
 * @param url - The request URL (path + optional query string)
 * @returns The redirect target URL, or null if no redirect applies
 */
export function legacyOrgRedirectTarget(url: string): string | null {
  if (url === '/settings/team' || url.startsWith('/settings/team/') || url.startsWith('/settings/team?')) {
    return url.replace(/^\/settings\/team/, '/org');
  }
  if (url === '/settings/billing' || url.startsWith('/settings/billing/') || url.startsWith('/settings/billing?')) {
    return url.replace(/^\/settings\/billing/, '/org/billing');
  }
  return null;
}
