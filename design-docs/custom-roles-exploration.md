# Custom Roles Exploration

**Date:** 2026-02-23
**Status:** Exploration / RFC
**Author:** Engineering

---

## 1. Current Role Model

The MCP Gateway uses a three-tier RBAC hierarchy defined in `src/org/org-service.ts`:

```typescript
export type OrgRole = 'owner' | 'admin' | 'member';

export const ROLE_LEVEL: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};
```

Authorization is enforced by the `requireOrgRole()` helper in `src/org/routes.ts`, which compares the caller's numeric `ROLE_LEVEL` against a minimum threshold. This means the hierarchy is strictly linear: owner > admin > member.

### Permission Matrix

| Action | Owner (3) | Admin (2) | Member (1) |
|--------|:---------:|:---------:|:----------:|
| View org details | Yes | Yes | Yes |
| List members | Yes | Yes | Yes |
| List org credentials (vendor slugs) | Yes | Yes | Yes |
| Create/delete org | Yes | — | — |
| Rename org | Yes | — | — |
| Update org settings (e.g. `defaultServerAccess`) | Yes | — | — |
| Change member roles | Yes | — | — |
| Redeem invite codes / manage billing | Yes | — | — |
| Create invitation links | Yes | Yes | — |
| List/revoke invitations | Yes | Yes | — |
| Remove members | Yes | Yes* | — |
| Store/delete org credentials | Yes | Yes | — |
| Manage server access grants | Yes | Yes | — |
| Delete org | Yes | — | — |

\* Admins cannot remove other admins — only the owner can.

### Server Access Control

Beyond role-based checks, the gateway has per-member **server access control** (`org_server_access` table). Admins grant individual members access to specific vendor servers. Owners bypass this check entirely — they always have access.

This two-layer model (role → server access) already provides meaningful segmentation: an admin can restrict a member to only the vendors they need.

### What's Coming: Tool Allowlisting

The next planned feature (Workstream 1) adds **per-role tool allowlisting** — the ability to restrict which MCP tools a given role can invoke on each vendor server. For example, a member might have access to the ConnectWise PSA server but only be allowed to call `list_tickets` and `get_ticket`, not `delete_ticket` or `update_configuration`.

This is a critical piece of context for the custom roles discussion.

---

## 2. Use Cases for Custom Roles

MSP teams have diverse functional responsibilities. The current owner/admin/member model doesn't naturally map to these divisions:

### Finance / Billing

- **Who:** Office managers, bookkeepers, CFOs
- **Need:** Access to contracts (SalesBuildr), invoicing, time entries in PSA tools (Autotask, ConnectWise PSA, HaloPSA)
- **Don't need:** RMM agent management, documentation editing, security tools
- **Example:** A bookkeeper should pull invoice data from ConnectWise PSA but never reboot a server via Datto RMM

### Operations / Service Delivery

- **Who:** Help desk technicians, NOC engineers, field techs
- **Need:** RMM tools (Datto RMM, NinjaOne, ConnectWise Automate, Atera), ticketing (PSA tools), documentation (IT Glue)
- **Don't need:** Billing/contract data, credential management, security audit logs
- **Example:** A NOC engineer monitors endpoints via NinjaOne and creates tickets in HaloPSA but has no business viewing contracts

### Security / Compliance

- **Who:** Security analysts, compliance officers, vCISOs
- **Need:** Audit log access, Liongard inspections, credential rotation visibility
- **Don't need:** Day-to-day ticketing, billing, RMM remote access
- **Example:** A vCISO reviews Liongard configuration assessments and audit logs but shouldn't execute remote commands

### Read-Only / Viewer

- **Who:** Executives, clients (in white-label scenarios), external auditors
- **Need:** Dashboard views, reports, read-only access to select data
- **Don't need:** Any write operations
- **Example:** An MSP client views their own ticket status and SLA metrics without modifying anything

---

## 3. Architecture Options

### Option A: Named Roles

Add fixed domain-specific roles to the hierarchy.

```
owner (4) > admin (3) > billing (2) > ops (2) > security (2) > viewer (1) > member (1)
```

**Schema change:**

```sql
ALTER TABLE org_members DROP CONSTRAINT org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check
  CHECK (role IN ('owner', 'admin', 'billing', 'ops', 'security', 'viewer', 'member'));
```

```typescript
export type OrgRole = 'owner' | 'admin' | 'billing' | 'ops' | 'security' | 'viewer' | 'member';

export const ROLE_LEVEL: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  billing: 2,
  ops: 2,
  security: 2,
  viewer: 1,
  member: 1,
};
```

Each named role would come with a predefined set of vendor access defaults and tool allowlists.

**Pros:**
- Simple mental model — admins pick from a dropdown
- Easy to document and explain
- Minimal schema changes

