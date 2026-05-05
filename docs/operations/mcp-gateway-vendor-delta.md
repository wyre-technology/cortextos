# mcp-gateway → Conduit parity delta (Phase 0 audit)

Source of truth at audit time:
- Conduit: `src/credentials/vendor-config.ts` on `feat/mcp-gateway-consolidation`
- mcp-gateway: `src/credentials/vendor-config.ts` on local clone at
  `/Users/asachs/work/wyre/engineering/projects/gateway/mcp-gateway` (main)

Counts:
- mcp-gateway: 44 vendor slugs
- Conduit: 33 vendor slugs
- Common: 30 slugs

## 1. Vendor delta

### Port to Conduit (13 vendors)

These have no Conduit equivalent and need full vendor-config + docker-compose entries:

| Slug | Category | Notes |
|---|---|---|
| `blackpoint` | security | BlackPoint Cyber MDR |
| `cipp` | productivity | M365 management (community) |
| `crewhu` | sales | CSAT / employee recognition |
| `datto-bcdr` | rmm | Datto SIRIS / Alto BCDR |
| `datto-saas-protection` | productivity | Datto SaaS backup |
| `halopsa-official` | psa | Vendor-published HaloPSA MCP (distinct from community `halopsa`) |
| `immybot` | rmm | ImmyBot automation |
| `kaseya-bms` | psa | Kaseya BMS |
| `kaseya-vsa` | rmm | Kaseya VSA |
| `spanning` | productivity | Spanning Cloud Apps backup |
| `threatlocker` | security | ThreatLocker Zero Trust |
| `timezest` | sales | Scheduling |
| `unitrends` | rmm | Unitrends backup |

### Slug rename — alias only, do NOT port as new vendor

| mcp-gateway slug | Conduit slug | Resolution |
|---|---|---|
| `connectwise-manage` | `connectwise-psa` | Same product (CW renamed Manage → PSA). Migration script must remap `vendor='connectwise-manage'` → `vendor='connectwise-psa'` on `org_credentials`, `org_team_credentials`, `service_client_credentials`. |

### Conduit-only (do not touch)

- `hubspot`, `xero` — Conduit added independently; mcp-gateway never had them
- `connectwise-psa` — see rename above

## 2. Schema delta

mcp-gateway has these tables that Conduit lacks:

| Table | Source file in mcp-gateway | Notes |
|---|---|---|
| `subscriptions` | `migrations/0001_subscriptions.sql` | Stripe subscription mirror — mcp-gateway has it as a dedicated migration; everything else is inline `CREATE TABLE IF NOT EXISTS` |
| `deleted_orgs` | `src/org/org-service.ts` | Soft-delete forensics |
| `vendor_oauth_flow_states` | `src/oauth/vendor-state-store.ts` | PKCE state for vendor OAuth flows (Xero/QBO/M365/HubSpot) |
| `entity_mappings` | `src/proxy/entity-map-service.ts` | Per-org entity ID translation |
| `credit_ledger` | `src/billing/credit-service.ts` | Credit transactions (append-only) |
| `credit_blocks` | `src/billing/credit-service.ts` | Pre-purchased credit grants |

### `organizations` columns absent from Conduit

| Column | Source |
|---|---|
| `seat_billing_grandfathered_until TIMESTAMPTZ` | `src/org/org-service.ts` |

Already in Conduit (do not re-add): `trial_ends_at` (mig 009), `stripe_customer_id`, `stripe_subscription_id` (mig 002 + service init).

### Plan note

Original plan specified a single `credits` table. Upstream actually uses **two**:
`credit_ledger` (transactions) + `credit_blocks` (purchase grants). Migration 017
should follow upstream's two-table shape for compatibility with the ported
`credit-service.ts`.

## 3. Stripe seat-count sync

**Neither** repo has metered/seat-count handling on `customer.subscription.updated`.
Both stop at price-id → plan-tier mapping. Phase 3 step 4 ("port seat sync if
applicable") is therefore **dropped** from the build.

## 4. Phase ordering follow-ups

- Phase 1 migration grows by `entity_mappings`, `subscriptions`, `credit_ledger`,
  `credit_blocks`, and `organizations.seat_billing_grandfathered_until`
- Phase 2 ports 13 vendors (not "~15") and adds the CW slug-alias rule
- Phase 3 drops the seat-sync work item; everything else holds
- Phase 4 migration script must:
  - alias `connectwise-manage` credentials → `connectwise-psa`
  - copy `subscriptions`, `entity_mappings`, `credit_ledger`, `credit_blocks` rows
