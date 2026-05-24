/**
 * llms.txt — the GEO (generative-engine-optimization) convention (llmstxt.org):
 * a curated, machine-readable map that points AI crawlers at the docs' highest-
 * value pages. Served at the ROOT (`/llms.txt`), like robots.txt, and env-gated
 * by the SAME `computeDocsNoindex` discriminator: served ONLY on the indexed
 * prod surface, suppressed (404) on a noindex surface (advertising an AI-crawler
 * map to pre-launch docs contradicts the staging-noindex posture).
 *
 * `LLMS_TXT` is the CURATED docs-content artifact, authored by the docs-content
 * lane and committed + served BYTE-FOR-BYTE — not regenerated from slugs. The
 * curation (the citable one-liner, the provider-neutral framing, the per-link
 * editorial summaries) IS the value, so it is hand-maintained in the content
 * lane rather than derived from the sidebar: single-source-of-truth derivation
 * fits mechanical channels (the sitemap, auto-generated from the page tree),
 * not a curated map.
 *
 * Every link target below is verified to resolve to a built page before
 * shipping (advertised-resource-must-exist: the map must not point AI crawlers
 * at a 404). No `internal/` page appears — internal/ is excluded from this
 * discovery channel as from the page-serve, robots, and sitemap (Finding A).
 */
export const LLMS_TXT = `# Conduit

> Conduit is a white-label MCP gateway that connects any tool-calling AI assistant to the vendor MCP servers MSPs rely on — giving an MSP's customers secure, permissioned access to their business tools (RMM, PSA, documentation, security, and more) from the AI client they already use.

Conduit is the connection-and-access layer between AI assistants and MSP tools. It is **provider-neutral**: it speaks the standard Model Context Protocol (MCP) end to end, so any MCP-capable client — Claude Desktop, Claude Code, Cline, Continue, Cursor, and others — works without per-vendor lock-in. Conduit is **not** a workflow-automation or chaining tool; it gives an AI assistant the access and visibility it needs into a business, and the AI does the thinking. Each MSP customer gets one auditable, permissioned MCP endpoint, behind the MSP's own brand.

## Start here

- [Overview](https://conduit.wyre.ai/docs/): What Conduit is — the white-label MCP gateway for MSPs and their customers' AI assistants.
- [Getting Started](https://conduit.wyre.ai/docs/getting-started/): Stand up an MSP on Conduit — sign up, connect a vendor, connect an AI client, verify.
- [Connecting an AI client](https://conduit.wyre.ai/docs/guides/connecting-a-client/): How to connect Claude Desktop, Claude Code, or any MCP-capable client to a Conduit gateway.
- [Supported clients](https://conduit.wyre.ai/docs/reference/supported-clients/): Which AI clients work with Conduit — provider-neutral by protocol; any MCP-capable client connects.

## Guides

- [MSP onboarding](https://conduit.wyre.ai/docs/guides/msp-onboarding/): The end-to-end playbook for an MSP onboarding onto Conduit.
- [Onboarding a customer](https://conduit.wyre.ai/docs/guides/customer-provisioning/): How an MSP creates and manages a customer organization and its vendor integrations.
- [Vendor connections](https://conduit.wyre.ai/docs/guides/vendor-connections/): The 50+ vendor catalog and how credentials are scoped (personal / team / org / service client).
- [White-label setup](https://conduit.wyre.ai/docs/guides/white-label-setup/): How an MSP presents Conduit under its own brand.
- [Billing & plans](https://conduit.wyre.ai/docs/guides/billing/): Conduit's Free / Pro / Business plans and how subscription billing works.
- [Monitoring your tenant](https://conduit.wyre.ai/docs/guides/monitoring/): The usage dashboard, vendor health, and audit log — the three org-scoped monitoring surfaces.
- [SCIM provisioning](https://conduit.wyre.ai/docs/guides/scim/): Auto-provision users and teams from Entra ID, Okta, JumpCloud, or Google Workspace.

## Reference

- [Architecture](https://conduit.wyre.ai/docs/reference/architecture/): The Fastify/MCP reverse-proxy architecture; why the gateway is MCP-native and provider-neutral.
- [API](https://conduit.wyre.ai/docs/reference/api/): The full HTTP API — OAuth 2.1, org/team management, credentials, audit, billing, dashboard.
- [Security](https://conduit.wyre.ai/docs/reference/security/): Credential encryption, prompt-injection defense, multi-tenant isolation, and the honest trust model.
- [Subtenant model](https://conduit.wyre.ai/docs/reference/subtenants/): The reseller → customer → sub-customer hierarchy, transitive admin, and credential sharing.
- [Permissions](https://conduit.wyre.ai/docs/reference/permissions/): The org-member role model (owner / admin / member) and the reseller-scope roles.
- [CLI wrapper](https://conduit.wyre.ai/docs/reference/cli/): The REST endpoint for calling vendor tools from scripts and automation without full MCP.
- [Prompt capture & privacy](https://conduit.wyre.ai/docs/reference/prompt-capture/): What the audit log records by default, and what the opt-in prompt-capture feature adds.
- [Vendor health](https://conduit.wyre.ai/docs/reference/vendor-health/): How Conduit reports the live health of each connected vendor.

## On-prem gateway

- [On-prem quickstart](https://conduit.wyre.ai/docs/guides/onprem/quickstart/): Deploy the on-prem gateway in three steps — credentials stay on the customer's network, no inbound ports. When to use it: the self-hosted wiring pattern in the customer-onboarding flow.
- [On-prem architecture](https://conduit.wyre.ai/docs/guides/onprem/architecture/): Security model and data-flow for a compliance / procurement review of the on-prem gateway.
- [On-prem reference](https://conduit.wyre.ai/docs/guides/onprem/reference/): Full env-var contract and operational reference for the on-prem gateway.
- [On-prem troubleshooting](https://conduit.wyre.ai/docs/guides/onprem/troubleshooting/): Failure modes and fixes, keyed by the verbatim error message.

## Optional

- [Agents](https://conduit.wyre.ai/docs/reference/agents-concepts/): Pre-built agent configurations that encode specific MSP workflows.
`;
