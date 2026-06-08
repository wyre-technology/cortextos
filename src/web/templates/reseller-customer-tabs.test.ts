import { describe, it, expect } from "vitest";
import {
  renderCustomerTab,
  type CustomerTabData,
  type CustomerTabId,
} from "./reseller-customer-tabs.js";
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

function data(
  tab: CustomerTabId,
  over: Partial<CustomerTabData> = {},
): CustomerTabData {
  return {
    org,
    customer: {
      id: "cust_1",
      name: "AM3 Technology",
      plan: "BUSINESS",
      userCount: 12,
      mcpCount: 4,
      subdomain: "am3.conduit.wyre.ai",
    },
    tab,
    mcps: [
      {
        vendor: "Autotask",
        pattern: "OEM · BYOC",
        seats: "8/12 users",
        status: "healthy",
      },
    ],
    members: [
      {
        name: "C. Ramirez",
        email: "cramirez@am3-it.com",
        role: "Owner",
        department: "Service Delivery",
        toolAccess: "All MCPs",
        lastActive: "12m ago",
      },
    ],
    memberTotal: 12,
    toolDepartment: "Service Delivery (4 users)",
    toolDepartments: ["Service Delivery"],
    toolGroups: [
      {
        name: "Tickets",
        tools: [
          { name: "create_ticket", enabled: true },
          { name: "delete_ticket", enabled: false },
        ],
      },
    ],
    audit: [
      {
        when: "12m ago",
        actor: "C. Ramirez",
        action: "mcp.tool.invoke",
        target: "Autotask",
      },
    ],
    ...over,
  };
}

describe("renderCustomerTab — chrome", () => {
  it("every tab renders the breadcrumb + tab title + customer subtitle", () => {
    const tabs: CustomerTabId[] = [
      "mcps",
      "users",
      "usage",
      "tools",
      "audit",
      "billing",
      "settings",
    ];
    for (const t of tabs) {
      const { body } = renderCustomerTab(data(t));
      expect(body).toContain("WYRE Technology");
      expect(body).toContain("AM3 Technology");
      expect(body).toContain('href="/org/customers/cust_1"'); // breadcrumb back to Overview
    }
  });
});

describe("renderCustomerTab — MCPs", () => {
  it("renders a row per connected MCP with status", () => {
    const { body } = renderCustomerTab(data("mcps"));
    expect(body).toContain("Autotask");
    expect(body).toContain("OEM · BYOC");
    expect(body).toContain("cdt-dot-healthy");
  });
});

describe("renderCustomerTab — Users", () => {
  it('renders members and the "+ N more" affordance', () => {
    const { body } = renderCustomerTab(data("users"));
    expect(body).toContain("C. Ramirez");
    expect(body).toContain("cramirez@am3-it.com");
    expect(body).toContain("+ 11 more users");
  });
});

describe("renderCustomerTab — Usage (live)", () => {
  it("renders the live shell + a reseller-scoped fetch script", () => {
    const { body, pageScripts } = renderCustomerTab(data("usage"));
    expect(body).toContain('id="cdtUsageLoading"');
    expect(body).toContain('id="cdtuVendors"');
    expect(pageScripts).toContain(
      "/admin/reseller/org_reseller/customers/cust_1/dashboard",
    );
    expect(pageScripts).toContain("createElement");
    expect(pageScripts).not.toContain("innerHTML");
  });
  it("only the live tabs (Usage, Audit) carry a page script", () => {
    for (const t of [
      "mcps",
      "users",
      "tools",
      "billing",
      "settings",
    ] as CustomerTabId[]) {
      expect(renderCustomerTab(data(t)).pageScripts).toBe("");
    }
    expect(renderCustomerTab(data("audit")).pageScripts).not.toBe("");
  });
});

describe("renderCustomerTab — Tool Access", () => {
  it("renders tool groups with enabled counts", () => {
    const { body } = renderCustomerTab(data("tools"));
    expect(body).toContain("Tickets");
    expect(body).toContain("1 of 2 enabled");
    expect(body).toContain("create_ticket");
  });
});

describe("renderCustomerTab — Audit Log (live)", () => {
  it("renders the live shell + a reseller-scoped audit fetch script", () => {
    const { body, pageScripts } = renderCustomerTab(data("audit"));
    expect(body).toContain('id="cdtAuditLoading"');
    expect(body).toContain('id="cdtAuditRows"');
    expect(pageScripts).toContain(
      "/admin/reseller/org_reseller/customers/cust_1/audit",
    );
    expect(pageScripts).toContain("createElement");
    expect(pageScripts).not.toContain("innerHTML");
  });
});

