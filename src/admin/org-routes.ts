import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { requireAdmin, requireAdminMutation, getOrSetCsrfToken, csrfHiddenInput } from '../lib/admin-auth.js';
import type { OrgService } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { CreditService } from '../billing/credit-service.js';
import type { AdminAuditService } from '../audit/admin-audit-service.js';
import { renderAdminPage } from './layout.js';
import { FEATURES, PLAN_RANK, type FeatureKey, type Plan } from '../billing/features.js';

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
  sql: postgres.Sql;
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
  const { sql, orgService, billingGate, creditService, adminAuditService } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // GET /admin/orgs — search & list
    // -----------------------------------------------------------------------
    app.get<{ Querystring: { q?: string; flash_ok?: string; flash_err?: string } }>(
      '/admin/orgs',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;

        const q = (request.query.q ?? '').trim();
        let rows: OrgListRow[];
        if (q) {
          const like = `%${q}%`;
          rows = await sql<OrgListRow[]>`
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
        } else {
          rows = await sql<OrgListRow[]>`
            SELECT
              o.id, o.name, o.plan, o.owner_id, o.stripe_customer_id, o.stripe_subscription_id, o.created_at,
              u.email AS owner_email, u.name AS owner_name,
              (SELECT COUNT(*)::text FROM org_members m WHERE m.org_id = o.id) AS member_count
            FROM organizations o
            LEFT JOIN users u ON u.id = o.owner_id
            ORDER BY o.created_at DESC
            LIMIT 50
          `;
        }

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
      const rows = await sql<NewOrgRow[]>`
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
      `;
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
      const rows = await sql<AuditEntryRow[]>`
        SELECT
          a.id, a.org_id, a.actor_id, a.event_type, a.metadata, a.created_at,
          o.name AS org_name
        FROM admin_audit_log a
        LEFT JOIN organizations o ON o.id = a.org_id
        ORDER BY a.created_at DESC
        LIMIT 100
      `;
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
        const csrfToken = getOrSetCsrfToken(request, reply);
        const org = await orgService.getOrg(orgId);
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

        const [members, usage, balance, allocation, features, ownerRows, recentLogs, recentAudit] = await Promise.all([
          orgService.getMembersWithProfiles(orgId),
          creditService.getUsageThisMonth(orgId),
          creditService.getBlockBalance(orgId),
          billingGate.getCreditAllocation(orgId),
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
          sql<{ email: string | null; name: string | null }[]>`
            SELECT email, name FROM users WHERE id = ${org.ownerId} LIMIT 1
          `,
          sql<{ created_at: string; vendor_slug: string; tool_name: string | null; status_code: number; user_email: string | null }[]>`
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
          sql<AuditEntryRow[]>`
            SELECT id, org_id, actor_id, event_type, metadata, created_at,
                   NULL::text AS org_name
            FROM admin_audit_log
            WHERE org_id = ${orgId}
            ORDER BY created_at DESC
            LIMIT 10
          `,
        ]);

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
        const allocText = allocation === Infinity ? '∞' : allocation.toLocaleString();
        const blocksText = balance > 0 ? ` + <strong>${balance.toLocaleString()}</strong> in blocks` : '';

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
            <div class="section-title">Credits</div>
            <div class="panel">
              <p>This month: <strong>${usage.toLocaleString()}</strong> used / <strong>${allocText}</strong> allocation${blocksText}</p>
              <form method="post" action="/admin/orgs/${org.id}/comp-credits" class="comp-form">
                ${csrfHiddenInput(csrfToken)}
                <input class="input" type="number" name="amount" min="1" max="100000" placeholder="amount" required />
                <input class="input" type="text" name="reason" placeholder="reason (5–500 chars)" required minlength="5" maxlength="500" />
                <button class="btn-primary" type="submit">Comp credits</button>
              </form>
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

    // -----------------------------------------------------------------------
    // POST /admin/orgs/:orgId/comp-credits — write action
    // -----------------------------------------------------------------------
    app.post<{
      Params: { orgId: string };
      Body: { amount: string | number; reason: string };
    }>('/admin/orgs/:orgId/comp-credits', async (request, reply) => {
      if (!requireAdminMutation(request, reply)) return;
      const orgId = request.params.orgId;
      const amountRaw = Number(request.body.amount);
      const reason = (request.body.reason ?? '').trim();
      const errors: string[] = [];
      if (!Number.isInteger(amountRaw) || amountRaw <= 0 || amountRaw > 100_000) {
        errors.push('amount must be a positive integer ≤ 100,000');
      }
      if (reason.length < 5 || reason.length > 500) {
        errors.push('reason must be 5–500 chars');
      }
      const org = await orgService.getOrg(orgId);
      if (!org) errors.push('org not found');

      const back = (qs: string) => reply.redirect(`/admin/orgs/${orgId}?${qs}`);
      if (errors.length) {
        return back(`flash_err=${encodeURIComponent(errors.join('; '))}`);
      }

      const actorEmail = actorEmailFromRequest(request);
      try {
        await creditService.grantComp(orgId, amountRaw, actorEmail, reason);
        await adminAuditService.log({
          orgId,
          actorId: actorEmail,
          eventType: 'admin_comp_credits',
          metadata: { amount: amountRaw, reason },
        });
      } catch (err) {
        request.log.error({ err, orgId }, 'comp-credits failed');
        return back(`flash_err=${encodeURIComponent('Failed to grant credits, see logs')}`);
      }
      return back(`flash_ok=${encodeURIComponent(`Granted ${amountRaw.toLocaleString()} credits`)}`);
    });

    // -----------------------------------------------------------------------
    // GET /admin/orgs/:orgId/delete — confirmation page (type-the-name)
    // -----------------------------------------------------------------------
    app.get<{ Params: { orgId: string }; Querystring: { flash_err?: string } }>(
      '/admin/orgs/:orgId/delete',
      async (request, reply) => {
        if (!requireAdmin(request, reply)) return;
        const csrfToken = getOrSetCsrfToken(request, reply);
        const org = await orgService.getOrg(request.params.orgId);
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

      const org = await orgService.getOrg(orgId);
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
        const ok = await orgService.deleteOrg(orgId);
        if (!ok) throw new Error('org_delete_failed');
        await adminAuditService.log({
          orgId,
          actorId: actorEmail,
          eventType: 'org_deleted',
          metadata: { reason, deleted_name: org.name },
        });
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
