/**
 * Domain claim / verify routes — ported from mcp-gateway
 * (src/org/domain-routes.ts).
 *
 * Two surfaces:
 *   - Org-admin domain management: GET/POST/DELETE /api/orgs/:orgId/domains,
 *     POST /api/orgs/:orgId/domains/:id/verify. Gated on requireOrgRole(admin).
 *   - The claim flow for the current user: GET /api/me/claim-eligibility and
 *     POST /api/me/claim.
 *
 * conduit adaptations vs the gateway original:
 *   - requireOrgRole comes from the shared org-route-helpers.
 *   - The claim membership INSERT runs system-path (runAsSystem): the user is
 *     not yet a member, so org_members RLS would (correctly) block the write
 *     on the request path. The claim itself IS the act of becoming a member.
 *   - The gateway's post-claim Stripe seat-count sync is dropped — conduit has
 *     no syncSeatCount equivalent. (Noted for follow-up if conduit adds
 *     seat-based billing.)
 *
 * The emailVerified gate (claim-eligibility + claim) is the account-takeover
 * guard. conduit's Auth0User.emailVerified is set by BOTH auth providers —
 * Auth0 from the email_verified claim, Azure AD/Entra from a trusted-tenant
 * login (see auth0.ts / azure-ad.ts) — so the claim flow inherits verification
 * from whichever provider the user signed in with, with no per-provider code
 * here.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { OrgService } from './org-service.js';
import { requireOrgRole } from './org-route-helpers.js';
import { OrgDomainService, OrgDomainError } from './domain-service.js';
import type { OrgDomainRole } from './domain-service.js';
import { domainFromEmail } from './public-email-domains.js';
import { getSql, runAsSystem } from '../db/context.js';
import { nanoid } from 'nanoid';
import type { FastifyReply } from 'fastify';
import { notifyNewSignup } from '../billing/sales-notifier.js';
import {
  classifyProvider,
  buildDcApplyUrl,
  getProviderName,
  DC_SUPPORTED_SLUGS,
  type NsResolver,
} from './dc-providers.js';
import { config } from '../config.js';

interface DomainRouteDeps {
  orgService: OrgService;
  domainService: OrgDomainService;
  /**
   * Optional NS resolver injection (WYREAI-134) — tests inject a stub that
   * returns deterministic NS records; production uses node:dns/promises
   * resolveNs by default (resolved inside classifyProvider).
   */
  nsResolver?: NsResolver;
}

