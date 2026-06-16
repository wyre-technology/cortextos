import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { VENDORS } from './vendor-config.js';

/**
 * PR-D cross-repo OPTIONS-DRIFT canary scaffold (boss msg-1781580646949 +
 * msg-1781590062291). Closes analyst's "no canary catches gateway-vs-
 * conduit drift across vendor entries" finding for the `fields[].options`
 * axis specifically.
 *
 * Motivation — us6 incident 2026-06-16: gateway PR #260 added BOTH `lnx`
 * AND `us6` to auvik's region options[] in the same wave. Conduit's PR
 * #405 caught lnx (operator surfaced creds-on-unrecognized-region) but
 * silently MISSED us6. Forge cross-checked manually 2026-06-16 to find
 * the gap. A canary would have caught us6 on day-zero.
 *
 * Coverage axis: this scaffold covers `fields[].options` ONLY — sibling
 * to the existing cross-repo parity assert in
 * `vendor-canonical-parity.ts` (which covers the BATCH_1 canonical
 * fields). Options-drift is a DIFFERENT-shape axis: parity-batch checks
 * static structural shape; this canary checks user-facing enum value
 * sets that vendors expose to operators.
 *
 * Where it lives: `*.integration.test.ts` so it does NOT run in default
 * `npm test` (CI-safe-by-default — gh-CLI + network round-trip). Runs
 * via `npm run test:integration`. Skip-gated three ways:
 *   (1) `gh` CLI not on PATH → skip (CI / contributor machines without gh)
 *   (2) `gh auth status` fails → skip (no creds / token expired)
 *   (3) network round-trip to GitHub fails → skip with the error message
 *
 * Source-citation (ruby's set-boundary-via-external-source discipline,
 * sibling to PR #405 / #422 AUVIK_VALID_REGIONS):
 *   - Gateway repo: `wyre-technology/mcp-gateway`
 *   - Path: `src/credentials/vendor-config.ts` at `main` branch HEAD at
 *     test run time. The actual SHA is logged in the test output so
 *     failures cite a specific point-in-time.
 *   - Extraction: regex over the fetched TS source. ACKNOWLEDGED-FRAGILE
 *     at scaffold scope — see the regex docstring below. Future
 *     hardening could parse the AST or fetch a gateway-emitted canonical
 *     JSON. The regex is keyed to the current `options:` array shape,
 *     which has been stable across the relevant gateway PRs.
 *
 * Known drift allow-list — each entry has a citation explaining WHY the
 * drift exists. Adding a new entry requires a corresponding source
 * citation (sibling to CROSS_REPO_DRIFT_ALLOWLIST in vendor-batch1.ts).
 * Anyone reducing the allow-list when the drift is resolved is making
 * the canary stricter — that's the intended ratchet direction.
 */

const GATEWAY_REPO = 'wyre-technology/mcp-gateway';
const GATEWAY_PATH = 'src/credentials/vendor-config.ts';

/**
 * Vendors known to have drift on `options[]` between conduit and gateway,
 * with a citation for each so removing an entry is deliberate.
 *
 * Each value is a free-text reason — analyst-citation, sibling to the
 * source-citation pattern in vendor-batch1.ts.
 */
const CANARY_KNOWN_OPTIONS_DRIFT: Readonly<Record<string, string>> = {
  // itglue: gateway has region field + X-ITGlue-Region header (US/EU/AU);
  // conduit LACKS it (pre-existing conduit bug — see
  // CROSS_REPO_DRIFT_ALLOWLIST.itglue in vendor-batch1.ts for the
  // companion field-shape drift entry). FIX = add region to conduit;
  // tracked as a separate functional change.
  'itglue': 'gateway has region field; conduit lacks it (vendor-batch1.ts itglue entry)',
  // action1: gateway does not have action1 in its catalog. Conduit-only
  // vendor add. N/A direction — gateway-side equivalent missing entirely.
  'action1': 'gateway catalog does not include action1 (conduit-only)',
  // unitrends: gateway has a `verifyTls` field with options ['true','false']
  // for the on-prem TLS-verify toggle. Conduit lacks the verifyTls field
  // entirely. Surfaced by this canary scaffold's first run 2026-06-16 —
  // file as follow-up (PR-D.5) to add verifyTls to conduit's unitrends.
  'unitrends': "gateway has verifyTls field; conduit lacks it (surfaced by canary scaffold 2026-06-16 — file as PR-D.5)",
  // mimecast: gateway catalog does not include mimecast at all. Conduit-
  // only vendor add (sibling to action1). Surfaced by this canary
  // scaffold's first run 2026-06-16 — verified via grep against gateway-
  // side vendor-config.ts (zero occurrences of "mimecast").
  'mimecast': 'gateway catalog does not include mimecast (conduit-only, sibling to action1)',
};

