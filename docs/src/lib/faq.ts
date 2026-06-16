/**
 * FAQPage structured data (schema.org) for the docs FAQ sections.
 *
 * FAQPage is a MECHANICAL channel: the JSON-LD MUST match the visible rendered
 * Q/A (Google penalizes — and rejects rich-results for — FAQPage schema whose
 * answer text does not match what users see). So this is derive-from-visible,
 * not an independent editorial artifact:
 *
 *  - `FAQ_DATA` holds the RAW MDX Q/A, byte-faithful from the page source.
 *  - `extractFaq()` parses the same shape out of an MDX file; the test asserts
 *    `extractFaq(<page>) deep-equals FAQ_DATA[<page>]` for BOTH question AND
 *    answer (raw==raw, exact) — so editing a visible Q or A without updating
 *    FAQ_DATA fails the tests (the schema-matches-visible drift-catch).
 *  - `buildFaqJsonLd()` renders the schema, normalizing markdown to the visible
 *    text (`**bold**`/`` `code` ``/`[text](url)` -> display text) so
 *    `acceptedAnswer.text` mirrors the rendered answer, and escapes `<` ->
 *    `<` so authored answer text can never break out of the <script> it is
 *    injected into (a `</script>` in any answer would otherwise terminate the
 *    JSON-LD block — escaping the `<` itself neutralizes it case-insensitively).
 */

export interface FaqEntry {
  /** Raw MDX text of the `###` question heading. */
  readonly q: string;
  /** Raw MDX text of the answer paragraph(s). */
  readonly a: string;
}

/**
 * Per-slug FAQ Q/A, copied byte-faithful from the merged page MDX
 * (`## Frequently asked questions` sections). Keyed by docs slug. The
 * extractor test couples each entry to its MDX so drift fails the tests.
 */
