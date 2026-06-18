/**
 * BYOMCP permission-tier classification (WYREAI-190).
 *
 * Catalog vendors carry a HAND-CURATED per-tool classification in
 * `VENDOR_TOOL_CONFIG` (isWrite/isAdmin), which the existing tier resolver
 * (`tierForToolConfig`, src/auth/tier-check.ts) turns into a read/write/admin
 * `PermissionTier`. A BYO server is not in the catalog, so it has no curated
 * config — `requiredTierForTool` returns null for every BYO tool, which is
 * FAIL-CLOSED (deny-all). That is safe but useless: BYO tools could never be
 * invoked under the tier gate.
 *
 * This module fills exactly that gap and NOTHING more: it derives a
 * `ToolConfig` (the same shape catalog tools use, with the `'generic'`
 * classification-only entityType) heuristically from the tool's name +
 * description, then hands it to the SAME `tierForToolConfig` resolver. Tier
 * resolution itself is NOT reimplemented — `read < write < admin`, the ordinal
 * ranks, and `callerCanInvoke` all stay in tier-check.ts. We only supply the
 * required-tier input that the catalog supplies by hand.
 *
 * The heuristic is deliberately CONSERVATIVE — it gates access, so it errs
 * toward over-restricting (the tier-check.ts invariant: "never infer a tier
 * from an unmatched tool; a silent treat-unknown-as-read would let a mis-named
 * write tool leak"). Concretely:
 *   - an unrecognized leading verb classifies as WRITE, never read;
 *   - any secret/credential noun (even on a read verb — reading a secret is
 *     privileged) escalates to ADMIN;
 *   - a mutating verb on a privileged domain (roles, members, billing, API
 *     keys, org settings) escalates to ADMIN;
 *   - only a clearly read-shaped verb on a non-secret target is READ.
 *
 * This is pure + total + deterministic (no I/O — it runs on already-discovered,
 * already-owner-scoped, already-SSRF-guarded tool metadata from #189). No new
 * fetch surface, so no new SSRF surface.
 */
import type { McpTool } from '../proxy/tool-cache.js';
import type { ToolConfig } from '../proxy/result-cache.js';
import { tierForToolConfig, type PermissionTier } from '../auth/tier-check.js';

/** Read-shaped leading verbs — non-mutating, observation only. */
const READ_VERBS = new Set([
  'get', 'list', 'search', 'find', 'read', 'fetch', 'describe', 'show', 'view',
  'query', 'lookup', 'count', 'export', 'download', 'status', 'check', 'ping',
  'health', 'summary', 'summarize', 'report', 'stat', 'stats', 'retrieve', 'scan',
  'preview', 'inspect', 'validate', 'test',
]);

/**
 * Verbs that ARE privilege/identity operations in themselves — admin regardless
 * of target noun (granting access is admin even with no obvious "role" noun).
 */
const HARD_ADMIN_VERBS = new Set([
  'grant', 'revoke', 'impersonate', 'sudo', 'rotate', 'provision', 'deprovision',
  'suspend', 'unsuspend', 'disable', 'enable', 'authorize', 'deauthorize',
]);

/**
 * Domain nouns that make a MUTATING tool an org/privilege-level operation —
 * escalates write → admin (mirrors the catalog isAdmin rule: member/role
 * management, billing-state, vendor-config/settings mutations).
 */
const PRIVILEGED_NOUNS = new Set([
  'permission', 'permissions', 'role', 'roles', 'policy', 'policies', 'member',
  'members', 'membership', 'user', 'users', 'account', 'accounts', 'owner',
  'billing', 'invoice', 'invoices', 'subscription', 'subscriptions', 'seat',
  'seats', 'tenant', 'tenants', 'organization', 'organizations', 'org', 'sso',
  'scim', 'webhook', 'webhooks', 'integration', 'integrations', 'setting',
  'settings', 'config', 'configuration', 'apikey', 'apikeys', 'key', 'keys',
]);

/**
 * Secret/credential nouns. Their mere presence — even under a read verb —
 * escalates to ADMIN: reading a password or credential is a privileged,
 * exfiltration-capable operation.
 */
