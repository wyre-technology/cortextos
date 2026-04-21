# Conduit — Documentation PRD

**Tag:** `docs`
**Owner:** Wyre Product / DevRel
**Status:** Draft v0.1
**Last updated:** 2026-04-18
**Target repo path:** `/Users/asachs/work/wyre/engineering/projects/gateway/conduit`

---

## 1. Context and problem statement

Conduit is the white-label MSP channel / reseller product forked from Wyre's
`mcp-gateway`. It gives MSPs (Managed Service Providers) a branded gateway
their customers use to connect AI agents to the ~30 vendor MCP servers
(ConnectWise, Autotask, Mosyle, SentinelOne, M365, IT Glue, etc.) that MSPs
already rely on. Conduit is pre-launch; before MSPs can evaluate, sign up,
provision customers, or refer business, we need a coherent written story —
not the partial engineering docs that exist today.

The documentation inherited from `mcp-gateway` is developer-oriented and
Wyre-branded. It does not cover:

- MSP-as-reseller sales narrative (pricing, margin, why-Conduit).
- Onboarding flow for an MSP signing up and connecting its first customer.
- White-label setup (custom domain, branding, logo, palette) — only
  partially documented in `conduit/docs/white-label.md`.
- Billing, support playbook, SLA commitments.
- A rendered, versioned, searchable docs site (today there is only a stub
  — see `mcp-gateway/docs/package.json`: builds `dist/index.html` echoing
  `<html><body>docs</body></html>`).
- MSP-facing API reference generated from OpenAPI.

The current inventory:

```
conduit/docs/
  api-reference.md            (13 KB, dev-oriented)
  architecture.md             (9 KB)
  cli-wrapper.md              (7 KB)
  deployment.md               (9 KB)
  onboarding-guide.md         (7 KB, MSP admin-oriented but thin)
  prompt-capture.md           (5 KB)
  vendor-integration.md       (10 KB, how to add a vendor — dev)
  white-label.md              (5 KB, partial)
  itglue/                     (5 HTML runbooks: customer-onboarding,
                               incident-response, maintenance,
                               monitoring-alerting, operational-infrastructure)

conduit/design-docs/
  custom-roles-exploration.md (16 KB)
  token-reduction-stats.md    (6 KB)

conduit/CHANGELOG.md          (Keep-a-Changelog, Unreleased section only)
```

And in the upstream:

```
mcp-gateway/docs/
  agents.md          (55 KB — richest single doc)
  getting-started.md (7 KB)
  plugins.md         (21 KB)
  security.md        (10 KB)
  teams-and-orgs.md  (8 KB)
  feature-requests/per-org-email-branding.md
  package.json       (stub build)
```

Together these are the substrate. They are adequate reference material for
engineers already inside Wyre; they are not a product story.

This PRD defines the v1 documentation set Conduit needs to launch: what
documents exist, who reads each one, how they are produced, where they
inherit from `mcp-gateway` and where they are net-new, what tooling renders
them, and how they stay in sync.

---

## 2. Goals

1. Every audience listed in Section 3 has a first-draft, linked document
   that answers their primary question without bouncing them to Wyre Slack.
2. Docs render as a deployed, searchable, versioned site at a Conduit-owned
   URL (e.g. `docs.conduit.example`), not as raw GitHub markdown.
3. Inherited-from-mcp-gateway docs are forked, rebranded, and flagged with
   a machine-readable `upstream:` front-matter field so a sync bot can
   diff against the source.
4. Terminology is locked in a style guide before first external review.
5. Release notes and changelog are published for every tagged release,
   auto-generated from commits where possible, curated where needed.
6. MSP partners (once signed) can self-serve from documentation for 80% of
   their setup tasks without a Wyre support ticket.

## 3. Audiences

| # | Audience | Primary question | Entry doc |
|---|---|---|---|
| A1 | Prospective MSP (evaluator, sales) | "What is Conduit, what does it cost, why should my MSP resell it?" | Marketing landing + pricing page |
| A2 | Signed MSP admin (non-technical) | "How do I onboard my first customer, bill them, and support them?" | Getting started (MSP) |
| A3 | MSP technical team (engineer, integrator) | "How do I connect vendor X for customer Y via API?" | API reference + vendor guides |
| A4 | MSP's end customer (indirect) | "Why am I approving this OAuth consent? How do I revoke?" | White-label templates the MSP ships |
| A5 | Internal Wyre team (support, ops, release) | "The ConnectWise probe is flapping for MSP Foo — runbook?" | Internal runbooks + SLA |

