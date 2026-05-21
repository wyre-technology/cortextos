import { join } from 'path';

/** Canonical segment rule — matches AGENT_NAME_REGEX in src/utils/validate.ts. */
const SEGMENT_RE = /^[a-z0-9_-]+$/;

export interface QualifiedName {
  /** Engineer namespace, if this is a personal agent. */
  engineer?: string;
  /** Bare agent name. */
  agent: string;
}

/**
 * Parse an agent reference into its parts.
 *   "boss"       -> { agent: 'boss' }            (shared org agent)
 *   "aaron/dev"  -> { engineer: 'aaron', agent: 'dev' }  (personal agent)
 */
export function parseQualifiedName(name: string): QualifiedName {
  const parts = name.split('/');
  if (parts.length > 2) {
    throw new Error(`Invalid qualified agent name "${name}": at most one "/" allowed.`);
  }
  if (parts.length === 2) {
    const [engineer, agent] = parts;
    if (!SEGMENT_RE.test(engineer)) {
      throw new Error(`Invalid engineer segment "${engineer}" in "${name}": must match ${SEGMENT_RE}.`);
    }
    if (!SEGMENT_RE.test(agent)) {
      throw new Error(`Invalid agent segment "${agent}" in "${name}": must match ${SEGMENT_RE}.`);
    }
    return { engineer, agent };
  }
  if (!SEGMENT_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ${SEGMENT_RE}.`);
  }
  return { agent: name };
}

/**
 * Resolve the on-disk framework directory for an agent.
 * `frameworkRoot` is the cortextOS checkout (CTX_FRAMEWORK_ROOT).
 * `qualifiedName` is bare ("boss") or engineer-qualified ("aaron/dev").
 */
export function resolveAgentDir(frameworkRoot: string, org: string, qualifiedName: string): string {
  const { engineer, agent } = parseQualifiedName(qualifiedName);
  if (engineer) {
    return join(frameworkRoot, 'orgs', org, 'engineers', engineer, 'agents', agent);
  }
  return join(frameworkRoot, 'orgs', org, 'agents', agent);
}