export const FAQ_DATA: Record<string, readonly FaqEntry[]> = {
  'getting-started': [
    {
      q: 'What is Conduit?',
      a: "Conduit is a white-label MCP gateway for MSPs. It connects any tool-calling AI assistant to the vendor MCP servers an MSP and its customers rely on (RMM, PSA, documentation, security, and more), behind one auditable, permissioned endpoint per customer — under the MSP's own brand.",
    },
    {
      q: 'What is an MCP gateway?',
      a: 'An MCP gateway sits between AI assistants and the tools they call. It speaks the Model Context Protocol (a provider-neutral standard for connecting AI to tools) and brokers each tool call — handling authentication, credentials, permissions, and audit — so an AI assistant can use your business systems without each system being wired to each AI client. Conduit is an MCP gateway built for MSPs: it gives an AI the access and visibility it needs into the business; it is not a workflow-automation tool.',
    },
    {
      q: 'Do I need to install anything to use Conduit?',
      a: "No. Conduit is a hosted gateway — you **connect** an AI client to it, you don't install Conduit itself. Setup is pointing your AI client at your Conduit MCP endpoint and signing in once.",
    },
    {
      q: 'Which AI clients work with Conduit?',
      a: 'Any MCP-capable client. Conduit speaks the standard Model Context Protocol, so Claude Desktop, Claude Code, Cline, Continue, Cursor, and other MCP clients all connect. See [Supported clients](/docs/reference/supported-clients/).',
    },
    {
      q: 'How long does first-time setup take?',
      a: 'About 20–40 minutes the first time — create your MSP organization, connect one vendor, connect an AI client, and make a test tool call.',
    },
    {
      q: 'What do I need before I start?',
      a: 'An Auth0-backed login for your MSP, an alpha invite code or the 14-day trial as your subscription on-ramp, and API credentials for at least one vendor you want to connect.',
    },
  ],
  'guides/connecting-a-client': [
    {
      q: 'Which AI clients can connect to Conduit?',
      a: "Any MCP-capable client. Conduit speaks the standard Model Context Protocol, so Claude Desktop, Claude Code, Cline, Continue, Cursor, and other MCP clients all work — there's no per-vendor lock-in. See [Supported clients](/docs/reference/supported-clients/).",
    },
    {
      q: 'Do I need `mcp-remote`?',
      a: 'Only if your client connects to local programs but not to a remote URL. Clients with native remote-MCP support (like Claude Code via `claude mcp add --transport http`) connect directly. Claude Desktop and similar stdio-only clients use the `mcp-remote` bridge.',
    },
    {
      q: 'How do I sign in — do I paste an API key?',
      a: 'No API keys. The first time your client connects, Conduit runs a standard OAuth 2.1 sign-in in your browser (email/password or Microsoft / Entra ID). The token is cached and refreshed automatically — you sign in once.',
    },
    {
      q: 'I connected but no tools appear. Why?',
      a: "Either your organization hasn't connected any vendors yet, or your role's tool allowlist restricts them. Your MSP admin controls which vendors and tools your role can reach.",
    },
  ],
  'guides/connecting-copilot-studio': [
    {
      q: 'Can I use OAuth 2.1 + PKCE like Claude does?',
      a: "Not through Power Platform's Generic OAuth 2.0 today. Copilot Studio's custom-connector framework does not send PKCE, so Conduit's authorization endpoint rejects the request. The service-client (API Key) path is the supported route.",
    },
    {
      q: 'Why is the auth a "Bearer token" pasted into an API Key field?',
      a: "Power Platform's API Key auth type lets the connector author choose any header. We use `Authorization: Bearer <token>` so the gateway treats it as a standard MCP bearer. Functionally it is an OAuth 2.0 client-credentials access token — the connector framework just doesn't refresh it automatically.",
    },
    {
      q: 'Do I need a separate service client per agent?',
      a: 'No. One service client can back as many connectors as you want — including per-vendor connectors. Choose per-agent or per-vendor scoping based on how you want to revoke independently.',
    },
    {
      q: "Can end users see other end users' tool calls?",
      a: "No. Each invocation runs under the service-client identity on Conduit's side, but Power Platform records the end user who initiated the invocation. Conduit's audit log shows the service-client subject; Copilot Studio's audit log shows the end user. The two together are the audit trail.",
    },
    {
      q: 'Will this work for an agent published to Teams / a website?',
      a: 'Yes — once the connector is wired and tested in the maker portal, publishing the agent to any Copilot Studio channel carries the connector with it. Each end user completes the one-time per-end-user consent the first time they invoke a gateway tool.',
    },
  ],
  "reference/supported-clients": [
    { q: "Which AI clients work with Conduit?", a: "Any MCP-capable client. Conduit speaks the standard Model Context Protocol end to end, so Claude Desktop, Claude Code, Perplexity Computer, Cline, Continue, Cursor, and any other client that implements the MCP client spec connect — there is no per-vendor lock-in." },
    { q: "Do I need a Claude-specific setup to use Conduit?", a: "No. Connection is standard OAuth 2.1 + PKCE (the MCP authorization spec), not a Claude-specific flow, and Conduit passes through each vendor's own MCP tool schemas unchanged — so any MCP client connects the same way." },
    { q: "How does a client connect to Conduit?", a: "There are exactly two methods: native remote MCP, for clients that connect to a remote MCP server by URL (like Claude Code's `claude mcp add --transport http`), and the `mcp-remote` bridge, for clients that only speak local stdio MCP. Both use the same Conduit endpoint and OAuth 2.1 sign-in." },
    { q: "Does Conduit have to add support for a new MCP client before it works?", a: "No. Because Conduit is MCP-native, client support is a property of the protocol, not a per-vendor integration — a new MCP-capable client works on day one without any change to Conduit." },
    { q: "What about AI tools that don't speak MCP?", a: "Some platforms do tool-calling without native MCP — for example, an app built directly on a provider's function-calling API. Support for those is a demand-driven roadmap item, an additive per-provider adapter layer, not shipped today. Raise specific needs with your WYRE contact." },
  ],
  "guides/vendor-connections": [
    { q: "Which vendors can I connect to Conduit?", a: "Conduit ships with a catalog spanning RMM, PSA, documentation, security, email security, network, BCDR, productivity, sales, accounting, CRM, and marketplace tools — ConnectWise, Autotask, Datto RMM, IT Glue, Microsoft 365, and many more. No vendors are pre-configured; the ones enabled in a deployment depend on the MSP's tool stack, decided during discovery." },
    { q: "Where are vendor credentials stored, and at what scope?", a: "A vendor credential can be stored at one of four scopes — personal, team, organization, or a machine-to-machine service client. Most MSPs configure vendors at the organization scope so every technician shares one vendor account, with personal credentials as the per-technician override." },
    { q: "How do I rotate a vendor API key?", a: "Re-connect the vendor at the matching scope — org-level at `/org/connections`, team-level under `/org/teams`, or personal at `/settings/profile`. Conduit encrypts the new credential and uses it immediately, overwriting the old one; there is no separate rotate action." },
    { q: "Why do my tool calls return \"no credentials for vendor\"?", a: "No credential is configured at any scope the user can resolve. Connect the vendor at the organization scope, or check that the user is in a team that has one. The audit log records every tool call with its status code, which helps confirm whether a failure is auth, the vendor, or the tool." },
    { q: "How do OAuth vendors like Microsoft 365 stay connected?", a: "For OAuth vendors (Xero, QuickBooks Online, HubSpot, Microsoft 365), Conduit stores the access and refresh tokens, encrypted, and refreshes them automatically when they expire. If an OAuth vendor stops working, the refresh token was likely revoked by a password change, app uninstall, or withdrawn consent — re-run the OAuth connect flow." },
  ],
  "guides/billing": [
    { q: "How is Conduit priced?", a: "Conduit is one flat plan — everything is included. There are no feature tiers, no usage credits, and no per-call metering. You pay a base organization fee plus a per-seat price, and every feature is on from day one." },
    { q: "What does a Conduit subscription cost?", a: "A base organization fee of $399 per month, plus $39 per month for each human seat and for each agent (service-client) seat beyond the two included with the base fee. The price is the same for every organization; a self-hosted or white-label deployment can override pricing via the `PLAN_CATALOG` environment variable." },
    { q: "How do I start — is there a trial?", a: "Yes. Start a free 14-day trial of the full platform from the billing page at `/org/billing`; it converts to a paid subscription when you add a payment method through Stripe Checkout, or closes automatically at the end of the 14 days if you do nothing. An alpha invite code activates the subscription immediately, without the trial." },
    { q: "What happens if a payment fails?", a: "The organization moves through a dunning lifecycle rather than being cut off immediately — the payment-failing, past-due, and final-warning states all keep full access while a configurable grace window (7 days by default) runs. Only after the grace window expires is platform access gated, and recovering the payment restores it." },
    { q: "What happens if I cancel?", a: "Cancelling through the Stripe Customer Portal ends the subscription at the end of the current billing period, after which platform access is suspended. Your data is preserved, so the organization can resume by re-subscribing." },
  ],
  "guides/msp-onboarding": [
    { q: "Who is Conduit onboarding for — can I self-serve?", a: "The flow works whether the MSP owner is self-serving or a WYRE operator is running a managed onboarding. Most build-out steps can be done through the dashboard, the recommended path for first-time onboarding, or via the API for teams automating provisioning." },
    { q: "What should I gather before onboarding?", a: "During discovery, inventory the MSP's tool stack (which vendor integrations to enable), the team size, the role structure, the credential model (shared org-level keys versus per-team or per-user keys), compliance needs such as audit export or SIEM integration, and the MCP client preference — any MCP-compatible client works (Claude Desktop, Claude Code, Cursor, and others), or service-client automation." },
    { q: "How does billing start during onboarding?", a: "A new organization begins with a free 14-day trial of the full platform; it converts to a paid subscription when a payment method is added through Stripe Checkout, or closes at the end of the 14 days. An alpha invite code activates the paid subscription immediately. Conduit is one flat plan — see the Billing & Plans guide for the pricing detail." },
    { q: "How do I control which vendors and tools a member can use?", a: "Set each member's vendor access from `/org/server-access` — a deny-by-default posture, starting from a `defaultServerAccess` of `none`, is recommended — and restrict which tools a role can call per vendor with tool allowlists at `/org/tool-access`. Owners always have full access." },
    { q: "How do I connect an MCP client once the tenant is built?", a: "Point your MCP client — Claude Desktop, Claude Code, Cursor, or any MCP-compatible client — at the Conduit server URL (`https://conduit.wyre.ai/v1/mcp`). On first use an OAuth flow opens a browser for authentication; after sign-in and credential connection, the token is cached and refreshed automatically." },
  ],
  "guides/scim": [
    { q: "Which identity providers does Conduit support for SCIM?", a: "Conduit supports SCIM 2.0 with four identity providers: Microsoft Entra ID, Okta, JumpCloud, and Google Workspace. Generating a SCIM token in Conduit, under Provisioning at `/org/scim`, is the same for all of them; the rest of the setup is IdP-specific." },
    { q: "What does SCIM provision in Conduit?", a: "A user assignment creates a Conduit user and an org membership at the connection's default role; a group assignment or push materializes a Conduit team and its members; and deactivating or unassigning a user removes the org membership and marks the user inactive (re-activatable). A provisioned user still logs in through Conduit's existing SSO, which binds the shadow record on first login." },
    { q: "What role do SCIM-provisioned users get?", a: "You choose the default role when generating the SCIM token, and every user that connection provisions receives it. `member` is the safe default." },
    { q: "Why aren't group memberships syncing?", a: "Most IdPs only send memberships for groups explicitly assigned or pushed to the application, so assign the group itself rather than just its members; on JumpCloud, also make sure Group Management was on when the app was activated. Each IdP's troubleshooting section covers the provider-specific cause." },
    { q: "Is Google Workspace SCIM as capable as the others?", a: "No. Google Workspace's SCIM is materially less polished — no on-demand sync, limited PATCH support, and nested groups are flattened — and it requires a plan that includes Cloud Identity Premium. If another supported IdP is available, prefer it." },
  ],
  "reference/security": [
    { q: "How are my vendor credentials protected?", a: "All vendor credentials are encrypted with AES-256-GCM using per-record key derivation, at the application layer before they reach the database, so a database breach exposes ciphertext rather than plaintext. Credentials are never sent to the AI model or the user's workstation — Conduit decrypts them server-side only to make the upstream vendor call." },
    { q: "If whoever operates Conduit is compromised, what is my exposure?", a: "Conduit decrypts secrets in-process to proxy your API calls, so the operator of the deployment — you if self-hosted, WYRE if WYRE-managed — holds the trust dependency. With production access plus a database export, an operator could in principle decrypt credentials offline, as is true of any tool that handles your secrets to make API calls on your behalf. What makes that dependency bounded, observable, and reversible is detailed in the Trust Model section above." },
    { q: "Can Conduit staff read my credentials, and is Conduit certified?", a: "We will not claim that staff cannot decrypt your data, that the master key is hardware-secured, that Conduit is zero-knowledge, or that it is SOC 2 / ISO 27001 / CMMC certified — none of those are true today. The master key currently lives in a cloud secret; moving it to an HSM-backed key with no extract permission, via envelope encryption, is the planned next step." },
    { q: "How does Conduit keep one organization's data isolated from another?", a: "Every record is scoped to an organization ID and protected by Postgres Row-Level Security, which is evaluated for every query regardless of how it is constructed, so a user from one organization cannot retrieve another's credentials, audit logs, or members. Credentials are additionally encrypted under organization-scoped derived keys, so blobs are not decryptable across organizations." },
    { q: "How does Conduit defend against prompt injection?", a: "Conduit returns tool responses as structured `tool_result` objects rather than raw text, tags responses by content type, and namespaces privileged credential-retrieval tools so they can be restricted by role through tool allowlists — all of which reduce the blast radius of an injection. MSP teams should pair these with least-privilege allowlists and periodic audit-log review." },
  ],
};

