import { describe, it, expect } from "vitest";
import {
  renderResellerCustomerDetail,
  type CustomerSummary,
  type ResellerCustomerDetailData,
} from "./reseller-customer-detail.js";
import type { Organization } from "../../org/org-service.js";

const org: Organization = {
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
  updatedAt: "2026-05-16T00:00:00Z",
};

const customer = (over: Partial<CustomerSummary> = {}): CustomerSummary => ({
  id: "cust_1",
  name: "AM3 Technology",
  plan: "BUSINESS",
  userCount: 12,
  mcpCount: 4,
  subdomain: "am3.conduit.wyre.ai",
  ...over,
});

function data(over: Partial<CustomerSummary> = {}): ResellerCustomerDetailData {
  return { org, customer: customer(over) };
}

describe("renderResellerCustomerDetail", () => {
  it("renders a breadcrumb with the reseller and customer names", () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toContain("WYRE Technology");
    expect(body).toContain("Customers");
    expect(body).toContain("AM3 Technology");
  });

  // RC4 (ruby + Aaron 2026-06-05): plan removed from subtitle per OC1-
  // class fix (flat-pricing single-plan, no FREE/PRO/BUSINESS to convey).
  // The test inverts: previously locked the BUG (plan-label rendered);
  // now locks the FIX (no plan-label, counts + subdomain only).
  it("RC4: header subtitle renders counts/subdomain WITHOUT plan label (no FREE/PRO/BUSINESS)", () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).not.toContain("BUSINESS plan");
    expect(body).not.toContain("FREE plan");
    expect(body).not.toContain("PRO plan");
    expect(body).toContain("12 users");
    expect(body).toContain("4 MCPs");
    expect(body).toContain("am3.conduit.wyre.ai");
  });

  it("renders Onboard MCP linking to the wizard; legacy Impersonate-disabled-with-dev-language removed", () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toContain("/org/customers/cust_1/onboard-mcp?step=1");
    expect(body).not.toMatch(/cd-btn-secondary[^>]*disabled/);
    expect(body).not.toContain("lands in a follow-up");
  });

  it("renders the four Figma stat-card slots and loading + content shell", () => {
    const { body } = renderResellerCustomerDetail(data());
    for (const id of [
      "cdMcpCalls",
      "cdActiveUsers",
      "cdToolCalls",
      "cdErrorRate",
    ]) {
      expect(body).toContain(`id="${id}"`);
    }
    // Cards carry their fixed-window labels (design Rule 2).
    expect(body).toContain("MCP Calls (30d)");
    expect(body).toContain("Active Users (7d)");
    expect(body).toContain("Tool Calls (24h)");
    expect(body).toContain("Error Rate (7d)");
    expect(body).toContain('id="cdLoading"');
    expect(body).toContain('id="cdContent"');
    expect(body).toContain('id="cdMcpGrid"');
    expect(body).toContain('id="cdUserBody"');
  });

  it("builds a fetch script scoped to the reseller and customer ids", () => {
    const { pageScripts } = renderResellerCustomerDetail(
      data({ id: "cust_xyz" }),
    );
    expect(pageScripts).toContain(
      "/admin/reseller/org_reseller/customers/cust_xyz/dashboard",
    );
    expect(pageScripts).toContain("'/usage?start='");
    expect(pageScripts).toContain("'/vendors'");
  });

  it("fetches /usage at three fixed trailing windows (30d/7d/24h)", () => {
    const { pageScripts } = renderResellerCustomerDetail(data());
    expect(pageScripts).toContain("usageUrl(30)");
    expect(pageScripts).toContain("usageUrl(7)");
    expect(pageScripts).toContain("usageUrl(1)");
  });

  it("reads errorRate with a graceful fallback (aggregate not yet shipped)", () => {
    const { pageScripts } = renderResellerCustomerDetail(data());
    expect(pageScripts).toContain("fmtErrorRate");
    expect(pageScripts).toContain("u7.errorRate");
  });

  it("populates the DOM without innerHTML (untrusted request-log strings)", () => {
    const { pageScripts } = renderResellerCustomerDetail(data());
    expect(pageScripts).not.toContain("innerHTML");
    expect(pageScripts).toContain("createElement");
    expect(pageScripts).toContain("textContent");
  });

  it("escapes the customer name in the rendered body (no HTML injection)", () => {
    const { body } = renderResellerCustomerDetail(
      data({ name: "<script>x</script>" }),
    );
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("flags the live-analytics scope in the shell note", () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).not.toContain("Analytics on this page are live");
    expect(body).not.toContain("endpoints land");
  });
});