/**
 * Extract every `slug:`-keyed vendor block's `options:` array from a TS
 * source string. SCAFFOLD-SCOPE regex — keyed to the current
 * `options: ['a', 'b']` shape on a single line OR multi-line array
 * literal. If gateway-side formatting changes shape, this needs an AST
 * parser instead.
 */
function extractOptionsBySlug(tsSource: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = tsSource.split('\n');
  let currentSlug: string | null = null;
  let collectingOptions: string[] | null = null;
  // Matches an indented key like `slug:` or `'slug':` opening a vendor block
  const vendorOpen = /^\s+'?([a-z0-9-]+)'?\s*:\s*\{\s*$/;
  // Matches `options:` line — may continue across multiple lines for long arrays
  const optionsLine = /options:\s*\[(.*?)(\]|$)/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = vendorOpen.exec(line);
    if (m) {
      currentSlug = m[1]!;
      continue;
    }
    if (!currentSlug) continue;
    const optMatch = optionsLine.exec(line);
    if (optMatch) {
      // Single-line shape: options: ['a', 'b']
      if (optMatch[2] === ']') {
        const opts = parseStringList(optMatch[1]!);
        if (opts.length > 0) {
          // Only KEEP the first-encountered options per slug (a vendor with
          // multiple fields-with-options is rare; takes the first).
          if (!out.has(currentSlug)) out.set(currentSlug, opts);
        }
      } else {
        // Multi-line: start collecting until we find the closing ']'
        collectingOptions = [];
        collectingOptions.push(...parseStringList(optMatch[1]!));
        for (let j = i + 1; j < lines.length; j += 1) {
          const inner = lines[j]!;
          const closeIdx = inner.indexOf(']');
          if (closeIdx >= 0) {
            collectingOptions.push(...parseStringList(inner.slice(0, closeIdx)));
            break;
          }
          collectingOptions.push(...parseStringList(inner));
        }
        if (collectingOptions.length > 0 && !out.has(currentSlug)) {
          out.set(currentSlug, collectingOptions);
        }
        collectingOptions = null;
      }
    }
  }
  return out;
}