**Cons:**
- Inflexible — MSPs have different team structures and the names may not fit
- Roles at the same level (billing, ops, security) can't be meaningfully compared with `ROLE_LEVEL`; the numeric hierarchy breaks down for lateral roles
- Adding new roles requires code changes and migrations
- Doesn't scale to the variety of MSP org structures

### Option B: Role + Permission Flags

Keep the three-tier hierarchy but add granular permission flags per member.

**New table:**

```sql
CREATE TABLE org_member_permissions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id, permission)
);
```

**Example permissions:**

| Permission Key | Description |
|---------------|-------------|
| `credentials.manage` | Store/delete org credentials |
| `members.invite` | Create invitation links |
| `members.remove` | Remove members |
| `members.manage_access` | Grant/revoke server access |
| `audit.view` | View admin audit log |
| `billing.manage` | Manage Stripe subscription |
| `settings.manage` | Update org settings |

Authorization would check: `ROLE_LEVEL[role] >= minRole OR hasPermission(userId, permission)`.

**Pros:**
- Fine-grained control without changing the role model
- Additive — only override defaults when needed
- Permissions are self-documenting

**Cons:**
- Combinatorial complexity — N members × M permissions
- Harder to reason about "what can user X do?"
- UI complexity: need a permission matrix editor
- Risk of permission sprawl over time

### Option C: Custom Roles (Admin-Defined)

Let org admins create custom roles with arbitrary permission sets.

**New tables:**

```sql
CREATE TABLE org_custom_roles (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  level       INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, name)
);

CREATE TABLE org_role_permissions (
  id      TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES org_custom_roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  UNIQUE(role_id, permission)
);

CREATE TABLE org_role_vendor_access (
  id          TEXT PRIMARY KEY,
  role_id     TEXT NOT NULL REFERENCES org_custom_roles(id) ON DELETE CASCADE,
  vendor_slug TEXT NOT NULL,
  UNIQUE(role_id, vendor_slug)
);

CREATE TABLE org_role_tool_allowlist (
  id          TEXT PRIMARY KEY,
  role_id     TEXT NOT NULL REFERENCES org_custom_roles(id) ON DELETE CASCADE,
  vendor_slug TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  UNIQUE(role_id, vendor_slug, tool_name)
);
```

Members would be assigned a custom role instead of (or in addition to) the base role. The custom role defines which vendors they see, which tools they can invoke, and which admin permissions they hold.

**Pros:**
- Maximum flexibility — admins model their exact org structure
- Roles are reusable across members
- Clean separation of concerns (role definition vs. role assignment)

**Cons:**
- Significant implementation effort (4+ new tables, role editor UI, migration path)
- Cognitive overhead for small MSPs (most have 3–10 people)
- Risk of misconfiguration — custom roles can create confusing permission states
- Requires template/preset system to be usable out of the box
- Overkill for the current user base

### Option D: Tool Allowlisting is Sufficient

The combination of the existing three-tier hierarchy **plus** server access control **plus** the upcoming per-role tool allowlisting already solves the core use cases — without introducing new role concepts.

**How it maps to use cases:**

| Use Case | Solution with Existing + Tool Allowlisting |
|----------|-------------------------------------------|
| Finance staff | Grant server access to PSA vendors only. Allowlist only finance-related tools (e.g. `list_invoices`, `get_contract`, `list_time_entries`). |
| Operations | Grant access to RMM + PSA + documentation vendors. Allowlist operational tools. |
| Security | Grant access to Liongard + audit-related tools only. |
| Read-only | Grant server access as needed. Allowlist only `list_*` and `get_*` tools (read-only operations). |

**The key insight:** In the MCP protocol, everything is a tool call. There are no separate "read" vs "write" API endpoints — it's all `tools/call` with a tool name. Tool allowlisting directly controls what actions a member can take, which is the fundamental unit of access control in this system.

**What this looks like in practice:**

1. Admin adds a new team member (role: `member`)
2. Admin grants them server access to `connectwise-psa` and `salesbuildr`
3. Admin configures tool allowlists:
   - `connectwise-psa`: `list_invoices`, `get_invoice`, `list_time_entries`
   - `salesbuildr`: `list_proposals`, `get_proposal`
4. Member can only interact with those two vendors and only via those specific tools

No new role type needed. The existing RBAC handles admin vs. member boundaries. Server access handles which vendors. Tool allowlisting handles which operations.

**Pros:**
- Zero new schema beyond what's already planned (tool allowlisting)
- No migration or backwards-compatibility concerns
- Simple mental model: "which vendors can they access?" + "which tools can they use?"
- Matches the MCP protocol's actual access model (everything is a tool)
- Works today (server access) with tool allowlisting completing the picture

**Cons:**
- No reusable "role templates" — each member is configured individually
- Could be tedious for large teams (mitigated by bulk operations and org defaults)
- Doesn't give roles a human-readable name (a member restricted to finance tools isn't labeled "Finance")

---

## 4. Vendor Categorization