describe("renderCustomerTab — Billing", () => {
  it("renders an honest empty state without dev-language (RC5 sweep)", () => {
    const { body } = renderCustomerTab(data("billing"));
    expect(body).toContain("Customer billing");
    expect(body).toContain("No billing data yet for this customer");
    // No customer-visible dev-language about future endpoints.
    expect(body).not.toContain("reseller customer-billing endpoint");
    expect(body).not.toContain("lands when");
    expect(body).not.toContain("endpoint ships");
    // No fabricated financial data — neither old-shape nor Layer-1-veneer.
    expect(body).not.toMatch(/\$\d+(\.\d{2})?\s*(\/\s*(user|seat|mo|month))?/);
    expect(body).not.toContain("INV-");
    expect(body).not.toContain("cdt-inv-");
  });
});

describe("renderCustomerTab — Settings", () => {
  it("renders the identity form with a read-only subdomain and a danger zone", () => {
    const { body } = renderCustomerTab(data("settings"));
    expect(body).toContain("Organization name");
    expect(body).toMatch(/cdt-input-ro[^>]*readonly/);
    expect(body).toContain("Danger zone");
    expect(body).toMatch(/cdt-save[^>]*disabled/);
  });
});

describe("renderCustomerTab — invariants", () => {
  // RC4 customer-facing dev-language leak fix (ruby + Aaron 2026-06-05):
  // the SWAP-IN CONTRACT strings used to render directly in the
  // customer-facing UI via the seam() helper. Now suppressed at the
  // helper-substrate (returns ''), so the regression-guard inverts:
  // mock-first tabs MUST NOT render the dev-language text. The seam
  // call-sites remain in the source as documented swap-in markers for
  // the future real-data wiring; only the runtime render is silenced.
  it("mock-first tabs do NOT render dev-language SWAP-IN-CONTRACT text to customers (RC4 regression-guard)", () => {
    for (const t of [
      "mcps",
      "users",
      "tools",
      "billing",
      "settings",
    ] as CustomerTabId[]) {
      const body = renderCustomerTab(data(t)).body;
      expect(body).not.toContain("SWAP-IN CONTRACT");
      expect(body).not.toContain("Mock-data-first");
      expect(body).not.toContain("ia-shell-note");
    }
  });
  it("live tabs (Usage + Audit) also do NOT leak their authz-enforcement-described dev-language", () => {
    for (const t of ["usage", "audit"] as CustomerTabId[]) {
      const body = renderCustomerTab(data(t)).body;
      expect(body).not.toContain("reseller-scoped");
      expect(body).not.toContain("enforces reseller-owns-customer");
      expect(body).not.toContain("ia-shell-note");
    }
  });
  it("escapes the customer name (no HTML injection)", () => {
    const { body } = renderCustomerTab(
      data("mcps", {
        customer: {
          id: "c",
          name: "<script>x</script>",
          plan: "PRO",
          userCount: 1,
          mcpCount: 0,
          subdomain: "s",
        },
      }),
    );
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("renderCustomerTab — empty states", () => {
  it("renders an empty-state row for each zero-row mock tab", () => {
    expect(renderCustomerTab(data("mcps", { mcps: [] })).body).toContain(
      "No MCPs connected",
    );
    expect(
      renderCustomerTab(data("users", { members: [], memberTotal: 0 })).body,
    ).toContain("No members yet");
    // Billing tab is unconditionally empty-state until the reseller
    // customer-billing endpoint lands — see its own test above.
    // (Audit Log is live — its empty-state is a client-script fallback.)
  });
  it('omits the "+ N more" affordance when the roster is complete', () => {
    const { body } = renderCustomerTab(data("users", { memberTotal: 1 }));
    expect(body).not.toContain("more users");
  });
});

describe("renderCustomerTab — hardening", () => {
  it("an unknown tab renders a neutral body, never the Settings form", () => {
    const { body } = renderCustomerTab(data("bogus" as CustomerTabId));
    expect(body).toContain("Unknown tab");
    expect(body).not.toContain("Danger zone");
  });
  it("Settings name + subdomain inputs are read-only (Plan tier removed in RC5 sweep)", () => {
    const { body } = renderCustomerTab(data("settings"));
    const inputs = body.match(/<input[^>]*>/g) ?? [];
    // Plan tier field removed — only name + subdomain remain.
    expect(inputs.length).toBe(2);
    for (const input of inputs) expect(input).toContain("readonly");
    expect(body).not.toContain("Plan tier");
  });
  it('table headers carry scope="col"', () => {
    const { body } = renderCustomerTab(data("users"));
    expect(body).toContain('<th scope="col">');
  });
});
