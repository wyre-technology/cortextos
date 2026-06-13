import { describe, it, expect } from "vitest";
import {
  renderResellerBilling,
  type ResellerBillingData,
} from "./reseller-billing.js";
import type { Organization } from "../../org/org-service.js";

const baseOrg: Organization = {
  id: "org_reseller",
  name: "WYRE Technology",
  ownerId: "auth0|1",
  plan: "business",
  defaultServerAccess: "none",
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: "reseller",
  parentOrgId: null,
  auth0OrgId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-06-13T00:00:00Z",
};

function data(
  over: Partial<ResellerBillingData["org"]> = {},
): ResellerBillingData {
  return { org: { ...baseOrg, ...over } };
}

describe("renderResellerBilling", () => {
  it("renders heading + org name regardless of stripe state", () => {
    const html = renderResellerBilling(data());
    expect(html).toContain("Billing &amp; Plans");
    expect(html).toContain("WYRE Technology");
  });

  it("escapes the org name (no HTML injection)", () => {
    const html = renderResellerBilling(data({ name: "<script>x</script>" }));
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  describe("no stripeCustomerId — managed-directly arm", () => {
    it("renders the 'managed directly' copy + omits the portal button", () => {
      const html = renderResellerBilling(data({ stripeCustomerId: null }));
      expect(html).toContain("managed directly");
      expect(html).toContain("account manager");
      expect(html).not.toContain('id="resellerBillingPortalBtn"');
      expect(html).not.toContain("/api/billing/portal");
    });
  });

  describe("with stripeCustomerId — self-service portal arm", () => {
    it("renders the portal button + the fetch script targeting /api/billing/portal", () => {
      const html = renderResellerBilling(
        data({ stripeCustomerId: "cus_test_reseller" }),
      );
      expect(html).toContain('id="resellerBillingPortalBtn"');
      expect(html).toContain("Open billing portal");
      expect(html).toContain("'/api/billing/portal'");
      // org_id is the canonical billing endpoint key — verify it's passed
      // (JSON.stringify'd into the script, so an exact ":" match works)
      expect(html).toContain('"org_reseller"');
    });

    it("script handles the 403 non-owner case with a remedy-naming message + leaves button disabled", () => {
      const html = renderResellerBilling(
        data({ stripeCustomerId: "cus_test_reseller" }),
      );
      // 403 branch: explain remedy, do not re-enable button (no retry possible
      // for a non-owner). Mirrors customer-side team-billing pattern.
      expect(html).toContain("res.status === 403");
      expect(html).toContain("Only an organization owner");
    });

    it("script redirects to the portal URL on success", () => {
      const html = renderResellerBilling(
        data({ stripeCustomerId: "cus_test_reseller" }),
      );
      expect(html).toContain("window.location.href = data.url");
    });

    it("script re-enables the button + surfaces a generic error on non-403 failure", () => {
      const html = renderResellerBilling(
        data({ stripeCustomerId: "cus_test_reseller" }),
      );
      // Recoverable failure modes (network, 500, etc.): re-enable + ask to
      // retry. Distinct from the 403 path which leaves the button disabled.
      expect(html).toContain("btn.disabled = false");
      expect(html).toContain("Please try again");
    });
  });
});