The four external audiences (A1–A4) read rendered public docs. A5 reads
an internal-only section protected by Wyre SSO.

---

## 4. Document inventory (v1)

Each entry below gives a doc ID, owner audience, source-of-truth path,
inheritance status, and a one-line scope. IDs are referenced from the
Proposed task list at the end of this PRD.

### 4.1 Marketing / top-of-funnel

- **D01 — Landing page copy** (A1). New. `marketing/landing.md`.
  Hero, three-value-prop block, social proof placeholder, CTA to pricing.
- **D02 — Features page copy** (A1). New. `marketing/features.md`.
  Vendor matrix (~30), multi-tenant orgs, audit, SSO, white-label.
- **D03 — Pricing page** (A1). New. `marketing/pricing.md`. **Blocks on
  pricing-decision PRD.** Placeholder table until that lands.
- **D04 — FAQ (prospect)** (A1). New. `marketing/faq.md`. Reseller
  economics, data residency, vendor support timelines.
- **D05 — Pitch deck skeleton** (A1). New. `marketing/pitch-deck.md`
  (source for slide export). Out of scope for v1 if time-constrained.

### 4.2 Getting started and onboarding

- **D06 — MSP getting-started guide** (A2). Adapted from
  `mcp-gateway/docs/getting-started.md` + `conduit/docs/onboarding-guide.md`.
  Covers: sign up, first login, create org, connect first vendor, invite
  first customer. Replaces both source docs on merge.
- **D07 — Customer provisioning guide** (A2). Net-new. How an MSP admin
  creates a tenant/customer, invites users, assigns vendor connections,
  revokes access.
- **D08 — Billing guide (MSP)** (A2). Net-new. Depends on billing PRD.
  How invoices work, how to download, how usage maps to plan, how to
  change plan mid-cycle. Placeholder section until billing PRD resolves.
- **D09 — Support playbook (MSP)** (A2). Net-new. SLA expectations, how
  to open a ticket, what Wyre handles vs. what MSP handles for end
  customers, status-page URL.

### 4.3 Technical reference

- **D10 — API reference (rendered)** (A3). Generate from OpenAPI; seed
  from `conduit/docs/api-reference.md`. Rendered via docs-site framework
  (see Section 5). Every non-health endpoint documented with auth
  requirements explicit.
- **D11 — Architecture overview** (A3). Forked from
  `conduit/docs/architecture.md`. Add MSP / customer boundary diagram.
- **D12 — Integration architecture diagram** (A3). Net-new mermaid
  diagram showing MSP → Conduit → vendors → end-customer agents.
- **D13 — Vendor connection guides** (A3). One doc per vendor (~30),
  forked from whatever exists upstream plus `conduit/containers/*-mcp`
  (currently `m365-mcp`, `sentinelone-mcp`). Rebranded, with per-vendor
  credential screenshots, scopes, and troubleshooting. Template lives at
  `docs-site/templates/vendor-guide.md`.
- **D14 — CLI wrapper guide** (A3). Forked from
  `conduit/docs/cli-wrapper.md`. Thin edit.
- **D15 — Deployment guide (self-host option)** (A3, A5). Forked from
  `conduit/docs/deployment.md`. Flag whether self-host is an offered tier
  in v1 — if not, move to internal.
- **D16 — Plugins reference** (A3). Forked from
  `mcp-gateway/docs/plugins.md`. Scope: if plugins are an MSP-visible
  concept in Conduit v1, keep public; otherwise mark internal.
- **D17 — Agents reference** (A3). Forked from
  `mcp-gateway/docs/agents.md` (55 KB, heaviest inherited doc).
  Needs a split into "concept" (public) + "internal implementation"
  (internal) during the fork.

### 4.4 White-label and branding

- **D18 — White-label setup guide** (A2). Rewrite of
  `conduit/docs/white-label.md` + cross-ref to
  `conduit/CHANGELOG.md` entries about the brand registry
  (`src/brand/customers.ts`). Covers custom domain, logo, color palette,
  font (Google Fonts integration), login provider switcher
  (Auth0 vs. Azure AD per `CHANGELOG.md`).
