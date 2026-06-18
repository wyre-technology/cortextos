import { describe, it, expect } from "vitest";
import {
  renderResellerAudit,
  type ResellerAuditData,
} from "./reseller-audit.js";
import type { Organization } from "../../org/org-service.js";
import type { AdminAuditEntry } from "../../audit/admin-audit-service.js";

const baseOrg: Organization = {
  id: "org_reseller_xyz",
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
  updatedAt: "2026-06-14T00:00:00Z",
};

function entry(over: Partial<AdminAuditEntry> = {}): AdminAuditEntry {
  return {
    id: "ev_1",
    orgId: baseOrg.id,
    actorId: "auth0|actor",
    actorEmail: "actor@example.com",
    actorName: "Actor One",
    targetId: "auth0|target",
    targetEmail: "target@example.com",
    targetName: "Target Two",
    eventType: "member_invited",
    metadata: { invite_role: "member" },
    createdAt: "2026-06-14T15:30:00Z",
    ...over,
  };
}

function data(over: Partial<ResellerAuditData> = {}): ResellerAuditData {
  return {
    org: baseOrg,
    entries: [entry()],
    total: 1,
    page: 1,
    pageSize: 50,
    eventTypeFilter: null,
    availableEventTypes: ["member_invited", "customer_org_created"],
    ...over,
  };
}

describe("renderResellerAudit", () => {
  it("renders heading + org name + total count", () => {
    const html = renderResellerAudit(data({ total: 17 }));
    expect(html).toContain("Audit Log");
    expect(html).toContain("WYRE Technology");
    expect(html).toContain("17 events");
  });

  it("pluralizes '1 event' singular", () => {
    const html = renderResellerAudit(data({ total: 1 }));
    expect(html).toMatch(/\b1 event\b(?!s)/);
  });

  it("escapes org name (no HTML injection)", () => {
    const html = renderResellerAudit(
      data({ org: { ...baseOrg, name: "<script>x</script>" } }),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  describe("empty state", () => {
    it("renders the empty-message when there are no entries", () => {
      const html = renderResellerAudit(data({ entries: [], total: 0 }));
      expect(html).toContain("No audit events recorded");
      expect(html).toContain("0 events");
    });
  });

  describe("entry rendering", () => {
    it("renders the event-type badge", () => {
      const html = renderResellerAudit(data());
      expect(html).toContain('class="event-badge"');
      expect(html).toContain("member_invited");
    });

    it("renders actor name + email", () => {
      const html = renderResellerAudit(data());
      expect(html).toContain("Actor One");
      expect(html).toContain("actor@example.com");
    });

    it("renders target when present", () => {
      const html = renderResellerAudit(data());
      expect(html).toContain("Target Two");
    });

    it("renders mdash for missing target", () => {
      const html = renderResellerAudit(
        data({
          entries: [
            entry({ targetId: null, targetEmail: null, targetName: null }),
          ],
        }),
      );
      // The target cell should show the mdash entity (5 td columns; check that
      // a mdash appears in the rendered HTML.)
      expect(html).toContain("&mdash;");
    });

    it("formats timestamp as YYYY-MM-DD HH:MM UTC (deterministic)", () => {
      const html = renderResellerAudit(data());
      expect(html).toContain("2026-06-14 15:30 UTC");
    });

    it("escapes XSS in actor name", () => {
      const html = renderResellerAudit(
        data({
          entries: [entry({ actorName: "<img src=x onerror=alert(1)>" })],
        }),
      );
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img");
    });

    it("escapes XSS in event-type (defensive — eventType is typed as AdminEventType but runtime DB rows can drift)", () => {
      // Cast through unknown: simulate a runtime row whose event_type
      // doesn't match a known AdminEventType variant. The template must
      // still escape — defensive against future DB-introduced event
      // types that haven't been added to the TypeScript enum yet.
      const html = renderResellerAudit(
        data({
          entries: [
            entry({
              eventType:
                "<svg/onload=alert(1)>" as unknown as AdminAuditEntry["eventType"],
            }),
          ],
        }),
      );
      expect(html).not.toContain("<svg/onload");
      expect(html).toContain("&lt;svg");
    });

    it("metadata preview shows first 2 keys + 'N more' when longer", () => {
      const html = renderResellerAudit(
        data({
          entries: [
            entry({
              metadata: { a: 1, b: 2, c: 3, d: 4 },
            }),
          ],
        }),
      );
      expect(html).toContain("a=1");
      expect(html).toContain("b=2");
      expect(html).toContain("+2 more");
    });
  });

  describe("filter dropdown", () => {
    it("populates the dropdown with availableEventTypes + 'All events' default", () => {
      const html = renderResellerAudit(
        data({
          availableEventTypes: ["customer_org_created", "member_invited"],
        }),
      );
      expect(html).toContain('<option value="">All events</option>');
      expect(html).toContain('<option value="customer_org_created"');
      expect(html).toContain('<option value="member_invited"');
    });

    it("pre-selects the active filter option", () => {
      const html = renderResellerAudit(
        data({ eventTypeFilter: "member_invited" }),
      );
      expect(html).toMatch(/value="member_invited" selected/);
    });

    it("no option is pre-selected when filter is null", () => {
      const html = renderResellerAudit(data({ eventTypeFilter: null }));
      // 'All events' is the value="" option; it should not have selected
      // (the filter dropdown should reflect that no specific filter is
      // active — the empty-value option is the default).
      expect(html).not.toMatch(/value="member_invited" selected/);
    });
  });

  describe("pagination", () => {
    it("hides pagination when only 1 page worth of entries", () => {
      const html = renderResellerAudit(
        data({ total: 10, page: 1, pageSize: 50 }),
      );
      expect(html).not.toContain("Page 1 of");
      expect(html).not.toContain("Previous");
    });

    it("shows prev/next + page indicator when multi-page", () => {
      const html = renderResellerAudit(
        data({ total: 175, page: 2, pageSize: 50 }),
      );
      expect(html).toContain("Page 2 of 4");
      expect(html).toContain("Previous");
      expect(html).toContain("Next");
    });

    it("Previous link is disabled on page 1", () => {
      const html = renderResellerAudit(
        data({ total: 175, page: 1, pageSize: 50 }),
      );
      expect(html).toMatch(
        /<span class="btn-secondary disabled">&larr; Previous<\/span>/,
      );
    });

    it("Next link is disabled on last page", () => {
      const html = renderResellerAudit(
        data({ total: 175, page: 4, pageSize: 50 }),
      );
      expect(html).toMatch(
        /<span class="btn-secondary disabled">Next &rarr;<\/span>/,
      );
    });

    it("pagination links preserve the active event-type filter", () => {
      const html = renderResellerAudit(
        data({
          total: 175,
          page: 2,
          pageSize: 50,
          eventTypeFilter: "member_invited",
        }),
      );
      expect(html).toContain("event_type=member_invited");
      // Both prev (page=1) and next (page=3) should include the filter QS.
      expect(html).toContain("page=1&amp;event_type=member_invited");
      expect(html).toContain("page=3&amp;event_type=member_invited");
    });

    it("URL-encodes the filter value", () => {
      const html = renderResellerAudit(
        data({
          total: 175,
          page: 2,
          pageSize: 50,
          eventTypeFilter: "weird&value with spaces",
        }),
      );
      expect(html).toContain(encodeURIComponent("weird&value with spaces"));
    });
  });
});
