# RLS request-path role — provisioning & verification

Conduit enforces PostgreSQL Row-Level Security on the HTTP request path by
opening two database connection classes (see `src/db/context.ts`):

| Class        | Role               | BYPASSRLS | Used for                                   |
|--------------|--------------------|-----------|--------------------------------------------|
| system-path  | the existing role  | yes       | migrations, boot DDL, the Stripe webhook   |
| request-path | `conduit_request`  | **no**    | every authenticated HTTP request           |

RLS policies (migrations 007+) only filter rows for a connection that is both
a **non-owner** and **NOBYPASSRLS**. If the request pool connects as a
BYPASSRLS role, every policy is a silent no-op — which was the pre-this-change
production posture. The `conduit_request` role is what makes RLS real.

## 1. Create the role (infra / one-time, per environment)

`CREATE ROLE` needs superuser and a login password — it is **not** in a
committed migration. Run it once per database, as a superuser:

```sql
CREATE ROLE conduit_request LOGIN PASSWORD '<from Key Vault>' NOBYPASSRLS;
```

- **`NOBYPASSRLS` is load-bearing.** A role created BYPASSRLS (or as superuser)
  makes RLS a no-op. Migration `029_rls_request_role.sql` has an audit that
  **fails the boot** if `conduit_request` exists with BYPASSRLS — so a wrong
  role here surfaces loudly rather than silently disabling tenant isolation.
- The role needs no other attributes — not `CREATEDB`, not `SUPERUSER`.
- Store the password in the same Key Vault as the system `DATABASE_URL`, under
  a distinct secret name. Never paste it into a CI log or commit.

## 2. Ordering — create the role BEFORE the migration-029 image boots

Migration `029_rls_request_role.sql` GRANTs table/sequence/function privileges
to `conduit_request`. Migrations apply **once** (idempotent by filename), so
the GRANT branch is a one-shot: if the role does not exist when migration 029
first applies, the migration is a NOTICE-only no-op and the grants never
happen.

Therefore: **create the `conduit_request` role before deploying the image that
carries migration 029.** (Future tables are covered automatically — migration
029 also sets `ALTER DEFAULT PRIVILEGES` so objects created by later
migrations auto-grant to `conduit_request`.)

If the role is somehow created late, re-run the grant block manually:

```sql
GRANT USAGE ON SCHEMA public TO conduit_request;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES  IN SCHEMA public TO conduit_request;
GRANT USAGE, SELECT                ON ALL SEQUENCES IN SCHEMA public TO conduit_request;
GRANT EXECUTE                      ON ALL FUNCTIONS IN SCHEMA public TO conduit_request;
```

## 3. Set `DATABASE_URL_REQUEST` on the gateway

The gateway reads two connection URLs (`src/config.ts`):

- `DATABASE_URL` — the system-path role (unchanged).
- `DATABASE_URL_REQUEST` — the `conduit_request` role.

```
DATABASE_URL_REQUEST=postgres://conduit_request:<password>@<host>:5432/<db>
```

If `DATABASE_URL_REQUEST` is unset it falls back to `DATABASE_URL` — which
leaves RLS a no-op (the legacy posture). **Production must set it** to a URL
that authenticates as `conduit_request`.

## 4. Post-deploy verification

After the deploy, confirm RLS actually enforces. Connect **as
`conduit_request`** (not the system role) and check that a tenant-scoped table
returns nothing without a user context, and only the right rows with one:

```sql
-- As conduit_request:
SELECT count(*) FROM organizations;                       -- expect 0
SELECT set_config('conduit.current_user_id', '<a real user id>', false);
SELECT count(*) FROM organizations;                       -- expect only that user's orgs
```

If the first count is non-zero, RLS is NOT enforcing — the role likely has
BYPASSRLS, or `DATABASE_URL_REQUEST` is still pointing at the system role.
Stop and fix before trusting the deploy.

A green migration-029 boot (no `mig 029 audit` exception in the logs) confirms
the role exists and is NOBYPASSRLS; the manual check above confirms the
policies themselves filter as intended.