const SECRET_NOUNS = new Set([
  'secret', 'secrets', 'password', 'passwords', 'credential', 'credentials',
  'token', 'tokens', 'apikey', 'apikeys', 'privatekey', 'privkey',
  'clientsecret', 'accesskey', 'passphrase',
]);

/**
 * Split a tool name/description into lowercase word tokens. Handles snake_case,
 * kebab-case, dot/slash separators, and camelCase boundaries — so
 * `autotask_create_ticket`, `createTicket`, `delete-user`, and `tools/list`
 * all tokenize sensibly.
 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * The token set augmented with adjacent-pair concatenations, so a noun that the
 * separators split (`api_key` → `api`,`key`; `private_key` → `private`,`key`;
 * `client_secret` → `client`,`secret`) still matches the joined forms in
 * SECRET_NOUNS / PRIVILEGED_NOUNS (`apikey`, `privatekey`, `clientsecret`).
 */
function augmentedTokenSet(tokens: string[]): Set<string> {
  const set = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) {
    set.add(tokens[i] + tokens[i + 1]);
  }
  return set;
}

/**
 * Classify a discovered BYO tool into a catalog-shaped `ToolConfig`. entityType
 * is always `'generic'` (classification-only; BYO tools are never cache-tuned),
 * ttlMs always 0. Only isWrite/isAdmin carry signal.
 */
export function classifyByoTool(tool: McpTool): ToolConfig {
  const nameTokens = tokenize(tool.name ?? '');
  // The description widens secret/privileged-noun detection but does NOT change
  // the leading-verb decision (which comes from the tool name only). Both are
  // augmented with adjacent-pair concatenations so split nouns (api_key) match.
  const allTokens = new Set([
    ...augmentedTokenSet(nameTokens),
    ...augmentedTokenSet(tokenize(tool.description ?? '')),
  ]);

  const leadVerb = nameTokens[0] ?? '';
  const isReadVerb = READ_VERBS.has(leadVerb);

  const hasHardAdminVerb = nameTokens.some((t) => HARD_ADMIN_VERBS.has(t));
  const hasSecretNoun = [...allTokens].some((t) => SECRET_NOUNS.has(t));
  const hasPrivilegedNoun = [...allTokens].some((t) => PRIVILEGED_NOUNS.has(t));

  // Mutating = a non-read leading verb. Unknown verbs are treated as mutating
  // (conservative — never silently read an unrecognized tool).
  const isMutating = !isReadVerb;

  const isAdmin =
    hasHardAdminVerb || hasSecretNoun || (isMutating && hasPrivilegedNoun);
  const isWrite = isAdmin || isMutating;

  return { entityType: 'generic', ttlMs: 0, isWrite, isAdmin };
}

/**
 * The permission tier required to invoke a BYO tool. Reuses the catalog tier
 * resolver — we only supply the classification it would otherwise read from
 * VENDOR_TOOL_CONFIG. Total: classifyByoTool never returns null, so the `??`
 * is unreachable defence-in-depth (admin = the safe fallback).
 */
export function byoRequiredTier(tool: McpTool): PermissionTier {
  return tierForToolConfig(classifyByoTool(tool)) ?? 'admin';
}

/** A discovered BYO tool annotated with its required permission tier. */
export interface ClassifiedByoTool extends McpTool {
  /** The EFFECTIVE required tier — a manual owner pin if present, else autoTier. */
  tier: PermissionTier;
  /** The tier the 190 heuristic inferred, before any owner override. */
  autoTier: PermissionTier;
  /** True when an owner pin (WYREAI-191) overrode the auto tier. */
  overridden: boolean;
}

/**
 * Annotate a list of discovered BYO tools with their required tiers. With an
 * `overrides` map (toolName → owner-pinned tier), a pin WINS over the auto
 * classification and the tool is flagged `overridden`. Without it, every tool's
 * effective tier is its auto tier.
 */
export function classifyByoTools(
  tools: readonly McpTool[],
  overrides?: ReadonlyMap<string, PermissionTier>,
): ClassifiedByoTool[] {
  return tools.map((tool) => {
    const autoTier = byoRequiredTier(tool);
    const pinned = overrides?.get(tool.name);
    return {
      ...tool,
      autoTier,
      tier: pinned ?? autoTier,
      overridden: pinned !== undefined && pinned !== null,
    };
  });
}
