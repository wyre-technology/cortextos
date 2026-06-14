import { describe, it, expect } from "vitest";
import { renderTeamMembers, type TeamMembersData } from "./team-members.js";

function data(over: Partial<TeamMembersData> = {}): TeamMembersData {
  return {
    orgId: "org_1",
    viewerUserId: "u1",
    viewerRole: "owner",
    members: [
      {
        userId: "u1",
        role: "owner",
        joinedAt: null,
        email: "a@x.com",
        name: "A",
      },
    ],
    ...over,
  };
}

describe("renderTeamMembers — §8 seat-cost note", () => {
  it("states each member is a $39/mo seat", () => {
    const html = renderTeamMembers(data());
    expect(html).toContain("$39/mo seat");
    expect(html).toContain("prorates your next bill");
  });
});

/**
 * Regression-guards for ruby MR3 (2026-06-05) — in-app toast
 * acknowledgments for admin's own member-removal + role-change actions.
 * Lock the wiring: data-attrs carry the member name + the JS handlers
 * fire showToast with the named copy on success.
 */
describe("renderTeamMembers — MR3 toast wiring", () => {
  function membersWithRemovable(): TeamMembersData {
    return data({
      members: [
        {
          userId: "u1",
          role: "owner",
          joinedAt: null,
          email: "a@x.com",
          name: "Alice Owner",
        },
        {
          userId: "u2",
          role: "member",
          joinedAt: null,
          email: "b@x.com",
          name: "Bob Member",
        },
      ],
    });
  }

  it("removable rows carry data-member-name on the Remove button (toast can name affected user)", () => {
    const html = renderTeamMembers(membersWithRemovable());
    expect(html).toContain('data-member-name="Bob Member"');
    expect(html).toContain(
      'onclick="removeMember(this.dataset.userId, this.dataset.memberName)"',
    );
  });

  it("role-select carries data-member-name (toast can name affected user on role change)", () => {
    const html = renderTeamMembers(membersWithRemovable());
    expect(html).toMatch(
      /<select class="role-select"[\s\S]*?data-member-name="Bob Member"/,
    );
    expect(html).toContain(
      'onchange="changeRole(this.dataset.userId, this.value, this.dataset.memberName)"',
    );
  });

  it("removeMember success path fires the named toast then reloads", () => {
    const html = renderTeamMembers(membersWithRemovable());
    expect(html).toContain(
      "showToast((memberName || 'A teammate') + ' removed from the team.')",
    );
    expect(html).toMatch(
      /setTimeout\(function\(\) \{ window\.location\.reload\(\); \}, 500\)/,
    );
  });

  it("changeRole success path fires the enriched named toast (replaces bare Role updated)", () => {
    const html = renderTeamMembers(membersWithRemovable());
    expect(html).toContain(
      "showToast((memberName || 'A teammate') + ' role changed to ' + newRole + '.')",
    );
    // Lock against regression to the bare-toast copy.
    expect(html).not.toContain("showToast('Role updated')");
  });
});

// ---------------------------------------------------------------------------
// 2026-06-13 sweep-2 cluster-2 (a) (boss): inline Invite CTA. Discoverability
// fix — Members page now surfaces a direct path to the invitation create
// flow at /org/invitations instead of forcing users to navigate manually.
// Role-gated to owner + admin (matches the server-side invitation create
// gate). Member-role users see no CTA.
// ---------------------------------------------------------------------------

describe("renderTeamMembers — inline Invite CTA (sweep-2 cluster-2 a)", () => {
  it("renders the Invite CTA for owner viewer", () => {
    const html = renderTeamMembers(data({ viewerRole: "owner" }));
    expect(html).toContain("Invite a member");
    expect(html).toContain('href="/org/invitations"');
  });

  it("renders the Invite CTA for admin viewer", () => {
    const html = renderTeamMembers(data({ viewerRole: "admin" }));
    expect(html).toContain("Invite a member");
    expect(html).toContain('href="/org/invitations"');
  });

  it("omits the Invite CTA for member viewer (server-side gate matches)", () => {
    const html = renderTeamMembers(data({ viewerRole: "member" }));
    expect(html).not.toContain("Invite a member");
    expect(html).not.toContain('href="/org/invitations"');
  });
});
