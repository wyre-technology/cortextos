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