function handleDomainError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OrgDomainError) {
    const status =
      err.code === 'DOMAIN_NOT_FOUND' ? 404 :
      err.code === 'DOMAIN_ALREADY_CLAIMED' ? 409 :
      err.code === 'VERIFICATION_DNS_ERROR' ? 422 :
      err.code === 'VERIFICATION_TOKEN_MISSING' ? 422 :
      400;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export function domainRoutes(deps: DomainRouteDeps) {
  const { orgService, domainService, nsResolver } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // Org-admin domain management
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/domains
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId/domains',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;
        const domains = await domainService.list(orgId);
        return reply.send(domains);
      },
    );

    // POST /api/orgs/:orgId/domains
    app.post<{
      Params: { orgId: string };
      Body: { domain: string; auto_join_role?: OrgDomainRole };
    }>(
      '/api/orgs/:orgId/domains',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        const { domain, auto_join_role: autoJoinRole } = request.body ?? {};
        if (!domain?.trim()) {
          return reply.code(400).send({ error: 'domain is required' });
        }

        try {
          const record = await domainService.add(
            orgId,
            domain,
            user.sub,
            autoJoinRole ?? 'member',
          );
          return reply.code(201).send(record);
        } catch (err) {
          return handleDomainError(reply, err);
        }
      },
    );

    // POST /api/orgs/:orgId/domains/:id/verify
    app.post<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/domains/:id/verify',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;
        try {
          const record = await domainService.verify(id, orgId, user.sub);
          return reply.send(record);
        } catch (err) {
          return handleDomainError(reply, err);
        }
      },
    );

    // -----------------------------------------------------------------------
    // Domain Connect (DC) integration — WYREAI-134 + WYREAI-135
    //
    // Two endpoints layered ON TOP of the existing manual TXT-record flow:
    //   - GET .../ns-detect: frontend asks "is this domain DC-eligible?"
    //     and gets back a provider slug ('cloudflare' | 'godaddy' | 'vercel'
    //     | 'unsupported'). When supported, frontend shows a one-click DC
    //     button alongside the manual TXT block; when unsupported, frontend
    //     shows only the manual block.
    //   - GET .../dc-callback: user returns from the DC provider after
    //     applying the template. We invoke the same verify() as the manual
    //     "Verify" button (DNS-TXT resolution against existing
    //     organization_domains.verification_token), then redirect with a
    //     flash message. The DNS-TXT check is the load-bearing primitive —
    //     DC just automates the record-placement step that the manual user
    //     would otherwise do by hand. Both paths converge on verify().
    //
    // Manual fallback discipline preserved: any DC-unsupported domain
    // (long-tail 31.6% per 2026-06-03 cohort research) shows ONLY the
    // existing TXT-record block + Verify button. No coverage regression.
    //
    // Out-of-band gating: DC apply URLs only succeed if our template
    // (providerId='conduit.wyre.ai', serviceId='domain-verify') has been
    // onboarded with the DNS provider — tracked separately at WYREAI-137.
    // This engineering surface is complete + safe to merge before any DNS
    // provider finishes onboarding; until they do, the DC button just sends
    // users to a "template not found" response from the DNS provider, which
    // is recoverable (user falls back to the manual block).
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/domains/:id/ns-detect
    app.get<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/domains/:id/ns-detect',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;
        const record = await domainService.getById(id, orgId);
        if (!record) return reply.code(404).send({ error: 'Domain claim not found' });

        const provider = await classifyProvider(record.domain, nsResolver);

        if (provider === 'unsupported') {
          return reply.send({
            provider,
            domain: record.domain,
            dcButton: null,
          });
        }

        // Apply-URL constructed eagerly so the frontend doesn't need its own
        // copy of the per-provider host registry. The callback URL points
        // back at the dc-callback route below, which closes the loop by
        // running the existing verify() on user-return.
        const callbackUrl = `${config.baseUrl}/api/orgs/${orgId}/domains/${id}/dc-callback`;
        const applyUrl = buildDcApplyUrl({
          provider,
          domain: record.domain,
          verificationToken: record.verificationToken,
          callbackUrl,
        });

        return reply.send({
          provider,
          domain: record.domain,
          dcButton: applyUrl
            ? {
                label: `Add to ${getProviderName(provider)}`,
                applyUrl,
                supportedSlugs: DC_SUPPORTED_SLUGS,
              }
            : null,
        });
      },
    );

    // GET /api/orgs/:orgId/domains/:id/dc-callback
    app.get<{
      Params: { orgId: string; id: string };
      Querystring: { error?: string };
    }>(
      '/api/orgs/:orgId/domains/:id/dc-callback',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        // Settings page where the user lands with success/failure flash.
        // Conduit's settings/domain UI is at /settings/domains (the
        // team-domains template page). Failure paths fall through to the
        // manual flow without prejudice — the user clicks Verify again
        // after their record propagates.
        const okFlash = `flash_ok=${encodeURIComponent(`Domain ${request.params.id} verified via Domain Connect`)}`;
        const errFlash = (msg: string) =>
          `flash_err=${encodeURIComponent(`Domain Connect callback: ${msg}`)}`;

        // DC providers can return ?error=<code> on user-cancel or apply-
        // failure per the spec. Surface as flash and skip the verify call.
        if (request.query.error) {
          return reply.redirect(
            `/settings/domains?${errFlash(request.query.error)}`,
            302,
          );
        }

        // Run the same verify() the manual "Verify" button uses. DC has
        // (presumably) just added the TXT record on the user's behalf; the
        // DNS-TXT resolution check confirms it. If propagation hasn't
        // landed yet, the verify call fails with VERIFICATION_TOKEN_MISSING
        // and the user retries manually after a minute.
        try {
          await domainService.verify(id, orgId, user.sub);
          return reply.redirect(`/settings/domains?${okFlash}`, 302);
        } catch (err) {
          const msg = err instanceof OrgDomainError ? err.message : 'verification failed';
          return reply.redirect(`/settings/domains?${errFlash(msg)}`, 302);
        }
      },
    );

    // DELETE /api/orgs/:orgId/domains/:id
    app.delete<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/domains/:id',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;
        const ok = await domainService.delete(id, orgId);
        if (!ok) return reply.code(404).send({ error: 'Domain claim not found' });
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Claim flow (current user)
    // -----------------------------------------------------------------------

    // GET /api/me/claim-eligibility
    // Only eligible when the user has zero memberships AND their verified
    // email domain matches a verified org claim.
    app.get('/api/me/claim-eligibility', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      // Mirror the POST /api/me/claim gate — never surface eligibility for an
      // unverified email.
      if (!user.emailVerified) {
        return reply.send({ eligible: false, reason: 'email_not_verified' });
      }

      const existing = await orgService.getUserOrgs(user.sub);
      if (existing.length > 0) {
        return reply.send({ eligible: false, reason: 'already_in_org' });
      }

      const emailDomain = domainFromEmail(user.email ?? '');
      if (!emailDomain) {
        return reply.send({ eligible: false, reason: 'no_email_domain' });
      }

      const claim = await domainService.findVerifiedByDomain(emailDomain);
      if (!claim) {
        return reply.send({ eligible: false, reason: 'no_verified_org' });
      }

      // Deliberate cross-org read: the caller is NOT a member of claim.orgId
      // (claim-eligibility exists for non-members), and organizations has
      // membership-scoped RLS since migration 007 — a request-path getOrg
      // would return null for every genuinely-eligible user. System-path,
      // same posture as findVerifiedByDomain. Discloses only { id, name } of
      // the org that claimed the caller's own verified email domain.
      const org = await runAsSystem(() => orgService.getOrg(claim.orgId));
      if (!org) {
        return reply.send({ eligible: false, reason: 'no_verified_org' });
      }

      return reply.send({
        eligible: true,
        org: { id: org.id, name: org.name },
        role: claim.autoJoinRole,
        domain: claim.domain,
      });
    });

    // POST /api/me/claim — accept the claim, join as auto_join_role.
    app.post('/api/me/claim', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      // Domain auto-join is account takeover if email ownership is not proven:
      // register attacker@victim-corp.com at any IdP that does not verify,
      // claim, inherit org membership. Refuse unless the upstream IdP attests
      // verification — Auth0 email_verified, or for Entra a trusted tenant —
      // which conduit folds into Auth0User.emailVerified.
      if (!user.emailVerified) {
        return reply.code(403).send({
          error:
            'Your email address has not been verified by your identity provider. ' +
            'Verify your email and sign in again, or contact an administrator.',
        });
      }

      const existing = await orgService.getUserOrgs(user.sub);
      if (existing.length > 0) {
        return reply.code(409).send({ error: 'You are already a member of an organization' });
      }

      const emailDomain = domainFromEmail(user.email ?? '');
      if (!emailDomain) {
        return reply.code(400).send({ error: 'Your account has no email domain to match' });
      }

      const claim = await domainService.findVerifiedByDomain(emailDomain);
      if (!claim) {
        return reply.code(404).send({ error: 'No organization has claimed your email domain' });
      }

      // The membership INSERT runs system-path: the user is not yet a member,
      // so org_members RLS would block the write on the request path — the
      // claim IS the act of joining. The (org_id, user_id) unique constraint
      // is the race net: if two tabs race, one INSERT wins, the other noops.
      await runAsSystem(() =>
        getSql()`
          INSERT INTO org_members (id, org_id, user_id, role, joined_at)
          VALUES (${nanoid()}, ${claim.orgId}, ${user.sub}, ${claim.autoJoinRole}, NOW())
          ON CONFLICT (org_id, user_id) DO NOTHING
        `,
      );

      // Notify new signup (fire-and-forget — from main).
      void notifyNewSignup(getSql(), { userId: user.sub, orgId: claim.orgId, isOwner: false }, request.log);

      // Layer 1 seat-sync (DOR §6 — domain-auto-join is a "human added"
      // event from the seat-count perspective). Runs system-path same as
      // the INSERT so getSeatBilling reads the committed row. The
      // ON CONFLICT DO NOTHING above means this fires even on a race-loser
      // path; OrgService.syncSeats's quantity-unchanged short-circuit
      // keeps that idempotent — same SeatBilling, no spurious Stripe call.
      // Log+swallow lives at the syncSeats API boundary (post-HOLD); a
      // Stripe outage during auto-join cannot 5xx this route.
      await runAsSystem(() => orgService.syncSeats(claim.orgId));

      // System-path, for consistency with claim-eligibility above and so this
      // does not depend on the just-committed org_members INSERT being visible
      // to a request-path organizations read within the same request.
      const org = await runAsSystem(() => orgService.getOrg(claim.orgId));
      request.log.info(
        { userId: user.sub, orgId: claim.orgId, domain: claim.domain },
        'domain claim accepted',
      );

      return reply.code(201).send({
        org: org ? { id: org.id, name: org.name } : { id: claim.orgId },
        role: claim.autoJoinRole,
      });
    });
  };
}
