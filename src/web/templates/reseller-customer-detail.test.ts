import { describe, it, expect } from "vitest";
import {
  renderResellerCustomerDetail,
  RESELLER_CUSTOMER_DETAIL_STYLES,
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
  suspendedAt: null,
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

  // -----------------------------------------------------------------------
  // LAYER-C UI fast-win: delete-customer button + confirmation modal.
  // PR-1 (boss msg-1781748066737). The button wires to existing
  // DELETE /api/orgs/:orgId (PR-2 will rewrite to soft-delete admin-
  // threshold; this UI primitive banks the typed-name confirmation per
  // warden pre-prep msg-1781747367566 before the backend match lands).
  // -----------------------------------------------------------------------

  describe("delete-customer button + confirmation modal", () => {
    it("renders a Delete button next to the Onboard MCP button", () => {
      const { body } = renderResellerCustomerDetail(data());
      expect(body).toContain('id="cdDeleteOpen"');
      expect(body).toContain("Delete customer");
      expect(body).toContain('aria-controls="cdDeleteModal"');
    });

    it("renders the modal hidden by default with dialog semantics", () => {
      const { body } = renderResellerCustomerDetail(data());
      expect(body).toMatch(/id="cdDeleteModal"[^>]*hidden/);
      expect(body).toContain('role="dialog"');
      expect(body).toContain('aria-modal="true"');
      expect(body).toContain('aria-labelledby="cdDeleteTitle"');
    });

    it("modal title + description reference the specific customer name", () => {
      const { body } = renderResellerCustomerDetail(data());
      expect(body).toContain("Delete AM3 Technology");
      expect(body).toContain("type the customer name");
    });

    it("modal has a typed-confirm input and a disabled submit by default", () => {
      const { body } = renderResellerCustomerDetail(data());
      expect(body).toContain('id="cdDeleteConfirm"');
      expect(body).toMatch(/id="cdDeleteSubmit"[\s\S]*?disabled/);
      // Cancel + dismiss-overlay primitives must exist for esc/cancel UX.
      expect(body).toContain('id="cdDeleteCancel"');
      expect(body).toMatch(/cd-modal-overlay[^>]*data-cd-modal-dismiss/);
    });

    it("escapes the customer name inside the modal title (no HTML injection)", () => {
      const { body } = renderResellerCustomerDetail(
        data({ name: "<script>x</script>" }),
      );
      // Title slot uses the escaped name, never raw markup.
      expect(body).toContain('id="cdDeleteTitle"');
      expect(body).not.toContain("Delete <script>x</script>");
      expect(body).toContain("Delete &lt;script&gt;");
    });

    it("delete script targets the customer id, not the reseller id", () => {
      const { pageScripts } = renderResellerCustomerDetail(
        data({ id: "cust_target_99" }),
      );
      // Endpoint shape: DELETE /api/orgs/:customerId — encodeURIComponent
      // protects ids that contain reserved characters.
      expect(pageScripts).toContain('"cust_target_99"');
      expect(pageScripts).toContain("/api/orgs/' + encodeURIComponent(CUSTOMER_ID)");
      expect(pageScripts).toContain("method: 'DELETE'");
    });

    it("delete script encodes the expected-name match constant from server", () => {
      const { pageScripts } = renderResellerCustomerDetail(
        data({ name: "AM3 Technology" }),
      );
      // The match value is the ORIGINAL customer name (unescaped) — the
      // browser compares it against the typed input directly. HTML
      // escaping is for rendering only, not for the JSON.stringify'd
      // script constant.
      expect(pageScripts).toContain('"AM3 Technology"');
      // The typed-match check is exact-equality (case + whitespace).
      expect(pageScripts).toContain("INPUT.value !== EXPECTED_NAME");
    });

    it("delete request body carries org_name for warden-pre-prep backend match", () => {
      const { pageScripts } = renderResellerCustomerDetail(data());
      // PR-2's backend will strict-match body.org_name === current org.name.
      // The UI ships the match payload now so PR-2 sees a well-shaped
      // request the moment it lands (no UI re-touch).
      expect(pageScripts).toContain(
        "JSON.stringify({ org_name: EXPECTED_NAME })",
      );
    });

    it("delete script routes the 403 / 404 / 429 / network responses to distinct status messages", () => {
      const { pageScripts } = renderResellerCustomerDetail(data());
      // Each error class gets a user-actionable explanation —
      // forensics-precondition + user-trust both depend on the message
      // matching the actual cause, not a generic 'failed.'
      expect(pageScripts).toContain("res.status === 403");
      expect(pageScripts).toContain("Only an org owner can delete");
      expect(pageScripts).toContain("res.status === 404");
      expect(pageScripts).toContain("may already be deleted");
      expect(pageScripts).toContain("res.status === 429");
      expect(pageScripts).toContain("Rate limit hit");
      expect(pageScripts).toContain("Network error");
    });

    it("delete script redirects to /org/customers on 204 success", () => {
      const { pageScripts } = renderResellerCustomerDetail(data());
      expect(pageScripts).toContain("res.status === 204");
      expect(pageScripts).toContain("window.location.href = '/org/customers'");
    });

    it("delete script binds Esc to close-modal (screen-reader contract)", () => {
      const { pageScripts } = renderResellerCustomerDetail(data());
      expect(pageScripts).toContain("ev.key === 'Escape'");
      expect(pageScripts).toContain("closeModal");
    });

    it("delete script restores focus to the trigger on close (a11y contract)", () => {
      const { pageScripts } = renderResellerCustomerDetail(data());
      // prevFocus captured on open, restored on close — prevents
      // orphaned focus in the document body after dialog teardown.
      expect(pageScripts).toContain("prevFocus = document.activeElement");
      expect(pageScripts).toContain("prevFocus.focus()");
    });

    it("modal CSS exposes both the danger-button surfaces (header trigger + solid submit)", () => {
      // Style block is exported separately; assert both surfaces exist.
      expect(RESELLER_CUSTOMER_DETAIL_STYLES).toContain(".cd-btn-danger");
      expect(RESELLER_CUSTOMER_DETAIL_STYLES).toContain(".cd-btn-danger-solid");
      expect(RESELLER_CUSTOMER_DETAIL_STYLES).toContain(".cd-modal");
      expect(RESELLER_CUSTOMER_DETAIL_STYLES).toContain(".cd-modal-input");
    });

    // -------------------------------------------------------------------
    // Warden HIGH-sev XSS regression artifact (PR #447 follow-up, boss
    // msg-1781749015009). The pre-fix vector: customer.name was embedded
    // into the <script> via JSON.stringify, which does not escape
    // </script> — a stored malicious org-name like
    // `foo</script><img src=x onerror=…>` broke out of the script
    // element and ran arbitrary HTML in the viewing operator's session.
    // Fix is jsonForScriptEmbed (src/web/helpers.ts), which Unicode-
    // escapes `<`. This regression locks the vector closed forever; any
    // future regression that drops back to bare JSON.stringify is
    // caught at unit-test time, not in production.
    // -------------------------------------------------------------------
    it("WARDEN-REGRESSION: stored malicious org-name cannot break out of the script tag", () => {
      const malicious =
        "foo</script><img src=x onerror=alert(1)>";
      const { pageScripts } = renderResellerCustomerDetail(
        data({ name: malicious }),
      );

      // The malicious payload's exact attack signature MUST NOT appear
      // unescaped anywhere in the rendered script. Pre-fix this string
      // appeared verbatim inside the `var EXPECTED_NAME = "..."` embed;
      // post-fix the `<` is Unicode-escaped so the HTML parser stays in
      // script-data state.
      expect(pageScripts).not.toContain("</script><img");
      expect(pageScripts).not.toContain(`"foo</script>`);

      // The hardened Unicode-escaped form MUST appear instead. Only
      // `<` needs escaping (the trailing `>` is harmless once the HTML
      // parser can't see a tag-open); `</script>` is enough to
      // neutralize the vector and keep the JS parser-equivalent value.
      expect(pageScripts).toContain(`"foo\\u003c/script>`);
      expect(pageScripts).toContain(
        "\\u003cimg src=x onerror=alert(1)>",
      );
    });

    it("WARDEN-REGRESSION: customer id also routes through the script-embed hardener", () => {
      // Customer ids look nanoid-shaped today (no `<` reachable), but
      // routing them through the hardener too is the defensive-sweep
      // posture warden requested — by-construction is cheaper than
      // per-site reasoning, and a future change that fed display
      // names into the id slot would otherwise reopen the vector.
      const synth = "cust_a<script>x</script>b";
      const { pageScripts } = renderResellerCustomerDetail(data({ id: synth }));
      expect(pageScripts).not.toContain("<script>x</script>b");
      expect(pageScripts).toContain("\\u003cscript>x\\u003c/script>b");
    });

    it("WARDEN-REGRESSION: BASE URL embed routes through the hardener (sibling buildScript site)", () => {
      // BASE is composed of customerId + resellerId, currently nanoid-
      // shaped, but sweep-coverage discipline: the embed site must
      // route through the hardener too. Asserting by-shape: with a
      // safe id the BASE assignment is the expected literal — the same
      // assertion future-proofs against a regression that drops the
      // hardener and re-introduces a bare JSON.stringify.
      const { pageScripts } = renderResellerCustomerDetail(
        data({ id: "cust_safe" }),
      );
      expect(pageScripts).toContain(
        'var BASE = "/admin/reseller/org_reseller/customers/cust_safe/dashboard"',
      );
    });
  });
});