The 14 vendors in `src/credentials/vendor-config.ts` map to these MSP functional categories:

| Category | Vendors | Typical Users |
|----------|---------|---------------|
| **PSA (Professional Services Automation)** | Autotask, ConnectWise PSA, HaloPSA, Syncro, SuperOps | Service managers, dispatchers, account managers |
| **RMM (Remote Monitoring & Management)** | Datto RMM, NinjaOne, ConnectWise Automate, Atera, Syncro*, SuperOps* | NOC engineers, field techs, help desk |
| **Documentation** | IT Glue | All technical staff, onboarding, compliance |
| **Sales / Quoting** | SalesBuildr | Sales team, account managers |
| **Security / Compliance** | Liongard | Security analysts, vCISOs, compliance officers |

\* Syncro and SuperOps are all-in-one platforms spanning PSA + RMM.

This categorization is useful for **Option D** even without named roles: admins can use it as a mental model when configuring server access. The UI could group vendors by category to make it faster to grant "all RMM tools" or "all PSA tools" to a member.

### Future Vendor Categories

As the plugin ecosystem grows, new categories will likely emerge:

| Category | Potential Vendors |
|----------|------------------|
| **Finance / Accounting** | QuickBooks MCP, Xero MCP, FreshBooks |
| **Communication** | Microsoft Teams, Slack, email integrations |
| **Identity / Directory** | Azure AD, Okta, JumpCloud |
| **Backup** | Veeam, Axcient, Datto BCDR |
| **Network** | Meraki, Ubiquiti, Auvik |

---

## 5. Plugin Ecosystem Considerations

If third-party MCP plugins are added (e.g., QuickBooks, Xero, Meraki), the access control model needs to scale gracefully.

### How Each Option Handles Plugin Growth

| Concern | Option A (Named) | Option B (Flags) | Option C (Custom) | Option D (Allowlisting) |
|---------|:-:|:-:|:-:|:-:|
| Adding a new vendor | Decide which role(s) get it | Add to permission matrix | Update role templates | Admin grants server access + tools per member |
| Vendor categories | Hardcoded in role definitions | N/A — permissions are orthogonal | Defined in role config | Implicit via UI grouping |
| 50+ vendors | Role definitions become bloated | Permission explosion | Manageable with good templates | Manageable with bulk operations + vendor groups |
| Third-party plugin security | Fixed trust model | Per-permission trust | Role-scoped trust | Per-tool trust (most granular) |

**Option D scales best** for a growing vendor catalog because the access control is at the most granular level (individual tools). Adding a new vendor plugin doesn't require any schema changes or role redefinitions — just a new vendor slug and its tool list.

### Template Presets (Enhancement for Option D)

To address the "no reusable templates" weakness, Option D could be enhanced with **non-authoritative presets** — saved configurations that admins can apply to new members:

```
Preset: "Finance Team"
  Server access: connectwise-psa, salesbuildr
  Tool allowlist:
    connectwise-psa: list_invoices, get_invoice, list_time_entries
    salesbuildr: list_proposals, get_proposal
```

This gives the UX benefit of named roles (one-click setup) without the schema complexity. Presets are purely a UI convenience — the underlying access model remains server access + tool allowlists.

---

## 6. Recommendation

**Option D (Tool Allowlisting is Sufficient)** is the recommended path.

### Reasoning

1. **Simplicity.** The project values simplicity above all. Options A–C add schema complexity, migration burden, and conceptual overhead that the current user base (small-to-mid MSPs, 3–15 team members) doesn't need.

2. **The MCP model favors tool-level control.** Unlike a REST API with distinct endpoints, MCP collapses everything to `tools/call`. The natural access control boundary is the tool itself, not an abstract role. Tool allowlisting maps directly to the protocol's execution model.

3. **Incremental cost is near-zero.** Server access control is already shipped. Tool allowlisting is already planned (Workstream 1). Option D requires no additional schema, no new tables, no migration. It's the "do nothing extra" option — and doing nothing extra is often the right call.

4. **Custom roles can be layered on later.** If the product grows to serve larger MSPs (50+ seats) where per-member configuration becomes genuinely painful, Option C (Custom Roles) can be added as a premium feature. The tool allowlisting foundation makes this a smooth upgrade path — custom roles would simply be saved bundles of server access + tool allowlists.

5. **Presets solve the UX gap.** The main weakness of Option D — no reusable templates — is solvable with a lightweight preset system that doesn't touch the authorization model. This could be a Phase 2 enhancement if customers request it.

### When to Reconsider

Revisit custom roles (Option C) if:

- Organizations regularly exceed 20 members
- Multiple members consistently need identical configurations (suggesting a shared "role" concept)
- Customer feedback explicitly requests named/custom roles
- A compliance requirement demands role-based audit trails (e.g., "show me everyone with the Finance role")

Until then, the pragmatic choice is to ship tool allowlisting, observe how customers use it, and let real usage patterns drive any future role model changes.
