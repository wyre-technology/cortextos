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
  auth0OrgId: null,
  suspendedAt: null,
  deletedAt: null,
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

  // 2026-06-12 Aaron-flagged "can't add users on /org/customers/<id>".
  // Backend POST /api/orgs/:orgId/invitations already exists and accepts
  // reseller_admin / customer-owner identity; only the UI surface was
  // missing. Regression-guard the new Invite button + modal + the
  // customerId being passed through to the modal handler.
  it("renders the Invite user button + modal scaffolding", () => {
    const { body } = renderCustomerTab(data("users"));
    expect(body).toContain("+ Invite user");
    expect(body).toContain('id="cdtInviteOverlay"');
    expect(body).toContain('id="cdtInviteEmail"');
    expect(body).toContain('id="cdtInviteSubmit"');
  });

  it("passes the reseller id + customer id into the modal create-invite handler", () => {
    const { body } = renderCustomerTab(data("users"));
    // 2026-06-12 launch-day workaround: the modal POSTs to the reseller-
    // scoped endpoint (sidesteps the customer-org /api/orgs/<id>/
    // invitations hang). Both ids must be bound — the URL constructed in
    // the handler is /admin/reseller/<resellerId>/customers/<customerId>/
    // invitations.
    expect(body).toMatch(/onclick="cdtCreateInvite\('[^']+',\s*'[^']+'\)"/);
    expect(body).toContain("/admin/reseller/");
  });

  it("does NOT render the modal with innerHTML assignments (XSS guardrail)", () => {
    const { body } = renderCustomerTab(data("users"));
    // The result block on success is built with createElement + textContent —
    // never `result.innerHTML = ...` — so a maliciously typed email cannot
    // smuggle markup. If a refactor reintroduces innerHTML on the modal
    // result/error nodes, this regression-guard fires.
    expect(body).not.toMatch(/result\.innerHTML\s*=/);
    expect(body).not.toMatch(/err\.innerHTML\s*=/);
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

// ---------------------------------------------------------------------------
// WYREAI-172 PR-2 Members tab tests (boss msg-1781787643789).
//
// Members tab is the actingAs-context CRUD surface for customer-org
// membership. Without an active binding the page renders the read-only
// roster + a "Manage on behalf of {name}" CTA pointing at /switch.
// With an active binding for THIS customer-org, the action controls
// (Invite + per-row role-dropdown + per-row Remove) light up.
// ---------------------------------------------------------------------------

describe("renderCustomerTab — Members tab (WYREAI-172 PR-2)", () => {
  describe("read-only state (no actingAs binding)", () => {
    it("renders the 'Manage on behalf of {name}' CTA pointing at /switch", () => {
      const { body } = renderCustomerTab(data("members"));
      expect(body).toContain("Manage on behalf of AM3 Technology");
      expect(body).toContain(
        'action="/api/reseller/me/customers/cust_1/switch"',
      );
      expect(body).toContain('method="POST"');
    });

    it("renders the read-only roster below the CTA", () => {
      const { body } = renderCustomerTab(data("members"));
      // The mock fixture has 1 member ("C. Ramirez"); the roster
      // section is labeled "Current members" + table is marked
      // cdt-table-readonly.
      expect(body).toContain("Current members");
      expect(body).toContain("cdt-table-readonly");
      expect(body).toContain("C. Ramirez");
    });

    it("renders the +N more line when memberTotal exceeds the rendered roster length", () => {
      // Fixture: 1 member in members[], 12 in memberTotal → "+ 11 more members".
      const { body } = renderCustomerTab(data("members"));
      expect(body).toContain("+ 11 more members");
    });

    it("does NOT surface invite/role/remove controls", () => {
      const { body } = renderCustomerTab(data("members"));
      expect(body).not.toContain("cdtMembersInviteBtn");
      expect(body).not.toContain("cdt-role-select");
      expect(body).not.toContain("cdt-btn-row-remove");
    });

    it("includes the /switch CTA wiring in pageScripts (membersScript fires)", () => {
      const { pageScripts } = renderCustomerTab(data("members"));
      expect(pageScripts).toContain("cdtMembersSwitchForm");
      expect(pageScripts).toContain(
        "/api/reseller/me/customers/' + encodeURIComponent(CUSTOMER_ID) + '/switch",
      );
    });
  });

  describe("active state (actingAs binding present)", () => {
    function activeData() {
      return data("members", {
        actingAsActive: true,
        crudMembers: [
          {
            id: "mem-owner",
            userId: "auth0|owner-of-customer",
            name: "Owner Person",
            email: "owner@am3.example",
            role: "owner",
            canChangeRole: false, // owner-role lock
            canRemove: false, // owner-removal lock
          },
          {
            id: "mem-admin",
            userId: "auth0|admin-user",
            name: "Admin Person",
            email: "admin@am3.example",
            role: "admin",
            canChangeRole: true,
            canRemove: true,
          },
        ],
      });
    }

    it("renders the Invite button + members table with role dropdown + Remove button", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toContain("+ Invite member");
      expect(body).toContain('id="cdtMembersInviteBtn"');
      expect(body).toContain('class="cdt-role-select"');
      expect(body).toContain('class="cdt-btn-row-remove"');
    });

    it("locks the owner row's role-change + remove (canChangeRole=false / canRemove=false)", () => {
      const { body } = renderCustomerTab(activeData());
      // The owner row carries the locked-span variant, NOT the
      // editable dropdown or the Remove button.
      expect(body).toContain('class="cdt-role-locked"');
      expect(body).toContain('class="cdt-row-actions-locked"');
      // The locked span renders the role string in plain text.
      expect(body).toMatch(/owner[\s\S]*🔒/);
    });

    it("surfaces the admin row's editable dropdown + Remove button", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toContain('data-user-id="auth0|admin-user"');
      expect(body).toContain('data-action="role"');
      expect(body).toContain('data-current-role="admin"');
      expect(body).toContain('data-action="remove"');
      expect(body).toContain('data-user-name="Admin Person"');
    });

    it("includes the invite modal with the customer-name in the title", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toContain('id="cdtMembersInviteModal"');
      expect(body).toContain("Invite a member to AM3 Technology");
      // a11y: dialog role + aria-modal + labelledby.
      expect(body).toContain('role="dialog"');
      expect(body).toContain('aria-modal="true"');
      expect(body).toContain('aria-labelledby="cdtMembersInviteTitle"');
    });

    it("script wires CRUD endpoints under the OWNER-scoped /api/orgs/:customerOrgId/* path", () => {
      const { pageScripts } = renderCustomerTab(activeData());
      // Invite POST → /api/orgs/:customerOrgId/invitations.
      expect(pageScripts).toContain(
        "/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/invitations",
      );
      // Role change PATCH → /api/orgs/:customerOrgId/members/:userId/role.
      expect(pageScripts).toContain(
        "/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/members/' + encodeURIComponent(userId) + '/role",
      );
      // Remove DELETE → /api/orgs/:customerOrgId/members/:userId.
      expect(pageScripts).toContain(
        "/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/members/' + encodeURIComponent(userId)",
      );
      // The conventional methods.
      expect(pageScripts).toContain("method: 'PATCH'");
      expect(pageScripts).toContain("method: 'DELETE'");
    });

    it("script status-routes 403 / 429 / network errors to distinct messages", () => {
      const { pageScripts } = renderCustomerTab(activeData());
      expect(pageScripts).toContain("res.status === 403");
      expect(pageScripts).toContain(
        "You don't have permission for this action.",
      );
      expect(pageScripts).toContain("res.status === 429");
      expect(pageScripts).toContain("Rate limit hit. Try again in a few minutes.");
      expect(pageScripts).toContain("Network error. Check connection and retry.");
    });

    it("escapes customer name in the invite modal title (HTML injection safety)", () => {
      const { body } = renderCustomerTab(
        data("members", {
          actingAsActive: true,
          crudMembers: [],
          customer: {
            id: "cust_1",
            name: "<script>alert('xss')</script>",
            plan: "BUSINESS",
            userCount: 1,
            mcpCount: 0,
            subdomain: "x.example",
          },
        }),
      );
      expect(body).not.toContain("Invite a member to <script>alert('xss')</script>");
      expect(body).toContain("&lt;script&gt;");
    });

    it("script encodes the customer id via the XSS-safe embed helper", () => {
      const { pageScripts } = renderCustomerTab(
        data("members", {
          actingAsActive: true,
          crudMembers: [],
          customer: {
            id: "cust_a<script>x</script>b",
            name: "Acme",
            plan: "BUSINESS",
            userCount: 0,
            mcpCount: 0,
            subdomain: "acme.example",
          },
        }),
      );
      expect(pageScripts).not.toContain("cust_a<script>x</script>b");
      expect(pageScripts).toContain("\\u003cscript>x\\u003c/script>b");
    });
  });

  describe("script behavior contract", () => {
    it("read-only state script declares ACTING_AS = false; active state declares true", () => {
      const offScript = renderCustomerTab(data("members")).pageScripts;
      expect(offScript).toContain("var ACTING_AS = false");

      const onScript = renderCustomerTab(
        data("members", { actingAsActive: true, crudMembers: [] }),
      ).pageScripts;
      expect(onScript).toContain("var ACTING_AS = true");
    });

    it("read-only-state /switch CTA reload-in-place on 200", () => {
      const { pageScripts } = renderCustomerTab(data("members"));
      // /switch returns 200 + sets the cookie; we reload so the next
      // render sees the cookie + lit-up controls.
      expect(pageScripts).toContain("res.status === 200");
      expect(pageScripts).toContain("window.location.reload()");
    });
  });
});

