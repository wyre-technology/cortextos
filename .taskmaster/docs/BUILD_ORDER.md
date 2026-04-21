# Conduit Build Order (Cross-Tag Dependency Graph)

Taskmaster only supports within-tag dependencies. This doc captures the cross-tag
blocking relationships you need to respect when running `task-master next`
across multiple tags.

Last updated: 2026-04-20

## Dependency graph

```
                      ┌──────────────┐
                      │ platform-ops │  (foundation: CI, upstream sync, infra)
                      └──────┬───────┘
                             │
         ┌───────────────────┼────────────────────┐
         ▼                   ▼                    ▼
  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
  │ reseller-   │    │ billing-     │    │ docs             │
  │ tenancy     │    │ wholesale    │    │ (independent)    │
  └──────┬──────┘    │ (needs sync  │    └──────────────────┘
         │           │  of feat/    │
         │           │  billing)    │
         │           └──────┬───────┘
         │                  │
   ┌─────┴──────┬───────────┼───────────┐
   ▼            ▼           ▼           ▼
┌──────────┐ ┌───────────┐ ┌─────────┐ ┌──────────────┐
│ msp-     │ │ white-    │ │ onboard-│ │ pricing-     │
│ admin    │ │ label     │ │ ing     │ │ decision     │
└──────────┘ └───────────┘ └─────────┘ └──────────────┘
```

## First-wave work (no cross-tag blockers)

- **platform-ops #1–3**: upstream remote + sync action + release config
- **reseller-tenancy #1–3**: migrations for org hierarchy, reseller members, RLS scaffold
- **docs #1**: pick doc framework (can start immediately)
- **pricing-decision #1**: file upstream issue for credit discrepancy (independent)

## Second-wave work (after reseller-tenancy migrations land)

- **msp-admin #1–3**: reseller routes, service CRUD (needs org type + parent_org_id)
- **white-label #1**: brand_profiles schema (needs reseller org type for inheritance)
- **onboarding #1–2**: onboarding_progress + customer sub-org schema

## Second-wave work (after billing-wholesale sync lands)

- **billing-wholesale #3+**: hierarchical org model, usage rollup, dunning
- **onboarding #3**: rebase fix/hash-invitation-tokens from upstream

## Third-wave work (after pricing-decision locks + billing-wholesale engine exists)

- **billing-wholesale #11**: reseller aggregate caps (needs discount schedule)
- **msp-admin** billing/usage views (needs discount-aware pricing)
- **docs** pricing page (needs locked schedule)

## Notes

- `pricing-decision` is a decision track that proceeds in parallel but blocks
  implementation in `billing-wholesale` at the discount-encoding step.
- `platform-ops` upstream-sync tooling is prerequisite for pulling upstream
  work (`feat/billing`, `feat/credit-ledger`, `fix/hash-invitation-tokens`).
- First tasks in downstream tags are annotated inline with `[CROSS-TAG BLOCKER]`
  markers in their `details` field so `task-master next --tag X` surfaces the
  dependency when you switch context.
