/**
 * Minimal SCIM filter parser.
 *
 * Supports the only two filter shapes Entra/Okta/JumpCloud/Google actually
 * send for dedupe lookups before POST:
 *
 *   userName eq "alice@acme.com"
 *   externalId eq "abc-123"
 *
 * Anything else throws — handler translates to 400 with scimType:invalidFilter.
 * We intentionally do NOT implement the full RFC 7644 §3.4.2.2 grammar.
 */

const FILTER_RE = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

export interface ParsedFilter {
  attribute: 'userName' | 'externalId';
  value: string;
}

export class UnsupportedFilterError extends Error {
  constructor(public readonly filter: string) {
    super(`Unsupported SCIM filter: ${filter}`);
    this.name = 'UnsupportedFilterError';
  }
}

export function parseFilter(filter: string): ParsedFilter {
  const m = filter.match(FILTER_RE);
  if (!m) {
    throw new UnsupportedFilterError(filter);
  }
  const attribute = m[1].toLowerCase() === 'username' ? 'userName' : 'externalId';
  // Unescape simple JSON-style escapes (\", \\). SCIM strings rarely contain
  // these, but Entra has been known to send a literal backslash before quotes
  // in odd characters.
  const value = m[2].replace(/\\(.)/g, '$1');
  return { attribute, value };
}