/**
 * Normalize inline markdown to the visible rendered text: `**bold**` and
 * `*italic*` -> inner, `` `code` `` -> inner, `[text](url)` -> text. Leaves
 * everything else (em-dashes, parens, slashes) intact — these render literally.
 */
export function mdToPlain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/`([^`]+)`/g, '$1') // `code` -> code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1'); // *italic* -> italic
}

/**
 * Extract the `## Frequently asked questions` Q/A from an MDX document as RAW
 * text (so the drift-test compares raw==raw against FAQ_DATA). A question is a
 * `###` heading inside the FAQ section; its answer is the text up to the next
 * `###` or `##`. Returns [] if the page has no FAQ section.
 */
export function extractFaq(mdx: string): FaqEntry[] {
  const lines = mdx.split('\n');
  const out: FaqEntry[] = [];
  let inFaq = false;
  let q: string | null = null;
  let answer: string[] = [];
  const flush = (): void => {
    if (q !== null) out.push({ q, a: answer.join('\n').trim() });
    q = null;
    answer = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h2) {
      // A `##` ends any prior FAQ section and decides if we are entering one.
      flush();
      inFaq = /frequently asked questions/i.test(h2[1]);
      continue;
    }
    if (!inFaq) continue;
    if (h3) {
      flush();
      q = h3[1].trim();
      continue;
    }
    if (q !== null) answer.push(line);
  }
  flush();
  return out;
}