- **D19 — White-label doc templates** (A2 → A4). Net-new. Markdown
  templates an MSP can fork into its own docs site to give its
  end-customers consent / onboarding / revocation instructions branded
  as the MSP, not Conduit.

### 4.5 Security, compliance, trust

- **D20 — Security overview** (A1, A2). Adapted from
  `mcp-gateway/docs/security.md`. Add MSP-facing language: data
  residency, per-customer isolation, audit retention, incident response.
- **D21 — Compliance statement / SOC2-intent page** (A1). Net-new
  placeholder. Explicit on what we do / do not claim. Legal review gate.
- **D22 — Teams & orgs reference** (A2, A3). Forked from
  `mcp-gateway/docs/teams-and-orgs.md`. Map `mcp-gateway` "org" concept
  onto Conduit's MSP/customer hierarchy; terminology reconciliation
  handled by style guide (D27).

### 4.6 Operations

- **D23 — Troubleshooting / FAQ (technical)** (A3). Net-new plus
  material lifted from `conduit/docs/itglue/incident-response.html` and
  peers. Convert HTML runbooks to markdown.
- **D24 — Release notes** (A1, A2, A3). Curated human-readable per
  release, generated from tags. Hosted at `/releases`.
- **D25 — Changelog (Keep a Changelog)** (all). Continue
  `conduit/CHANGELOG.md`. Publish rendered version on docs site.
- **D26 — Internal runbook + SLA** (A5). Fork the five HTML files under
  `conduit/docs/itglue/` (customer-onboarding, incident-response,
  maintenance, monitoring-alerting, operational-infrastructure) to
  markdown, add SLA targets (P1 < 1h response, etc. — values TBD in
  ops PRD), move to `docs-site/internal/`.

### 4.7 Cross-cutting

- **D27 — Style guide and terminology lexicon** (writer-facing). Net-new.
  Locks voice, tone, and the terminology table in Section 6.
- **D28 — Contributor guide (docs)** (writer-facing). Net-new. How to
  add a page, preview locally, run the link checker, submit a docs PR.

Total: 28 documents, of which 11 are net-new, 13 are forks with rebrand,
and 4 are net-new but blocked on upstream PRD decisions (pricing,
billing, self-host tier, compliance).

---

## 5. Doc tooling

### 5.1 Site framework — decision required

Today `mcp-gateway/docs/package.json` is a stub. Conduit needs a real
framework. Candidates:

| Framework | Pros | Cons |
|---|---|---|
| **Docusaurus** (React) | Mature, versioning built-in, MDX, large plugin ecosystem, Algolia DocSearch ready | Heavier build, React surface area |
| **Nextra** (Next.js) | Fast, Tailwind-friendly, matches likely marketing-site stack, MDX | Versioning less battle-tested |
| **Starlight** (Astro) | Lightest, best Lighthouse scores, good DX, we already use Astro elsewhere per `astro-starlight-theme-dark-light` skill | Smaller plugin ecosystem |
| **MkDocs-Material** | Python, dead-simple, great search | Weaker for React components / marketing copy mix |

**Recommendation:** Starlight (Astro) for the docs site, separate from
the marketing site. Rationale: minimum surface area, aligns with
existing Wyre Astro usage, first-class search. Marketing site can be a
separate Astro or Next surface that links into it.

**Open question OQ1:** does marketing live in the same repo / same
deploy as docs, or a separate one? Decision gates D01–D05.

### 5.2 API reference generation

- Source of truth: OpenAPI spec emitted by the Conduit API (path TBD —
  likely `/openapi.json` served by the API itself).
- Render with `@stoplight/elements` or `redocly` embedded into the docs
  site. Regenerate on every API release.
- Requirement: doc build fails if OpenAPI spec is missing endpoints
  defined in `src/` routes (link-checker task).

### 5.3 Search

- Algolia DocSearch (free for OSS-style docs) OR Starlight's built-in
  Pagefind. Pagefind is simpler and self-hosted; default to Pagefind,
  upgrade to Algolia if search traffic justifies.

### 5.4 Versioning

- Versioned docs per product minor release (e.g. `/v0.1/`, `/v0.2/`).
- Unreleased / `next` lives at `/next/`.
- Old versions archived after N+2 (keep current + two prior).

### 5.5 Preview deploys

