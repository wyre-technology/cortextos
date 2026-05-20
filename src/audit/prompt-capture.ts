/**
 * Prompt-capture gate.
 *
 * `request_log.tool_arguments` and `request_log.response_summary` are
 * populated only when:
 *   - the org's plan permits prompt capture (`canUsePromptCapture`)
 *   - AND the org admin has explicitly opted in
 *     (`organizations.prompt_capture_enabled = true`)
 *
 * Personal-scope calls (no orgId) do not capture — there's no org to gate on.
 *
 * The two checks are AND'd because plan-level allowance just unlocks the
 * feature; turning capture on is the org admin's deliberate choice.
 */
import type { BillingGate } from '../billing/gate.js';
import type { OrgService } from '../org/org-service.js';

const SUMMARY_LIMIT_BYTES = 8 * 1024; // 8 KB cap on response_summary

export async function shouldCapturePrompt(
  orgService: OrgService,
  billingGate: BillingGate,
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!orgId) return false;
  // Sequential, NOT Promise.all: these two checks each issue a DB query, and
  // on a request-path call they run on the request's single reserved-tx
  // connection. A Promise.all of service-method calls that each query that
  // connection stalls it — confirmed: this exact site hung every /v1/mcp
  // tools/call (TLDIAG localized the stuck await here). Awaiting in sequence
  // removes the concurrency; the cost is one extra round-trip on a gate
  // already off the hot path.
  const planAllows = await billingGate.canUsePromptCapture(orgId);
  const orgEnabled = await orgService.getPromptCaptureEnabled(orgId);
  return planAllows && orgEnabled;
}

/**
 * JSON-stringify and truncate a value for `response_summary`. Returns null
 * if the value is null/undefined or fails to stringify.
 */
export function summarizeResponse(value: unknown): string | null {
  if (value == null) return null;
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    return null;
  }
  if (s.length <= SUMMARY_LIMIT_BYTES) return s;
  return s.slice(0, SUMMARY_LIMIT_BYTES - 3) + '...';
}

/**
 * JSON-stringify tool arguments. Returns null when arguments are absent or
 * unstringifiable. No truncation — Postgres can hold a multi-MB JSONB
 * value, and arguments are typically small.
 */
export function captureArguments(args: unknown): string | null {
  if (args == null) return null;
  try {
    return JSON.stringify(args);
  } catch {
    return null;
  }
}
