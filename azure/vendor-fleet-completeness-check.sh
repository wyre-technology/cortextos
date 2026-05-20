#!/usr/bin/env bash
#
# conduit-prod vendor-fleet COMPLETENESS GATE — option-a Piece 1 acceptance.
#
# An incomplete vendor fleet is a customer-facing failure: the conduit-prod
# gateway resolves a connectable vendor's internal containerUrl, the
# `<slug>-mcp` container does not exist, the fetch fails, and the customer
# sees "Tool discovery failed: fetch failed" on the Tool Access page (observed
# on staging, 2026-05-20). This gate turns that failure mode into a deploy-time
# assertion: it FAILS if any connectable sidecar vendor lacks a healthy
# container in conduit-prod-env.
#
# THE TARGET SET is PARSED from src/credentials/vendor-config.ts — every
# vendor whose containerUrl is `http://<slug>-mcp:8080` (the internal-sidecar
# vendors; the external-hosted ones need no container). Parsing the actual
# vendor entries (not text-grepping the file) keeps the gate honest: a new
# sidecar vendor added to the catalog but not to the fleet is caught here.
#
# Run after a vendor-fleet deploy. Exit 0 = complete; non-zero = a gap.
#
# Usage:  azure/vendor-fleet-completeness-check.sh [resource-group]
#   default resource-group: rg-conduit-prod
#   requires: az (logged in), the conduit repo checked out (for vendor-config.ts)

set -euo pipefail

RG="${1:-rg-conduit-prod}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_CONFIG="${REPO_ROOT}/src/credentials/vendor-config.ts"

[ -f "$VENDOR_CONFIG" ] || { echo "ERROR: vendor-config.ts not found at $VENDOR_CONFIG" >&2; exit 2; }

# Expected set: vendor-config.ts entries with an internal-sidecar containerUrl
# (http://<slug>-mcp:8080).
#
# Derived by PARSING the vendor-config structure — NOT a text grep. A grep over
# the source file matches `http://<slug>-mcp:8080` strings wherever they appear,
# including comments and docstrings (an early draft of this gate did exactly
# that and over-counted to a phantom 42). The parser below splits the file on
# actual vendor-entry boundaries (`\n  <slug>: {`) and reads each entry's own
# `containerUrl` field — so only real entries count.
EXPECTED=$(python3 - "$VENDOR_CONFIG" <<'PYEOF'
import re, sys
src = open(sys.argv[1]).read()
# Split on vendor-entry boundaries: a 2-space-indented `<slug>: {`.
parts = re.split(r'\n  ([A-Za-z][A-Za-z0-9_-]*): \{', src)
for i in range(1, len(parts), 2):
    slug, body = parts[i], parts[i + 1]
    m = re.search(r"containerUrl:\s*'([^']*)'", body)  # the entry's own field
    if m and m.group(1).startswith('http://') and m.group(1).endswith('-mcp:8080'):
        print(slug)
PYEOF
)
EXPECTED=$(echo "$EXPECTED" | sort -u)
EXPECTED_COUNT=$(echo "$EXPECTED" | grep -c . || true)

echo "conduit-prod vendor-fleet completeness gate"
echo "  resource group:       $RG"
echo "  expected sidecar set: $EXPECTED_COUNT vendors (from vendor-config.ts)"
echo

# The live container apps in the RG.
LIVE=$(az containerapp list --resource-group "$RG" --query '[].name' -o tsv)

missing=()
unhealthy=()
ok=0
while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  app="${slug}-mcp"
  if ! echo "$LIVE" | grep -qx "$app"; then
    missing+=("$app")
    continue
  fi
  # Provisioned + a running replica = healthy enough to serve discovery.
  prov=$(az containerapp show -n "$app" -g "$RG" --query 'properties.provisioningState' -o tsv 2>/dev/null || echo "?")
  running=$(az containerapp replica list -n "$app" -g "$RG" \
    --query "length([?properties.runningState=='Running'])" -o tsv 2>/dev/null || echo 0)
  if [ "$prov" != "Succeeded" ] || [ "${running:-0}" -lt 1 ]; then
    unhealthy+=("$app (provisioning=$prov, runningReplicas=${running:-0})")
  else
    ok=$((ok + 1))
  fi
done <<< "$EXPECTED"

echo "  healthy:   $ok / $EXPECTED_COUNT"
[ ${#missing[@]} -gt 0 ]   && { echo "  MISSING:   ${missing[*]}"; }
[ ${#unhealthy[@]} -gt 0 ] && { echo "  UNHEALTHY: ${unhealthy[*]}"; }
echo

if [ ${#missing[@]} -eq 0 ] && [ ${#unhealthy[@]} -eq 0 ]; then
  echo "GATE PASS — every connectable sidecar vendor has a healthy container in $RG."
  exit 0
fi
echo "GATE FAIL — option-a acceptance NOT met: $(( ${#missing[@]} + ${#unhealthy[@]} )) vendor(s) would 'fetch failed' on Tool Access." >&2
exit 1

# DEEPER PROBE (optional, not in the gate's exit path): the checks above catch
# "missing" and "not running" — the two failure modes behind "fetch failed".
# A deeper per-vendor MCP probe (POST /mcp tools/list to each <slug>-mcp) must
# run from INSIDE conduit-prod-env (internal ingress) — the gws-itglue /
# gws-rocketcyber B-minimal probe-job pattern. Run it as a one-shot ACA job in
# conduit-prod-env if a vendor is healthy-but-not-serving-MCP is suspected.