- Every docs PR gets a preview URL (Netlify / Cloudflare Pages /
  Vercel — align with existing Wyre hosting).
- Link-check runs in CI on every PR.
- Spellcheck (vale or cspell) runs on every PR; vocabulary file owned
  by docs team.

### 5.6 Diagrams

- Text-first: **Mermaid** for architecture, sequence, entity diagrams.
  Embeddable in MDX and versionable as text.
- Complex / marketing visuals: **Excalidraw** exported to SVG, source
  `.excalidraw` committed alongside.
- No Figma-only diagrams in product docs — they drift.

---

## 6. Terminology lock (style-guide preview)

Locking these terms now prevents thrash later. The style guide (D27) is
the canonical copy; this section is its seed.

| Concept | Canonical term | Rejected alternatives | Notes |
|---|---|---|---|
| The company reselling Conduit | **MSP** (Managed Service Provider) | reseller, partner, channel | "Partner" is reserved for Wyre go-to-market partners (non-reselling). |
| The MSP's business | **MSP organization** or "MSP org" | tenant, account | "Tenant" reserved for multi-tenancy internals. |
| The MSP's end customer | **customer** | client, end-user, tenant | Use "customer" in product UI and docs. |
| An authenticated individual | **user** | member, principal | "Member" allowed only when scoped to a team. |
| Group within a customer org | **team** | group, project | Matches `mcp-gateway/docs/teams-and-orgs.md`. |
| Vendor MCP integration | **vendor integration** | connector, plugin, adapter | "Plugin" is reserved for `mcp-gateway/docs/plugins.md` concept. |
| Credential a customer provides | **connection** | credential, integration, link | Matches templates in `src/web/templates/team-connections.ts`. |
| Wyre-hosted product | **Conduit** | the gateway, Wyre gateway | "Gateway" allowed only when describing the MCP protocol layer generically. |
| The upstream open product | **mcp-gateway** | upstream, core | Lowercase, hyphenated, matches repo name. |

Voice: second person ("you"), active, concrete. No "simply", no
"just", no "easy". Length over cleverness.

---

## 7. Content inheritance from mcp-gateway

### 7.1 Fork vs. link vs. rewrite

For each inherited doc we pick one of three strategies:

- **Fork-and-rebrand:** copy, remove Wyre-specific wording, add Conduit
  front-matter with `upstream: mcp-gateway/docs/<file>.md` and
  `upstream_sha: <git sha at fork time>`.
- **Link-through:** keep a one-line stub that links to the upstream
  doc (acceptable for deep internals not surfaced to MSPs).
- **Rewrite:** discard upstream entirely; audience mismatch too large.

Initial decisions:

| Upstream doc | Strategy | Target Conduit doc |
|---|---|---|
| `mcp-gateway/docs/getting-started.md` | Rewrite | D06 |
| `mcp-gateway/docs/agents.md` (55 KB) | Fork-and-split (public concepts vs. internal implementation) | D17 |
| `mcp-gateway/docs/plugins.md` | Fork | D16 |
| `mcp-gateway/docs/security.md` | Fork + expand for MSP audience | D20 |
| `mcp-gateway/docs/teams-and-orgs.md` | Fork + terminology pass | D22 |
| `mcp-gateway/docs/feature-requests/per-org-email-branding.md` | Link-through (internal) | n/a |
| `conduit/docs/architecture.md` | Fork (already in conduit) | D11 |
| `conduit/docs/api-reference.md` | Replace with OpenAPI-rendered | D10 |
| `conduit/docs/cli-wrapper.md` | Fork | D14 |
| `conduit/docs/deployment.md` | Fork (decide internal vs. public) | D15 |
| `conduit/docs/onboarding-guide.md` | Merge into D06 | D06 |
| `conduit/docs/prompt-capture.md` | Keep, internal-only | n/a |
| `conduit/docs/vendor-integration.md` | Split: dev-onboarding (internal) + vendor-guide template (public) | D13 + internal |
| `conduit/docs/white-label.md` | Rewrite | D18 |
| `conduit/docs/itglue/*.html` | Fork to markdown | D26 |

### 7.2 Sync process

- Weekly bot job (`scripts/docs-upstream-diff.ts`) iterates every
  forked doc, fetches `upstream` path at HEAD, diffs against
  `upstream_sha`, opens a GitHub issue tagged `docs-sync` if the
  upstream has changed meaningfully.
