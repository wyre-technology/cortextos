import type { Organization } from "../../org/org-service.js";
import { escapeHtml } from "../helpers.js";

/**
 * Reseller-side Billing & Plans surface — replaces the stub at
 * /org/reseller/billing.
 *
 * 2026-06-13 sweep-2 cluster-1 (3) finding (Aaron): the reseller console's
 * Billing & Plans nav item was a `resellerStubBody('Billing & Plans')`
 * placeholder. Real Stripe billing portal access existed for customer-side
 * orgs (src/web/templates/team-billing.ts renderBillingDetails) via the
 * org-id-keyed POST /api/billing/portal endpoint — but the reseller had no
 * way to reach it for their OWN org, even though the endpoint is org-type-
 * agnostic and works for any org with a stripeCustomerId.
 *
 * Shape mirrors customer-side renderBillingDetails:
 *   - has stripeCustomerId → link out via POST /api/billing/portal
 *   - no stripeCustomerId  → honest "managed directly" state with no button
 *
 * Copy is reseller-context-appropriate ("your WYRE invoice" vs the customer-
 * facing "your billing portal"). Same fetch shape so the JS pattern is
 * cross-template stable.
 */
export interface ResellerBillingData {
  org: Organization;
}

export function renderResellerBilling(data: ResellerBillingData): string {
  const { org } = data;
  const orgName = escapeHtml(org.name);

  if (!org.stripeCustomerId) {
    return `
      <h1 style="margin-bottom:4px">Billing &amp; Plans</h1>
      <p class="section-desc">${orgName}</p>

      <section class="reseller-billing-card" style="margin-top:24px">
        <h2 class="section-title">Wholesale billing</h2>
        <p class="section-desc">
          Your WYRE wholesale billing is managed directly by our team — there
          is no self-service portal for this account. Contact your WYRE
          account manager for invoice questions or to update payment method.
        </p>
      </section>
    `;
  }

  return `
    <h1 style="margin-bottom:4px">Billing & Plans</h1>
    <p class="section-desc">${orgName}</p>

    <section class="reseller-billing-card" style="margin-top:24px">
      <h2 class="section-title">Wholesale billing</h2>
      <p class="section-desc">
        Your WYRE wholesale invoices, payment method, and upcoming charges are
        managed in your secure Stripe billing portal.
      </p>
      <button type="button" class="btn-connect" id="resellerBillingPortalBtn" style="width:auto;padding:10px 20px">
        Open billing portal
      </button>
      <div class="billing-portal-status" id="resellerBillingPortalStatus" role="status" style="margin-top:8px;font-size:13px;color:var(--text-muted)"></div>
    </section>

    <script>
      (function () {
        var orgId = ${JSON.stringify(org.id)};
        var btn = document.getElementById('resellerBillingPortalBtn');
        var status = document.getElementById('resellerBillingPortalStatus');
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          status.textContent = 'Opening portal…';
          try {
            var res = await fetch('/api/billing/portal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ org_id: orgId }),
            });
            if (res.status === 403) {
              // Endpoint is owner-only. A non-owner admin landing here
              // cannot succeed; name the real remedy + leave button disabled.
              status.textContent = 'Only an organization owner can open the billing portal.';
              return;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            if (!data.url) throw new Error('no url');
            window.location.href = data.url;
          } catch (e) {
            btn.disabled = false;
            status.textContent = 'Could not open the billing portal. Please try again.';
          }
        });
      })();
    </script>
  `;
}

export const RESELLER_BILLING_STYLES = `
  .reseller-billing-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 20px 24px;
    max-width: 720px;
  }
`;
