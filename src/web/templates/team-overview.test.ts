import { describe, it, expect } from "vitest";
import { renderTeamOverview, type TeamOverviewData } from "./team-overview.js";
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
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-05-16T00:00:00Z",
};

function data(over: Partial<TeamOverviewData> = {}): TeamOverviewData {
  return { org, memberCount: 10, ...over };
}

describe("renderTeamOverview", () => {
  it("renders the org name + member count + rename form", () => {
    const html = renderTeamOverview(data());
    expect(html).toContain("WYRE Technology");
    expect(html).toContain("10 members");
    expect(html).toContain('id="rename-form"');
    expect(html).toContain("Team Name");
  });

  // 2026-06-13 sweep-2 cluster-1 fix (boss): "Pro" plan-badge in the
  // header subtitle was a holdover from the legacy BUSINESS/PRO/FREE tier
  // system. Flat-pricing has one plan (conduit), no tier-choice exists,
  // so the badge was UX-misleading. Same OC1-class fix as PR #362 on the
  // customer-LIST + customer-DETAIL + Settings tab. Lock the absence so a
  // future contributor cannot re-add a tier label here without a
  // separate explicit decision.
  it("does NOT render the legacy 'Pro' plan-badge (flat-pricing, OC1-class)", () => {
    const html = renderTeamOverview(data());
    expect(html).not.toContain("plan-badge pro");
    expect(html).not.toContain(">Pro<");
    expect(html).not.toContain(">PRO<");
    expect(html).not.toContain(">Business<");
    expect(html).not.toContain(">Free<");
  });

  it("pluralizes 'member' correctly", () => {
    expect(renderTeamOverview(data({ memberCount: 1 }))).toMatch(
      /\b1 member\b(?!s)/,
    );
    expect(renderTeamOverview(data({ memberCount: 0 }))).toContain("0 members");
    expect(renderTeamOverview(data({ memberCount: 25 }))).toContain(
      "25 members",
    );
  });

  it("escapes the org name (no HTML injection)", () => {
    const html = renderTeamOverview(
      data({ org: { ...org, name: "<script>x</script>" } }),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