// ---------------------------------------------------------------------------
// WYREAI-172 PR-2.5 Teams tab tests (Aaron-launch-required per boss
// msg-1781787643789). Same actingAs-context-(C) substrate as Members,
// multiplied across team-CRUD + team-members + team-server-access.
// ---------------------------------------------------------------------------

describe("renderCustomerTab — Teams tab (WYREAI-172 PR-2.5)", () => {
  describe("read-only state (no actingAs binding)", () => {
    it("renders the 'Manage on behalf of {name}' CTA pointing at /switch", () => {
      const { body } = renderCustomerTab(data("teams"));
      expect(body).toContain("Manage on behalf of AM3 Technology");
      expect(body).toContain(
        'action="/api/reseller/me/customers/cust_1/switch"',
      );
    });

    it("renders the read-only team list", () => {
      const { body } = renderCustomerTab(
        data("teams", {
          teams: [
            {
              id: "team_a",
              name: "Helpdesk",
              members: [
                { userId: "u1", name: "Alice", email: "alice@example.com" },
                { userId: "u2", name: "Bob", email: "bob@example.com" },
              ],
              vendorAllowlist: ["autotask", "datto-rmm"],
            },
          ],
        }),
      );
      expect(body).toContain("Current teams");
      expect(body).toContain("Helpdesk");
      expect(body).toContain("cdt-table-readonly");
    });

    it("does NOT surface CRUD controls (no create form / no accordion details)", () => {
      const { body } = renderCustomerTab(data("teams"));
      expect(body).not.toContain("cdtTeamsCreateForm");
      expect(body).not.toContain("cdt-team-row");
    });

    it("script wires /switch CTA reload-in-place on 200", () => {
      const { pageScripts } = renderCustomerTab(data("teams"));
      expect(pageScripts).toContain("cdtTeamsSwitchForm");
      expect(pageScripts).toContain("window.location.reload()");
    });
  });

  describe("active state (actingAs binding present)", () => {
    function activeData() {
      return data("teams", {
        actingAsActive: true,
        vendorCatalog: [
          { slug: "autotask", name: "Autotask" },
          { slug: "datto-rmm", name: "Datto RMM" },
          { slug: "halopsa", name: "HaloPSA" },
        ],
        membersForTeamPicker: [
          { userId: "u_alice", name: "Alice", email: "alice@am3.example" },
          { userId: "u_bob", name: "Bob", email: "bob@am3.example" },
          { userId: "u_carol", name: "Carol", email: "carol@am3.example" },
        ],
        teams: [
          {
            id: "team_helpdesk",
            name: "Helpdesk",
            members: [
              {
                userId: "u_alice",
                name: "Alice",
                email: "alice@am3.example",
              },
            ],
            vendorAllowlist: ["autotask"],
          },
          {
            id: "team_billing",
            name: "Billing",
            members: [],
            vendorAllowlist: [],
          },
        ],
      });
    }

    it("renders the Create-team form + toolbar", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toContain('id="cdtTeamsCreateForm"');
      expect(body).toContain('id="cdtTeamsCreateName"');
      expect(body).toContain("+ Create team");
    });

    it("renders one accordion row per team with summary meta", () => {
      const { body } = renderCustomerTab(activeData());
      // Each team is a <details> with data-team-row attribute.
      expect(body).toMatch(/details[^>]*data-team-row="team_helpdesk"/);
      expect(body).toMatch(/details[^>]*data-team-row="team_billing"/);
      // Summary meta shows member + vendor counts.
      expect(body).toContain("1 member");
      expect(body).toContain("1 vendor");
      expect(body).toContain("0 members");
      expect(body).toContain("0 vendors");
    });

    it("renders Rename + Delete buttons per team", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toMatch(/data-action="team-rename"[^>]*data-team-id="team_helpdesk"/);
      expect(body).toMatch(/data-action="team-delete"[^>]*data-team-id="team_helpdesk"/);
    });

    it("renders the member list with Remove buttons per existing team member", () => {
      const { body } = renderCustomerTab(activeData());
      expect(body).toContain('data-team-member="u_alice"');
      expect(body).toMatch(
        /data-action="team-remove-member"[^>]*data-team-id="team_helpdesk"[^>]*data-user-id="u_alice"/,
      );
    });

    it("add-member picker filters out members already on the team (Helpdesk: omit Alice)", () => {
      const { body } = renderCustomerTab(activeData());
      // The Helpdesk picker should show Bob + Carol but NOT Alice (already on team).
      const helpdeskPickerMatch = body.match(
        /id="cdtTeamAddMember-team_helpdesk"[\s\S]*?<\/select>/,
      );
      expect(helpdeskPickerMatch).toBeTruthy();
      const helpdeskPicker = helpdeskPickerMatch?.[0] ?? "";
      expect(helpdeskPicker).toContain('value="u_bob"');
      expect(helpdeskPicker).toContain('value="u_carol"');
      expect(helpdeskPicker).not.toContain('value="u_alice"');
    });

    it("vendor chip + revoke control per granted vendor", () => {
      const { body } = renderCustomerTab(activeData());
      // The Helpdesk team has autotask granted → chip with revoke btn.
      expect(body).toMatch(
        /class="cdt-team-vendor-chip"[^>]*data-team-vendor="autotask"/,
      );
      expect(body).toMatch(
        /data-action="team-revoke-vendor"[^>]*data-team-id="team_helpdesk"[^>]*data-vendor-slug="autotask"/,
      );
    });

    it("grant-vendor picker filters out already-allowlisted vendors (Helpdesk: omit autotask)", () => {
      const { body } = renderCustomerTab(activeData());
      const helpdeskGrantMatch = body.match(
        /id="cdtTeamGrantVendor-team_helpdesk"[\s\S]*?<\/select>/,
      );
      expect(helpdeskGrantMatch).toBeTruthy();
      const grantPicker = helpdeskGrantMatch?.[0] ?? "";
      expect(grantPicker).toContain('value="datto-rmm"');
      expect(grantPicker).toContain('value="halopsa"');
      expect(grantPicker).not.toContain('value="autotask"');
    });

    it("script wires the full CRUD endpoint set under the OWNER-scoped path", () => {
      const { pageScripts } = renderCustomerTab(activeData());
      // Create team — POST /teams
      expect(pageScripts).toContain(
        "/api/orgs/' + encodeURIComponent(CUSTOMER_ID) + '/teams",
      );
      expect(pageScripts).toContain("method: 'POST'");
      // Rename team — PATCH /teams/:teamId
      expect(pageScripts).toContain("method: 'PATCH'");
      // Delete team — DELETE /teams/:teamId
      expect(pageScripts).toContain("method: 'DELETE'");
      // Add/remove members — PUT/DELETE /teams/:teamId/members/:userId
      expect(pageScripts).toContain(
        "/teams/' + encodeURIComponent(teamId) + '/members/' + encodeURIComponent(userId",
      );
      // Grant/revoke vendor — PUT/DELETE /teams/:teamId/server-access/:vendor
      expect(pageScripts).toContain(
        "/teams/' + encodeURIComponent(teamId) + '/server-access/' + encodeURIComponent(slug)",
      );
      expect(pageScripts).toContain(
        "/teams/' + encodeURIComponent(teamId) + '/server-access/' + encodeURIComponent(revokeSlug)",
      );
    });

    it("script status-routes 403 / 429 / network to distinct messages", () => {
      const { pageScripts } = renderCustomerTab(activeData());
      expect(pageScripts).toContain("res.status === 403");
      expect(pageScripts).toContain("You don't have permission for this action.");
      expect(pageScripts).toContain("res.status === 429");
      expect(pageScripts).toContain("Rate limit hit. Try again in a few minutes.");
      expect(pageScripts).toContain("Network error. Check connection and retry.");
    });

    it("HTML-injection safety on team name", () => {
      const { body } = renderCustomerTab(
        data("teams", {
          actingAsActive: true,
          teams: [
            {
              id: "team_x",
              name: "<script>alert('xss')</script>",
              members: [],
              vendorAllowlist: [],
            },
          ],
        }),
      );
      expect(body).not.toContain("<script>alert('xss')</script>");
      expect(body).toContain("&lt;script&gt;");
    });

    it("XSS-safe embed for customer id in script (sweep continuity)", () => {
      const { pageScripts } = renderCustomerTab(
        data("teams", {
          actingAsActive: true,
          customer: {
            id: "cust_a<script>x</script>b",
            name: "Acme",
            plan: "BUSINESS",
            userCount: 0,
            mcpCount: 0,
            subdomain: "acme.example",
          },
        }),
      );
      expect(pageScripts).not.toContain("cust_a<script>x</script>b");
      expect(pageScripts).toContain("\\u003cscript>x\\u003c/script>b");
    });

    it("renders 'all members already on team' fallback when picker would be empty", () => {
      const { body } = renderCustomerTab(
        data("teams", {
          actingAsActive: true,
          membersForTeamPicker: [
            { userId: "u_alice", name: "Alice", email: "a@x.com" },
          ],
          teams: [
            {
              id: "t1",
              name: "Solo",
              members: [
                { userId: "u_alice", name: "Alice", email: "a@x.com" },
              ],
              vendorAllowlist: [],
            },
          ],
        }),
      );
      expect(body).toContain("All members already on this team");
    });

    it("renders 'all vendors already granted' fallback when grant-picker would be empty", () => {
      const { body } = renderCustomerTab(
        data("teams", {
          actingAsActive: true,
          vendorCatalog: [{ slug: "autotask", name: "Autotask" }],
          teams: [
            {
              id: "t1",
              name: "Solo",
              members: [],
              vendorAllowlist: ["autotask"],
            },
          ],
        }),
      );
      expect(body).toContain("All connected vendors already granted");
    });
  });

  describe("script behavior contract", () => {
    it("ACTING_AS flag flips between states", () => {
      const offScript = renderCustomerTab(data("teams")).pageScripts;
      expect(offScript).toContain("var ACTING_AS = false");

      const onScript = renderCustomerTab(
        data("teams", { actingAsActive: true, teams: [] }),
      ).pageScripts;
      expect(onScript).toContain("var ACTING_AS = true");
    });
  });
});