- Humans decide per-issue whether to pull changes.
- `upstream_sha` is bumped only when a human reconciles.

---

## 8. White-label documentation

Two questions surface here.

### 8.1 Can an MSP host its own customer-facing docs?

Yes — v1 ships a template pack (D19) the MSP forks into its own repo
and hosts on its own domain. Conduit does not render per-MSP docs on
our infrastructure in v1. (See OQ3.)

### 8.2 What templates do we ship?

Minimum pack:

- Customer onboarding (how to accept an MSP invitation).
- OAuth consent explainer (what each vendor connection grants).
- Credential revocation / offboarding.
- Security and privacy one-pager (rebrandable).

Each template has tokenized brand fields
(`{{msp.name}}`, `{{msp.logoUrl}}`, `{{msp.supportEmail}}`) that map to
the brand registry in `src/brand/customers.ts`.

---

## 9. Non-goals / out of scope (v1)

- Video content (screencasts, tutorials).
- Webinars or live events.
- Conference collateral, printed material.
- Auto-translation / localization (English only in v1).
- Per-MSP hosted docs rendered on Wyre infrastructure (templates only).
- Interactive sandbox / playground for the API (v2).
- AI-powered chat-with-docs widget (v2).
- Community / forum platform (v2 — use Discord / GitHub Discussions).

---

## 10. Acceptance criteria

Numbered and testable. V1 ships only when all are met.

1. Docs site builds and deploys to `docs.<conduit-domain>` on every
   push to `main`, and to a preview URL on every PR.
2. Marketing site builds and deploys similarly (may be same framework
   per OQ1).
3. All 28 documents in Section 4 are linked from the site's top-level
   navigation (none orphaned).
4. Every public endpoint in the Conduit OpenAPI spec appears in D10
   (API reference). CI fails if an endpoint is missing.
5. Every non-health, non-monitoring endpoint in D10 documents its
   authentication requirement explicitly.
6. Every vendor integration present in `conduit/containers/` and in
   the vendor registry has a D13 vendor guide (even if skeletal).
7. `CHANGELOG.md` follows Keep a Changelog 1.1.0 and is rendered at
   `/changelog` on the docs site.
8. Style guide (D27) is signed off by Wyre product + DevRel before any
   doc leaves draft.
9. Terminology lexicon (Section 6) is enforced by a `vale`-style
   linter in CI for the 10 locked terms.
10. Every forked doc has `upstream:` and `upstream_sha:` front-matter.
11. Link-checker passes in CI with zero broken internal links.
12. Pagefind (or chosen search) indexes all published pages.
13. A docs-only contributor can add a page end-to-end using only D28
    (contributor guide) without asking for help.
14. Internal docs (D26 and peers) are gated behind Wyre SSO.
15. Preview deploys are accessible to anyone with a PR link (public
    preview) so external reviewers can comment.

---

## 11. Open questions

- **OQ1.** Marketing site co-located with docs or separate? Affects
  D01–D05 framework choice.
- **OQ2.** Do we render docs versions per product release, or trunk-only
  with a changelog? Versioning adds overhead; trunk-only acceptable at
  v1 scale but painful later.
- **OQ3.** Will we later offer MSP-branded docs hosted on our
  infrastructure (per-MSP subdomain under `docs.<msp-domain>`), or keep
  the "MSP hosts their own" model indefinitely? Architecture cost
  nontrivial.
- **OQ4.** Is self-host a supported tier in v1? If no, D15 moves
  internal.
- **OQ5.** Search: Pagefind (self-hosted, simpler) or Algolia DocSearch
  (external, analytics-rich)?
- **OQ6.** API reference rendering: `@stoplight/elements` vs. Redocly
  vs. Scalar.
- **OQ7.** Who owns docs on an ongoing basis? DevRel role? Engineering
  rotation? Dedicated tech writer?
- **OQ8.** Can the sync bot (Section 7.2) run against a private
  `mcp-gateway` repo or does it need Wyre-internal GitHub App auth?
- **OQ9.** Legal review timeline for D21 (compliance statement) — gate
  on when we can credibly claim SOC2-in-progress.
