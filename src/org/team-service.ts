import type postgres from 'postgres';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgTeam {
  id: string;
  orgId: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface OrgTeamMember {
  id: string;
  teamId: string;
  orgId: string;
  userId: string;
  addedBy: string;
  addedAt: string;
}

export interface OrgTeamServerAccess {
  id: string;
  orgId: string;
  teamId: string;
  vendorSlug: string;
  grantedBy: string;
  grantedAt: string;
}

export interface OrgTeamWithMembers extends OrgTeam {
  members: { userId: string; email: string | null; name: string | null }[];
  serverAccess: string[]; // vendor slugs
}

// Row shapes
interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  created_by: string;
  created_at: string;
}

interface TeamMemberRow {
  id: string;
  team_id: string;
  org_id: string;
  user_id: string;
  added_by: string;
  added_at: string;
}

interface TeamServerAccessRow {
  id: string;
  org_id: string;
  team_id: string;
  vendor_slug: string;
  granted_by: string;
  granted_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeamService {
  constructor(private sql: postgres.Sql) {}

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS org_teams (
        id         TEXT PRIMARY KEY,
        org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, name)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_team_members (
        id       TEXT PRIMARY KEY,
        team_id  TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
        org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by TEXT NOT NULL REFERENCES users(id),
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_team_members_org_user ON org_team_members(org_id, user_id)
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_team_server_access (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        team_id     TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
        vendor_slug TEXT NOT NULL,
        granted_by  TEXT NOT NULL REFERENCES users(id),
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(team_id, vendor_slug)
      )
    `;
  }

  // -------------------------------------------------------------------------
  // Row mapping
  // -------------------------------------------------------------------------

  private toTeam(row: TeamRow): OrgTeam {
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private toTeamMember(row: TeamMemberRow): OrgTeamMember {
    return {
      id: row.id,
      teamId: row.team_id,
      orgId: row.org_id,
      userId: row.user_id,
      addedBy: row.added_by,
      addedAt: row.added_at,
    };
  }

  private toTeamServerAccess(row: TeamServerAccessRow): OrgTeamServerAccess {
    return {
      id: row.id,
      orgId: row.org_id,
      teamId: row.team_id,
      vendorSlug: row.vendor_slug,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    };
  }

  // -------------------------------------------------------------------------
  // Teams CRUD
  // -------------------------------------------------------------------------

  async createTeam(orgId: string, name: string, createdBy: string): Promise<OrgTeam> {
    const id = nanoid();
    const rows = await this.sql<TeamRow[]>`
      INSERT INTO org_teams (id, org_id, name, created_by)
      VALUES (${id}, ${orgId}, ${name}, ${createdBy})
      RETURNING *
    `;
    return this.toTeam(rows[0]);
  }

  async getTeam(teamId: string): Promise<OrgTeam | null> {
    const rows = await this.sql<TeamRow[]>`
      SELECT * FROM org_teams WHERE id = ${teamId}
    `;
    return rows[0] ? this.toTeam(rows[0]) : null;
  }

  async listTeams(orgId: string): Promise<OrgTeam[]> {
    const rows = await this.sql<TeamRow[]>`
      SELECT * FROM org_teams WHERE org_id = ${orgId} ORDER BY created_at
    `;
    return rows.map((r) => this.toTeam(r));
  }

  async renameTeam(teamId: string, name: string): Promise<OrgTeam | null> {
    const rows = await this.sql<TeamRow[]>`
      UPDATE org_teams SET name = ${name} WHERE id = ${teamId} RETURNING *
    `;
    return rows[0] ? this.toTeam(rows[0]) : null;
  }

  async deleteTeam(teamId: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM org_teams WHERE id = ${teamId}`;
    return result.count > 0;
  }

  // -------------------------------------------------------------------------
  // Team membership
  // -------------------------------------------------------------------------

  async addMember(teamId: string, orgId: string, userId: string, addedBy: string): Promise<OrgTeamMember | null> {
    const id = nanoid();
    const rows = await this.sql<TeamMemberRow[]>`
      INSERT INTO org_team_members (id, team_id, org_id, user_id, added_by)
      VALUES (${id}, ${teamId}, ${orgId}, ${userId}, ${addedBy})
      ON CONFLICT (team_id, user_id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return this.toTeamMember(rows[0]);
    // Already exists
    const existing = await this.sql<TeamMemberRow[]>`
      SELECT * FROM org_team_members WHERE team_id = ${teamId} AND user_id = ${userId}
    `;
    return existing[0] ? this.toTeamMember(existing[0]) : null;
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_team_members WHERE team_id = ${teamId} AND user_id = ${userId}
    `;
    return result.count > 0;
  }

  async getTeamMembersWithProfiles(teamId: string): Promise<{ userId: string; email: string | null; name: string | null }[]> {
    const rows = await this.sql<{ user_id: string; email: string | null; name: string | null }[]>`
      SELECT m.user_id, u.email, u.name
      FROM org_team_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ${teamId}
      ORDER BY m.added_at
    `;
    return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name }));
  }

  async getUserTeams(orgId: string, userId: string): Promise<OrgTeam[]> {
    const rows = await this.sql<TeamRow[]>`
      SELECT t.* FROM org_teams t
      JOIN org_team_members m ON m.team_id = t.id
      WHERE t.org_id = ${orgId} AND m.user_id = ${userId}
      ORDER BY t.created_at
    `;
    return rows.map((r) => this.toTeam(r));
  }

  // -------------------------------------------------------------------------
  // Team server access
  // -------------------------------------------------------------------------

  async grantServerAccess(orgId: string, teamId: string, vendorSlug: string, grantedBy: string): Promise<OrgTeamServerAccess | null> {
    const id = nanoid();
    const rows = await this.sql<TeamServerAccessRow[]>`
      INSERT INTO org_team_server_access (id, org_id, team_id, vendor_slug, granted_by)
      VALUES (${id}, ${orgId}, ${teamId}, ${vendorSlug}, ${grantedBy})
      ON CONFLICT (team_id, vendor_slug) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return this.toTeamServerAccess(rows[0]);
    const existing = await this.sql<TeamServerAccessRow[]>`
      SELECT * FROM org_team_server_access WHERE team_id = ${teamId} AND vendor_slug = ${vendorSlug}
    `;
    return existing[0] ? this.toTeamServerAccess(existing[0]) : null;
  }

  async revokeServerAccess(teamId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_team_server_access WHERE team_id = ${teamId} AND vendor_slug = ${vendorSlug}
    `;
    return result.count > 0;
  }

  async listServerAccess(teamId: string): Promise<OrgTeamServerAccess[]> {
    const rows = await this.sql<TeamServerAccessRow[]>`
      SELECT * FROM org_team_server_access WHERE team_id = ${teamId} ORDER BY granted_at
    `;
    return rows.map((r) => this.toTeamServerAccess(r));
  }

  async bulkSetServerAccess(orgId: string, teamId: string, vendorSlugs: string[], grantedBy: string): Promise<void> {
    await this.sql`DELETE FROM org_team_server_access WHERE team_id = ${teamId}`;
    for (const slug of vendorSlugs) {
      const id = nanoid();
      await this.sql`
        INSERT INTO org_team_server_access (id, org_id, team_id, vendor_slug, granted_by)
        VALUES (${id}, ${orgId}, ${teamId}, ${slug}, ${grantedBy})
        ON CONFLICT (team_id, vendor_slug) DO NOTHING
      `;
    }
  }

  // -------------------------------------------------------------------------
  // Union helper: does the user have team-granted access?
  // -------------------------------------------------------------------------

  async hasTeamServerAccess(orgId: string, userId: string, vendorSlug: string): Promise<boolean> {
    const rows = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM org_team_server_access tsa
      JOIN org_team_members tm ON tm.team_id = tsa.team_id AND tm.user_id = ${userId}
      WHERE tsa.org_id = ${orgId} AND tsa.vendor_slug = ${vendorSlug}
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

  async listTeamsWithDetails(orgId: string): Promise<OrgTeamWithMembers[]> {
    const teams = await this.listTeams(orgId);
    if (teams.length === 0) return [];

    const teamIds = teams.map((t) => t.id);

    // Batch-fetch members and access for all teams in 2 queries
    const [memberRows, accessRows] = await Promise.all([
      this.sql<{ team_id: string; user_id: string; email: string | null; name: string | null }[]>`
        SELECT m.team_id, m.user_id, u.email, u.name
        FROM org_team_members m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.team_id IN ${this.sql(teamIds)}
        ORDER BY m.added_at
      `,
      this.sql<{ team_id: string; vendor_slug: string }[]>`
        SELECT team_id, vendor_slug
        FROM org_team_server_access
        WHERE team_id IN ${this.sql(teamIds)}
      `,
    ]);

    // Group by team
    const membersByTeam = new Map<string, { userId: string; email: string | null; name: string | null }[]>();
    for (const r of memberRows) {
      let arr = membersByTeam.get(r.team_id);
      if (!arr) { arr = []; membersByTeam.set(r.team_id, arr); }
      arr.push({ userId: r.user_id, email: r.email, name: r.name });
    }

    const accessByTeam = new Map<string, string[]>();
    for (const r of accessRows) {
      let arr = accessByTeam.get(r.team_id);
      if (!arr) { arr = []; accessByTeam.set(r.team_id, arr); }
      arr.push(r.vendor_slug);
    }

    return teams.map((team) => ({
      ...team,
      members: membersByTeam.get(team.id) ?? [],
      serverAccess: accessByTeam.get(team.id) ?? [],
    }));
  }

  async listEffectiveTeamAccessForOrg(orgId: string): Promise<{ userId: string; vendorSlug: string }[]> {
    const rows = await this.sql<{ user_id: string; vendor_slug: string }[]>`
      SELECT DISTINCT tm.user_id, tsa.vendor_slug
      FROM org_team_server_access tsa
      JOIN org_team_members tm ON tm.team_id = tsa.team_id
      WHERE tsa.org_id = ${orgId}
    `;
    return rows.map((r) => ({ userId: r.user_id, vendorSlug: r.vendor_slug }));
  }
}