function parseStringList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .map((x) => x.replace(/^['"]/, '').replace(/['"]$/, ''))
    .filter((x) => x.length > 0 && x !== '...AUVIK_VALID_REGIONS' && !x.startsWith('...'));
}

function getConduitOptionsBySlug(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [slug, v] of Object.entries(VENDORS)) {
    for (const f of v.fields) {
      if (f.options && f.options.length > 0) {
        if (!out.has(slug)) out.set(slug, [...f.options]);
        break;
      }
    }
  }
  return out;
}

interface GatewayFixture {
  sha: string;
  optionsBySlug: Map<string, string[]>;
}

function fetchGatewayFixture(): GatewayFixture {
  // SECURITY: every gh invocation uses execFileSync with an argument
  // array — no shell interpolation, so even a hostile gateway response
  // can't escape into a shell command. The SHA is validated as
  // 40-char hex before being passed back to gh as a ref param.
  const sha = execFileSync(
    'gh',
    ['api', `repos/${GATEWAY_REPO}/branches/main`, '--jq', '.commit.sha'],
    { encoding: 'utf8', timeout: 15_000 },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`gateway main SHA failed hex validation: ${JSON.stringify(sha)}`);
  }
  // Pin the fetch to the exact SHA so the assertion ground-truth is
  // internally consistent even if main moves between calls. Decode
  // base64 in Node (Buffer) instead of piping through a shell.
  const contentB64 = execFileSync(
    'gh',
    [
      'api',
      `repos/${GATEWAY_REPO}/contents/${GATEWAY_PATH}?ref=${sha}`,
      '--jq',
      '.content',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const content = Buffer.from(contentB64, 'base64').toString('utf8');
  return { sha, optionsBySlug: extractOptionsBySlug(content) };
}

describe('cross-repo OPTIONS-DRIFT canary (PR-D scaffold)', () => {
  let canRun = false;
  let skipReason = '';
  let gatewayFixture: GatewayFixture | null = null;

  beforeAll(() => {
    // Probe gh availability via execFileSync — no shell, no injection.
    try {
      execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      skipReason = 'gh CLI not on PATH — canary requires gh for gateway fetch';
      return;
    }
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      skipReason = 'gh not authenticated — `gh auth login` required';
      return;
    }
    try {
      gatewayFixture = fetchGatewayFixture();
      canRun = true;
    } catch (err) {
      skipReason = `gateway fetch failed: ${(err as Error).message}`;
    }
  });

  it('every vendor with options[] matches the gateway-side options[] (or is in the known-drift allow-list)', () => {
    if (!canRun || !gatewayFixture) {
      // eslint-disable-next-line no-console
      console.log(`[canary] SKIPPED: ${skipReason}`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[canary] gateway main SHA: ${gatewayFixture.sha}`);
    const conduit = getConduitOptionsBySlug();
    const gateway = gatewayFixture.optionsBySlug;
    const drift: Array<{
      slug: string;
      conduit: string[] | undefined;
      gateway: string[] | undefined;
    }> = [];
    // Union of slugs across both sides
    const allSlugs = new Set<string>([...conduit.keys(), ...gateway.keys()]);
    for (const slug of allSlugs) {
      if (slug in CANARY_KNOWN_OPTIONS_DRIFT) continue;
      const a = conduit.get(slug);
      const b = gateway.get(slug);
      if (!a && !b) continue;
      if (!a || !b) {
        drift.push({ slug, conduit: a, gateway: b });
        continue;
      }
      // Compare as set-equal (order-invariant)
      const aSet = new Set(a);
      const bSet = new Set(b);
      const inAOnly = a.filter((x) => !bSet.has(x));
      const inBOnly = b.filter((x) => !aSet.has(x));
      if (inAOnly.length > 0 || inBOnly.length > 0) {
        drift.push({ slug, conduit: a, gateway: b });
      }
    }
    expect(
      drift,
      `cross-repo options-drift detected (gateway SHA ${gatewayFixture.sha}). ` +
        `Each entry is either a real drift (fix the lagging side) or a known ` +
        `drift (add to CANARY_KNOWN_OPTIONS_DRIFT with a citation). Drift: ` +
        JSON.stringify(drift, null, 2),
    ).toEqual([]);
  });

  it('every CANARY_KNOWN_OPTIONS_DRIFT entry references a vendor known to either side (no ghost classifications)', () => {
    if (!canRun || !gatewayFixture) {
      // eslint-disable-next-line no-console
      console.log(`[canary] SKIPPED: ${skipReason}`);
      return;
    }
    const conduit = getConduitOptionsBySlug();
    const gateway = gatewayFixture.optionsBySlug;
    const ghosts = Object.keys(CANARY_KNOWN_OPTIONS_DRIFT).filter(
      (s) => !conduit.has(s) && !gateway.has(s) && !(s in VENDORS),
    );
    expect(
      ghosts,
      `Known-drift entries reference slugs absent from both sides — ` +
        `remove from CANARY_KNOWN_OPTIONS_DRIFT. Ghosts: ${ghosts.join(', ')}`,
    ).toEqual([]);
  });
});