- **OQ10.** Analytics: GA4, Plausible, Fathom, none?
- **OQ11.** Can MSPs suggest doc edits via GitHub, or do we need a
  non-GitHub feedback path (e.g. "Suggest edit" button → form)?

---

## 12. Dependencies on other PRDs

- **pricing-decision** → blocks D03, D04, parts of D08.
- **billing** → blocks D08.
- **onboarding** → D06, D07 canonicalize flows defined there.
- **security / compliance** → D20, D21.
- **api / openapi** → D10 depends on a stable published OpenAPI spec.
- **white-label / brand** (already partially landed in
  `CHANGELOG.md` Unreleased) → D18, D19.

---

## 13. Proposed task list

Each bullet is a task; each typically corresponds to one doc or doc
group. Bracketed IDs reference Section 4.

1. **Choose docs-site framework and stand up the shell.** Decide
   Starlight vs. Docusaurus vs. Nextra (OQ1, Section 5.1). Produce
   `docs-site/` at repo root with build, local preview, deploy to
   preview URL. Retire the stub `mcp-gateway/docs/package.json`
   pattern. Acceptance: PR preview URL live.
2. **Author style guide and terminology lexicon [D27].** Lock terms in
   Section 6, add `vale` config, wire into CI. Acceptance: AC-9.
3. **Author docs contributor guide [D28].** End-to-end walkthrough;
   verified by a non-docs engineer adding a test page.
4. **Migrate and rebrand getting-started [D06].** Merge
   `mcp-gateway/docs/getting-started.md` + `conduit/docs/onboarding-guide.md`.
   Add MSP-specific sign-up, first vendor, first customer steps.
5. **Write customer provisioning guide [D07].** Net-new. Covers
   tenant/customer creation, invite, connection assignment, revocation.
6. **Author white-label setup guide and templates [D18, D19].**
   Rewrite `conduit/docs/white-label.md`, cross-reference
   `src/brand/customers.ts` and the `CHANGELOG.md` Unreleased entries;
   ship the MSP-customer-facing template pack.
7. **Fork and split agents reference [D17].** `mcp-gateway/docs/agents.md`
   (55 KB) into public concept doc + internal implementation doc.
   Largest single editorial job.
8. **Fork plugins, teams-and-orgs, security [D16, D22, D20].** Fork
   each with upstream front-matter; apply terminology pass; add
   MSP-audience framing to security.
9. **Build OpenAPI-driven API reference [D10].** Wire docs site to
   `/openapi.json`; add CI check that every route in `src/` appears in
   the spec; enforce auth-requirement-per-endpoint per global policy.
10. **Author architecture overview and diagrams [D11, D12].** Fork
    `conduit/docs/architecture.md`, add mermaid diagram for MSP /
    customer / vendor / agent boundary.
11. **Author vendor connection guides [D13].** Template +
    one-per-vendor (~30 total). v1 must cover the containers present
    today (`m365-mcp`, `sentinelone-mcp`) with real screenshots; the
    remaining ~28 can be template-only skeletons flagged "draft" if
    time-constrained.
12. **Port IT Glue runbooks to markdown and gate internal [D26].**
    Convert the 5 HTML files under `conduit/docs/itglue/` to markdown,
    add SLA targets (placeholder values, resolve via ops PRD), publish
    under internal-only section.
13. **Author marketing copy: landing, features, FAQ [D01, D02, D04].**
    Depends on voice from D27. Pricing (D03) remains placeholder
    until pricing PRD lands.
14. **Author support playbook and SLA-facing copy [D09].** What Wyre
    does, what MSP does, status page URL, ticket process.
15. **Wire up changelog and release notes pipeline [D24, D25].**
    Render `CHANGELOG.md` at `/changelog`; curate per-release notes
    from git tags; publish at `/releases`.
16. **Build upstream-sync bot [Section 7.2].** Cron job + GitHub
    action that diffs every forked doc against its upstream SHA and
    opens `docs-sync` issues. Depends on OQ8.
17. **Stand up search, analytics, link-checker, spellcheck in CI.**
    Pagefind (or Algolia) + chosen analytics + `lychee`/`linkinator`
    + `vale`/`cspell`. Acceptance: AC-11, AC-12.
18. **v1 publish gate: review every acceptance criterion (Section 10),
    sign-off from Product + DevRel, flip DNS.** Single final task
    owning AC-1 through AC-15.

---

*End of PRD.*
