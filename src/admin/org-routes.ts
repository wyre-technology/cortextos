import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin, requireAdminMutation, getOrSetCsrfToken, csrfHiddenInput } from '../lib/admin-auth.js';
import type { OrgService } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { CreditService } from '../billing/credit-service.js';
import type { AdminAuditService } from '../audit/admin-audit-service.js';
import { renderAdminPage } from './layout.js';
import { FEATURES, PLAN_RANK, type FeatureKey, type Plan } from '../billing/features.js';
import { getSql, runAsSystem } from '../db/context.js';
import { config as configForRoutes } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLASH_OK = 'flash_ok';
const FLASH_ERR = 'flash_err';

function actorEmailFromRequest(request: FastifyRequest): string {
  return request.auth0User?.email ?? 'bearer:scripts';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function flashFromQuery(query: Record<string, string | undefined>): string {
  const ok = query[FLASH_OK];
  const err = query[FLASH_ERR];
  if (ok) return `<div class="alert alert-ok">${escapeHtml(ok)}</div>`;
  if (err) return `<div class="alert alert-err">${escapeHtml(err)}</div>`;
  return '';
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '<span class="muted">—</span>';
  try {
    return new Date(s).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  } catch {
    return escapeHtml(s);
  }
}

function planBadge(plan: string): string {
  const cls = plan === 'business' || plan === 'pro' || plan === 'free' ? `badge-${plan}` : 'badge-free';
  return `<span class="badge ${cls}">${escapeHtml(plan)}</span>`;
}

function shortId(id: string | null | undefined, n = 14): string {
  if (!id) return '<span class="muted">—</span>';
  return `<code class="mono">${escapeHtml(id.slice(0, n))}${id.length > n ? '…' : ''}</code>`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface AdminOrgRoutesDeps {
  orgService: OrgService;
  billingGate: BillingGate;
  creditService: CreditService;
  adminAuditService: AdminAuditService;
}

interface OrgListRow {
  id: string;
  name: string;
  plan: string;
  owner_id: string;
  owner_email: string | null;
  owner_name: string | null;
  member_count: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
}

interface NewOrgRow {
  id: string;
  name: string;
  plan: string;
  owner_email: string | null;
  owner_name: string | null;
  created_at: string;
  member_count: string;
  first_tool_call_at: string | null;
}

interface AuditEntryRow {
  id: string;
  org_id: string;
  org_name: string | null;
  actor_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export function adminOrgRoutes(deps: AdminOrgRoutesDeps) {
  const { orgService, creditService, adminAuditService } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // GET /admin/orgs — search & list
    // -----------------------------------------------------------------------
    app.get<{ Querystring: { q?: string; flash_ok?: string; flash_err?: string } }>(
      '/admin/orgs',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;

        const q = (request.query.q ?? '').trim();
        // Platform-wide org list — system-path (BYPASSRLS). requireAdmin
        // above is the gate. The list is intentionally cross-org.
        const rows = await runAsSystem<OrgListRow[]>(() => {
          if (q) {
            const like = `%${q}%`;
            return getSql()<OrgListRow[]>`
              SELECT
                o.id, o.name, o.plan, o.owner_id, o.stripe_customer_id, o.stripe_subscription_id, o.created_at,
                u.email AS owner_email, u.name AS owner_name,
                (SELECT COUNT(*)::text FROM org_members m WHERE m.org_id = o.id) AS member_count
              FROM organizations o
              LEFT JOIN users u ON u.id = o.owner_id
              WHERE o.name ILIKE ${like}
                 OR o.id   ILIKE ${like}
                 OR u.email ILIKE ${like}
                 OR o.stripe_customer_id ILIKE ${like}
              ORDER BY o.created_at DESC
              LIMIT 50
            `;
          }
          return getSql()<OrgListRow[]>`
            SELECT
              o.id, o.name, o.plan, o.owner_id, o.stripe_customer_id, o.stripe_subscription_id, o.created_at,
              u.email AS owner_email, u.name AS owner_name,
              (SELECT COUNT(*)::text FROM org_members m WHERE m.org_id = o.id) AS member_count
            FROM organizations o
            LEFT JOIN users u ON u.id = o.owner_id
            ORDER BY o.created_at DESC
            LIMIT 50
          `;
        });

        const tableRows = rows
          .map(
            (r) => `
              <tr>
                <td><a class="mono" href="/admin/orgs/${r.id}">${escapeHtml(r.name)}</a></td>
                <td>${escapeHtml(r.owner_email ?? r.owner_id)}</td>
                <td>${planBadge(r.plan)}</td>
                <td class="num">${r.member_count}</td>
                <td>${shortId(r.stripe_subscription_id)}</td>
                <td class="muted">${fmtDate(r.created_at)}</td>
              </tr>`,
          )
          .join('');

        const body = `
          <div class="header">
            <div>
              <h1>Organisations</h1>
              <div class="subtitle">${rows.length} result${rows.length === 1 ? '' : 's'}${q ? ` for “${escapeHtml(q)}”` : ' (most-recent 50)'}</div>
            </div>
          </div>
          ${flashFromQuery(request.query)}
          <form method="get" class="filters">
            <label>
              Search
              <input class="input" type="text" name="q" value="${escapeHtml(q)}"
                     placeholder="org name · id · owner email · Stripe customer id"
                     style="min-width:420px" />
            </label>
            <button class="btn-primary" type="submit">Search</button>
          </form>
          <div class="section">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Org</th>
                    <th>Owner</th>
                    <th>Plan</th>
                    <th class="num">Members</th>
                    <th>Subscription</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>${tableRows || '<tr><td colspan="6" class="empty">No matches</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        `;
        return reply.type('text/html').send(renderAdminPage({ title: 'Orgs', activePath: '/admin/orgs', body }));
      },
    );

    // -----------------------------------------------------------------------
    // GET /admin/orgs/new — recent signups
    // -----------------------------------------------------------------------
    app.get('/admin/orgs/new', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      // Platform-wide signup list — system-path (BYPASSRLS). requireAdmin
      // above is the gate; the list is intentionally cross-org.
      const rows = await runAsSystem(() => getSql()<NewOrgRow[]>`
        SELECT
          o.id, o.name, o.plan, o.created_at,
          u.email AS owner_email, u.name AS owner_name,
          (SELECT COUNT(*)::text FROM org_members m WHERE m.org_id = o.id) AS member_count,
          (SELECT MIN(rl.created_at) FROM request_log rl
            WHERE rl.org_id = o.id
              AND rl.tool_name IS NOT NULL
              AND rl.tool_name NOT IN ('initialize','notifications/initialized','tools/list','tools/call','prompts/list','resources/list','ping')
              AND rl.vendor_slug NOT IN ('_unified','_gateway')) AS first_tool_call_at
        FROM organizations o
        LEFT JOIN users u ON u.id = o.owner_id
        WHERE o.created_at >= NOW() - INTERVAL '30 days'
        ORDER BY o.created_at DESC
        LIMIT 100
      `);
      const tableRows = rows
        .map(
          (r) => `
            <tr>
              <td class="muted">${fmtDate(r.created_at)}</td>
              <td><a class="mono" href="/admin/orgs/${r.id}">${escapeHtml(r.name)}</a></td>
              <td>${escapeHtml(r.owner_email ?? '—')}${r.owner_name ? ` <span class="muted">(${escapeHtml(r.owner_name)})</span>` : ''}</td>
              <td>${planBadge(r.plan)}</td>
              <td class="num">${r.member_count}</td>
              <td class="muted">${fmtDate(r.first_tool_call_at)}</td>
            </tr>`,
        )
        .join('');
      const body = `
        <div class="header">
          <div>
            <h1>New orgs</h1>
            <div class="subtitle">${rows.length} signup${rows.length === 1 ? '' : 's'} in the last 30 days</div>
          </div>
        </div>
        <div class="section">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Org</th>
                  <th>Owner</th>
                  <th>Plan</th>
                  <th class="num">Members</th>
                  <th>First real tool call</th>
                </tr>
              </thead>
              <tbody>${tableRows || '<tr><td colspan="6" class="empty">No signups in the last 30 days</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      `;
      return reply.type('text/html').send(renderAdminPage({ title: 'New orgs', activePath: '/admin/orgs/new', body }));
    });

    // -----------------------------------------------------------------------
    // GET /admin/audit — admin audit log
    // -----------------------------------------------------------------------
    app.get('/admin/audit', async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      // Platform-wide audit log — system-path (BYPASSRLS). admin_audit_log is
      // FORCE-RLS; requireAdmin above is the gate, the view is cross-org.
      const rows = await runAsSystem(() => getSql()<AuditEntryRow[]>`
        SELECT
          a.id, a.org_id, a.actor_id, a.event_type, a.metadata, a.created_at,
          o.name AS org_name
        FROM admin_audit_log a
        LEFT JOIN organizations o ON o.id = a.org_id
        ORDER BY a.created_at DESC
        LIMIT 100
      `);
      const tableRows = rows
        .map(
          (r) => `
            <tr>
              <td class="muted">${fmtDate(r.created_at)}</td>
              <td>${escapeHtml(r.actor_id)}</td>
              <td><span class="vendor-tag">${escapeHtml(r.event_type)}</span></td>
              <td>${r.org_name ? `<a class="mono" href="/admin/orgs/${r.org_id}">${escapeHtml(r.org_name)}</a>` : '<span class="muted">—</span>'}</td>
              <td class="mono muted">${r.metadata ? escapeHtml(JSON.stringify(r.metadata)) : '—'}</td>
            </tr>`,
        )
        .join('');
      const body = `
        <div class="header">
          <div>
            <h1>Admin audit log</h1>
            <div class="subtitle">Most-recent 100 entries</div>
          </div>
        </div>
        <div class="section">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Org</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>${tableRows || '<tr><td colspan="5" class="empty">No entries</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      `;
      return reply.type('text/html').send(renderAdminPage({ title: 'Audit log', activePath: '/admin/audit', body }));
    });

    // -----------------------------------------------------------------------
    // GET /admin/orgs/:orgId — detail
    // -----------------------------------------------------------------------
    app.get<{ Params: { orgId: string }; Querystring: { flash_ok?: string; flash_err?: string } }>(
      '/admin/orgs/:orgId',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const orgId = request.params.orgId;
        // Admin views ANY org's detail — they are not a member of it, so the
        // reads must run system-path (BYPASSRLS). Every query below filters
        // by the :orgId / org.ownerId param explicitly, so BYPASSRLS returns
        // only the target org's rows. requireAdmin above is the gate.
        const org = await runAsSystem(() => orgService.getOrg(orgId));
        if (!org) {
          return reply
            .code(404)
            .type('text/html')
            .send(
              renderAdminPage({
                title: 'Org',
                activePath: '/admin/orgs',
                body: '<div class="header"><div><h1>Not found</h1><div class="subtitle">No org with that id</div></div></div>',
              }),
            );
        }

        // System-path: the admin is not a member of this org. Every query
        // here filters by orgId / org.ownerId explicitly, so BYPASSRLS still
        // returns only the target org's rows.
        const [members, usage, features, ownerRows, recentLogs, recentAudit] =
          await runAsSystem(() => Promise.all([
            orgService.getMembersWithProfiles(orgId),
            // usage-log count this month (analytics substrate, not a customer
            // credit balance — flat-pricing removed credit allocation/blocks).
            creditService.getUsageThisMonth(orgId),
            // featureSummary not yet implemented in Conduit's BillingGate — derive
            // a minimal map from the FEATURES registry against org plan so the
            // panel renders without per-feature override resolution.
            Promise.resolve(
              Object.fromEntries(
                (Object.keys(FEATURES) as FeatureKey[]).map((k) => [
                  k,
                  PLAN_RANK[org.plan as Plan] >= PLAN_RANK[FEATURES[k].minPlan],
                ]),
              ) as Record<FeatureKey, boolean>,
            ),
            getSql()<{ email: string | null; name: string | null }[]>`
              SELECT email, name FROM users WHERE id = ${org.ownerId} LIMIT 1
            `,
            getSql()<{ created_at: string; vendor_slug: string; tool_name: string | null; status_code: number; user_email: string | null }[]>`
              SELECT rl.created_at, rl.vendor_slug, rl.tool_name, rl.status_code, u.email AS user_email
              FROM request_log rl
              LEFT JOIN users u ON u.id = rl.user_id
              WHERE rl.org_id = ${orgId}
                AND rl.tool_name IS NOT NULL
                AND rl.tool_name NOT IN ('initialize','notifications/initialized','tools/list','tools/call','prompts/list','resources/list','ping')
                AND rl.vendor_slug NOT IN ('_unified','_gateway')
              ORDER BY rl.created_at DESC
              LIMIT 20
            `,
            getSql()<AuditEntryRow[]>`
              SELECT id, org_id, actor_id, event_type, metadata, created_at,
                     NULL::text AS org_name
              FROM admin_audit_log
              WHERE org_id = ${orgId}
              ORDER BY created_at DESC
              LIMIT 10
            `,
          ]));

        const owner = ownerRows[0] ?? { email: null, name: null };

        const memberRows = members
          .map(
            (m: typeof members[number]) => `
              <tr>
                <td>${escapeHtml(m.email ?? m.userId)}${m.name ? ` <span class="muted">(${escapeHtml(m.name)})</span>` : ''}</td>
                <td><span class="vendor-tag">${escapeHtml(m.role)}</span></td>
                <td class="muted">${fmtDate(m.joinedAt ?? m.createdAt)}</td>
              </tr>`,
          )
          .join('');

        const featureRows = (Object.keys(FEATURES) as FeatureKey[])
          .map((k) => {
            const enabled = features[k];
            const dot = enabled
              ? '<span class="feature-on">●</span>'
              : '<span class="feature-off">○</span>';
            return `
              <div class="feature-row">
                ${dot}
                <span>${escapeHtml(FEATURES[k].label)}</span>
                <code class="mono muted">${k}</code>
                <span class="muted">min ${escapeHtml(FEATURES[k].minPlan)}</span>
              </div>`;
          })
          .join('');

        const recentRows = recentLogs
          .map(
            (l: typeof recentLogs[number]) => `
              <tr>
                <td class="muted">${fmtDate(l.created_at)}</td>
                <td>${escapeHtml(l.user_email ?? '—')}</td>
                <td><span class="vendor-tag">${escapeHtml(l.vendor_slug)}</span></td>
                <td class="mono">${escapeHtml(l.tool_name ?? '')}</td>
                <td class="num">${l.status_code}</td>
              </tr>`,
          )
          .join('');

        const auditRows = recentAudit
          .map(
            (a: typeof recentAudit[number]) => `
              <tr>
                <td class="muted">${fmtDate(a.created_at)}</td>
                <td>${escapeHtml(a.actor_id)}</td>
                <td><span class="vendor-tag">${escapeHtml(a.event_type)}</span></td>
                <td class="mono muted">${a.metadata ? escapeHtml(JSON.stringify(a.metadata)) : '—'}</td>
              </tr>`,
          )
          .join('');

        // Grandfathered seat-billing banner intentionally omitted — Conduit's
        // Organization shape doesn't surface that column yet.
        const grandfatherBanner = '';

        const enabledFeatures = Object.values(features).filter(Boolean).length;
        const totalFeatures = Object.keys(FEATURES).length;

        const body = `
          <div class="header">
            <div>
              <h1>${escapeHtml(org.name)}</h1>
              <div class="subtitle"><code class="mono">${org.id}</code></div>
            </div>
            <div>${planBadge(org.plan)}</div>
          </div>
          ${flashFromQuery(request.query)}
          ${grandfatherBanner}

          <div class="org-detail-grid">
            <div class="panel">
              <div class="section-title">Plan & billing</div>
              <p>Plan: ${planBadge(org.plan)}</p>
              <p>Stripe customer: ${shortId(org.stripeCustomerId, 24)}</p>
              <p>Stripe subscription: ${shortId(org.stripeSubscriptionId, 24)}</p>
              <p>Created: <span class="muted">${fmtDate(org.createdAt)}</span></p>
            </div>
            <div class="panel">
              <div class="section-title">Owner</div>
              <p>${escapeHtml(owner.email ?? org.ownerId)}${owner.name ? ` <span class="muted">(${escapeHtml(owner.name)})</span>` : ''}</p>
              <p class="muted">Created ${fmtDate(org.createdAt)}</p>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Usage this month</div>
            <div class="panel">
              <p><strong>${usage.toLocaleString()}</strong> vendor tool calls (usage log). Flat-pricing: no credit allocation or balance — usage is unmetered for the customer; this count feeds reseller-wholesale invoicing + analytics.</p>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Features (${enabledFeatures} / ${totalFeatures})</div>
            <div class="panel">${featureRows}</div>
          </div>

          <div class="section">
            <div class="section-title">Members (${members.length})</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
                <tbody>${memberRows || '<tr><td colspan="3" class="empty">No members</td></tr>'}</tbody>
              </table>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Last 20 real tool calls</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>When</th><th>User</th><th>Vendor</th><th>Tool</th><th class="num">Status</th></tr></thead>
                <tbody>${recentRows || '<tr><td colspan="5" class="empty">No tool calls yet</td></tr>'}</tbody>
              </table>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Last 10 admin actions</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Metadata</th></tr></thead>
                <tbody>${auditRows || '<tr><td colspan="4" class="empty">None</td></tr>'}</tbody>
              </table>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Danger zone</div>
            <div class="panel">
              <p class="muted">Permanently delete this org and all of its data (members, credentials, audit log, tool allowlists, service clients, log-shipping configs). A forensic stub remains in <code class="mono">deleted_orgs</code>. This cannot be undone.</p>
              <p>
                <a class="btn-danger" href="/admin/orgs/${org.id}/delete">Delete org…</a>
              </p>
            </div>
          </div>
        `;
        return reply.type('text/html').send(
          renderAdminPage({ title: `Org · ${org.name}`, activePath: '/admin/orgs', body }),
        );
      },
    );

    // comp-credits admin action removed with flat-pricing (no customer
    // credit balance to comp; the credit_blocks table is dropped). Usage is
    // unmetered for the customer — nothing to grant.

    // -----------------------------------------------------------------------
    // GET /admin/orgs/:orgId/delete — confirmation page (type-the-name)
    // -----------------------------------------------------------------------
    app.get<{ Params: { orgId: string }; Querystring: { flash_err?: string } }>(
      '/admin/orgs/:orgId/delete',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const csrfToken = getOrSetCsrfToken(request, reply);
        // System-path: admin views the delete-confirm for any org. getOrg is
        // scoped to the :orgId param. requireAdmin above is the gate.
        const org = await runAsSystem(() => orgService.getOrg(request.params.orgId));
        if (!org) {
          return reply.code(404).type('text/html').send(
            renderAdminPage({
              title: 'Org',
              activePath: '/admin/orgs',
              body: '<div class="header"><div><h1>Not found</h1></div></div>',
            }),
          );
        }

        const blocked = !!org.stripeSubscriptionId;
        const blockedNotice = blocked
          ? `<div class="alert alert-err">
               This org has an active Stripe subscription
               (<code class="mono">${escapeHtml(org.stripeSubscriptionId!)}</code>).
               Cancel it in Stripe (or null the column) before deleting.
             </div>`
          : '';

        const body = `
          <div class="header">
            <div>
              <h1>Delete org</h1>
              <div class="subtitle">${escapeHtml(org.name)} · <code class="mono">${org.id}</code></div>
            </div>
          </div>
          ${flashFromQuery(request.query)}
          ${blockedNotice}
          <div class="section">
            <div class="panel">
              <p>This will permanently delete the org and cascade to:</p>
              <ul>
                <li>org_members (memberships)</li>
                <li>org_credentials (vendor secrets)</li>
                <li>admin_audit_log (per-org audit history)</li>
                <li>org_tool_allowlist, org_server_access, org_teams</li>
                <li>service_clients, org_invitations, org_feature_overrides</li>
                <li>log-shipping configs, comp credit ledger, subscriptions</li>
              </ul>
              <p>A row in <code class="mono">deleted_orgs</code> will be kept for forensic lookup. The owner's <code class="mono">users</code> row is NOT deleted.</p>
              <form method="post" action="/admin/orgs/${org.id}/delete">
                ${csrfHiddenInput(csrfToken)}
                <p>
                  <label>
                    Type the org name to confirm: <strong>${escapeHtml(org.name)}</strong><br/>
                    <input class="input" type="text" name="confirm_name" autocomplete="off" required style="min-width:420px" />
                  </label>
                </p>
                <p>
                  <label>
                    Reason (optional, for the deleted_orgs record)<br/>
                    <input class="input" type="text" name="reason" maxlength="500" style="min-width:420px" />
                  </label>
                </p>
                <p>
                  <a class="btn-secondary" href="/admin/orgs/${org.id}">Cancel</a>
                  <button class="btn-danger" type="submit"${blocked ? ' disabled' : ''}>Permanently delete</button>
                </p>
              </form>
            </div>
          </div>
        `;
        return reply.type('text/html').send(
          renderAdminPage({ title: `Delete · ${org.name}`, activePath: '/admin/orgs', body }),
        );
      },
    );

    // -----------------------------------------------------------------------
    // GET /admin/orgs/create — admin create-org form (WYREAI-120 UI canary,
    // closes E1 launch-blocker WYREAI-117).
    //
    // Renders the form that POSTs to /admin/orgs (WYREAI-118+119 backend).
    // Form fields mirror the POST handler's expected body shape: name,
    // owner_email, org_type, plan. CSRF token included; client-side
    // hint copy explains the stub-owner→invitation-transfer flow so the
    // admin understands their email won't be the final owner.
    //
    // Path choice: /admin/orgs/create — /admin/orgs/new is taken by the
    // recent-signups dashboard (per round-2 grounding catch 2026-06-02).
    // Path-naming sub-pin: 'admin/X/new' is conventionally
    // recently-created-X listing in conduit's admin URLs;
    // 'admin/X/create' is the create-form page. Distinction preserved.
    // -----------------------------------------------------------------------
    app.get<{ Querystring: { flash_err?: string } }>(
      '/admin/orgs/create',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const csrfToken = getOrSetCsrfToken(request, reply);
        const flashErr = (request.query.flash_err ?? '').trim();
        const errBlock = flashErr
          ? `<div class="flash flash-err">${escapeHtml(flashErr)}</div>`
          : '';
        const body = `
          <div class="header">
            <div>
              <h1>Create org</h1>
              <div class="subtitle">Admin-creates an org with a placeholder stub-owner, then sends an invitation to the intended owner. The invited user receives ownership atomically when they accept (NARROWED DELETE swap from admin-stub → invited user per the invitation-driven ownership-transfer flow).</div>
            </div>
          </div>
          ${errBlock}
          <div class="section">
            <form method="post" action="/admin/orgs">
              ${csrfHiddenInput(csrfToken)}
              <p>
                <label>
                  Org name<br/>
                  <input class="input" type="text" name="name" required autocomplete="off" maxlength="200" style="min-width:420px" />
                </label>
              </p>
              <p>
                <label>
                  Owner email (recipient of the invitation)<br/>
                  <input class="input" type="email" name="owner_email" required autocomplete="off" maxlength="320" style="min-width:420px" />
                </label>
              </p>
              <p>
                <label>
                  Org type<br/>
                  <select class="input" name="org_type" required>
                    <option value="reseller">reseller (default — MSP customer)</option>
                    <option value="standalone">standalone (direct customer)</option>
                  </select>
                </label>
                <span class="muted">Customer orgs are reseller-driven; admin-create allows reseller + standalone only.</span>
              </p>
              <p>
                <label>
                  Plan<br/>
                  <input class="input" type="text" name="plan" value="conduit" maxlength="100" style="min-width:200px" />
                </label>
              </p>
              <p>
                <button type="submit" class="btn-primary">Create org + send invitation</button>
                &nbsp;
                <a href="/admin/orgs" class="btn-secondary">Cancel</a>
              </p>
              <p class="muted" style="margin-top:24px;font-size:13px">
                <strong>What happens:</strong> Conduit creates the org with you (the admin) as the placeholder stub-owner.
                A 7-day invitation is generated and surfaced as a flash on the next page — copy the URL and send to
                the intended owner out-of-band (email, Slack, etc.). When they accept the invitation (after signing in
                with the email above), ownership atomically transfers from you to them. Until accepted, you remain owner;
                you can re-issue the invitation if needed.
              </p>
            </form>
          </div>
        `;
        return reply.type('text/html').send(
          renderAdminPage({ title: 'Create org', activePath: '/admin/orgs', body }),
        );
      },
    );

    // -----------------------------------------------------------------------
    // POST /admin/orgs — admin create org with stub-owner + invitation transfer
    // (WYREAI-118 + WYREAI-119, E1 PR-1 backend collapse under WYREAI-117
    // admin create-org launch-blocker).
    //
    // Flow:
    //   1. Admin POSTs name + owner_email + org_type. Gated on
    //      requireAdminMutation (admin role + CSRF).
    //   2. Org is created with the ADMIN as a placeholder stub-owner
    //      (NOT the invited user — admin-creating an org for an
    //      unverified email cannot directly bind ownership). The admin's
    //      sub is recorded as swap_from_user_id on the invitation.
    //   3. An invitation of type='owner_swap_to_invited' is created with
    //      intendedRole='owner', recipientEmail=owner_email,
    //      swapFromUserId=admin.sub. The plain token is embedded in the
    //      invite URL surfaced to the admin via flash.
    //   4. When the invited user accepts (with email-match check), the
    //      NARROWED-DELETE atomic-swap replaces the admin-stub owner
    //      with the invited user. See invitation-service.ts acceptInvitation
    //      and the warden warning cited there.
    //
    // SECURITY DISCIPLINE: invitation-flow IS the ownership-grant path,
    // not direct owner-binding at admin-create. Admin retains owner
    // membership ONLY until invited user accepts; admin's email-match
    // mismatch would prevent admin themselves from accepting (intended
    // behavior — admin must hand off via the invite URL).
    // -----------------------------------------------------------------------
    app.post<{
      Body: {
        name?: string;
        owner_email?: string;
        plan?: string;
        org_type?: string;
      };
    }>('/admin/orgs', async (request, reply) => {
      if (!requireAdminMutation(request, reply)) return;

      const adminSub = request.auth0User?.sub;
      if (!adminSub) {
        // requireAdminMutation already gates this; defense-in-depth.
        return reply.redirect(
          `/admin/orgs?flash_err=${encodeURIComponent('Admin session not found')}`,
        );
      }

      const name = (request.body.name ?? '').trim();
      const ownerEmail = (request.body.owner_email ?? '').trim();
      const plan = (request.body.plan ?? 'conduit').trim() || 'conduit';
      const orgType = (request.body.org_type ?? 'reseller').trim();

      const errs: string[] = [];
      if (!name) errs.push('name is required');
      if (!ownerEmail || !ownerEmail.includes('@') || ownerEmail.length > 320) {
        errs.push('owner_email must look like an email address');
      }
      // Allowlist of admin-creatable org types. Customer orgs are reseller-
      // driven (created via POST /admin/reseller/:resellerId/customers, not
      // here); admin-create allows reseller + standalone only. Mirrors
      // OrgService.createOrg's hierarchy-validation at the route boundary.
      if (orgType !== 'reseller' && orgType !== 'standalone') {
        errs.push("org_type must be 'reseller' or 'standalone'");
      }
      if (errs.length > 0) {
        return reply.redirect(
          `/admin/orgs?flash_err=${encodeURIComponent(errs.join('; '))}`,
        );
      }

      const actorEmail = actorEmailFromRequest(request);
      let newOrgId: string;
      let inviteUrl: string;
      try {
        // 1. Create org with admin as placeholder stub-owner.
        const newOrg = await runAsSystem(() =>
          orgService.createOrg(
            name,
            adminSub,
            plan,
            {
              type: orgType as 'reseller' | 'standalone',
              parentOrgId: null,
            },
            request.log,
          ),
        );
        newOrgId = newOrg.id;

        // 2. Create owner-swap invitation. createInvitation runs the
        // owner-mint authz guard — admin IS the current owner of the
        // just-created org, so the guard passes. The invitation carries
        // inviteType='owner_swap_to_invited' + swapFromUserId=admin.sub
        // so acceptInvitation uses the NARROWED-DELETE branch.
        const { plainToken } = await runAsSystem(() =>
          orgService.createInvitation(newOrg.id, adminSub, {
            intendedRole: 'owner',
            recipientEmail: ownerEmail,
            inviteType: 'owner_swap_to_invited',
            swapFromUserId: adminSub,
          }),
        );
        inviteUrl = `${configForRoutes.baseUrl}/invite/${plainToken}`;

        // 3. Audit
        await runAsSystem(() =>
          adminAuditService.log({
            orgId: newOrg.id,
            actorId: actorEmail,
            eventType: 'org_created_by_admin',
            metadata: {
              name,
              org_type: orgType,
              plan,
              invited_owner_email: ownerEmail,
              stub_owner_user_id: adminSub,
            },
          }),
        );
        request.log.info(
          { orgId: newOrg.id, actorEmail, ownerEmail, orgType, plan },
          'admin created org with owner-swap invitation',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        request.log.error({ err, name, ownerEmail, orgType }, 'admin org-create failed');
        return reply.redirect(
          `/admin/orgs?flash_err=${encodeURIComponent(`Create failed: ${msg}`)}`,
        );
      }

      // 4. Redirect to org detail with invite URL in flash. Plain token
      //    appears once; admin can copy the URL from the flash to hand
      //    off out-of-band (email/Slack/etc).
      return reply.redirect(
        `/admin/orgs/${newOrgId}?flash_ok=${encodeURIComponent(
          `Created org "${name}". Invitation URL (give to ${ownerEmail}): ${inviteUrl}`,
        )}`,
      );
    });

    // -----------------------------------------------------------------------
    // POST /admin/orgs/:orgId/delete — execute hard delete
    // -----------------------------------------------------------------------
    app.post<{
      Params: { orgId: string };
      Body: { confirm_name?: string; reason?: string };
    }>('/admin/orgs/:orgId/delete', async (request, reply) => {
      if (!requireAdminMutation(request, reply)) return;
      const orgId = request.params.orgId;
      const confirmName = (request.body.confirm_name ?? '').trim();
      const reason = (request.body.reason ?? '').trim() || undefined;

      // Admin deletes an org they are not a member of — system-path
      // (BYPASSRLS). requireAdminMutation above is the gate; getOrg /
      // deleteOrg / the audit write are all scoped to the :orgId param.
      const org = await runAsSystem(() => orgService.getOrg(orgId));
      const back = (qs: string) => reply.redirect(`/admin/orgs/${orgId}/delete?${qs}`);
      if (!org) {
        return reply.redirect(`/admin/orgs?flash_err=${encodeURIComponent('Org not found')}`);
      }
      if (confirmName !== org.name) {
        return back(`flash_err=${encodeURIComponent('Org name did not match')}`);
      }

      const actorEmail = actorEmailFromRequest(request);
      try {
        // Conduit's OrgService doesn't yet expose a forensic deleteOrgWithAudit
        // helper. Hard-delete + write a separate audit row.
        const ok = await runAsSystem(() => orgService.deleteOrg(orgId));
        if (!ok) throw new Error('org_delete_failed');
        await runAsSystem(() => adminAuditService.log({
          orgId,
          actorId: actorEmail,
          eventType: 'org_deleted',
          metadata: { reason, deleted_name: org.name },
        }));
        request.log.info({ orgId, actorEmail, reason }, 'admin hard-deleted org');
      } catch (err) {
        const code = err instanceof Error ? err.message : 'unknown';
        if (code === 'stripe_subscription_active') {
          return back(`flash_err=${encodeURIComponent('Refused: cancel the Stripe subscription first')}`);
        }
        request.log.error({ err, orgId }, 'org delete failed');
        return back(`flash_err=${encodeURIComponent('Delete failed, see logs')}`);
      }

      return reply.redirect(
        `/admin/orgs?flash_ok=${encodeURIComponent(`Deleted org "${org.name}"`)}`,
      );
    });
  };
}