/**
 * Escape a JSON string for safe injection into an HTML <script>: replace every
 * `<` with its JSON unicode escape `<`. This neutralizes `</script>` (any
 * case), `<!--`, and `<script` — all begin with `<`, so escaping the `<` itself
 * is case-insensitive by construction (a naive `replace('</script>', …)` would
 * miss `</ScRiPt>`). The result is still valid JSON: `<` parses back to
 * `<`, so round-tripping through `JSON.parse` recovers the original object.
 */
export function escapeScriptContent(jsonText: string): string {
  return jsonText.replace(/</g, '\\u003c');
}

/**
 * Build the FAQPage JSON-LD <script> body for a slug: schema.org FAQPage whose
 * question/answer text is the VISIBLE (markdown-normalized) rendering, with
 * `<` escaped so no authored answer can break out of the <script>.
 */
export function buildFaqJsonLd(slug: string): string {
  const entries = FAQ_DATA[slug];
  if (!entries) throw new Error(`buildFaqJsonLd: no FAQ_DATA for slug "${slug}"`);
  return faqJsonLdFor(entries);
}

/** FAQPage JSON-LD for an explicit entries array (testable with any input). */
export function faqJsonLdFor(entries: readonly FaqEntry[]): string {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: mdToPlain(e.q),
      acceptedAnswer: { '@type': 'Answer', text: mdToPlain(e.a) },
    })),
  };
  return escapeScriptContent(JSON.stringify(schema));
}
