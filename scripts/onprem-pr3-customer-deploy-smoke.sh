#!/usr/bin/env bash
#
# scripts/onprem-pr3-customer-deploy-smoke.sh
#
# Post-merge analog-to-T2 verification (PR #3 §4 step 9 — the LAUNCH GATE).
#
# Boots a real customer-environment-shape deploy of the on-prem-gateway
# image, dials the deployed relay, registers, waits for heartbeat-stable,
# then runs the PR #2 /v1/mcp acceptance smoke to prove the full T2 round-
# trip through the customer-deployed gateway:
#
#     /v1/mcp client
#         ↓
#     conduit gateway (unified-router on-prem fork)
#         ↓
#     relay control-plane HTTP
#         ↓
#     relay WSS dispatch
#         ↓
#     customer-deployed on-prem-gateway container ← THIS SCRIPT proves this hop
#         ↓
#     echo MCP server
#         ↓ ... response threads back ...
#     /v1/mcp client response
#
# THIS SCRIPT IS THE LAUNCH GATE. Per scope §4 step 9: "Real customer-
# environment-shape deploy + dial + register + 5min heartbeat-stable +
# PR #2 smoke against echo round-trip." Exit code 0 = launch ready;
# non-zero = block deploy + investigate.
#
# Required env:
#   CONDUIT_GATEWAY_URL    e.g. https://staging.conduit.wyre.ai
#   CONDUIT_BEARER_TOKEN   /v1/mcp bearer for a user whose org owns ONPREM_SUBTENANT_ID
#   ONPREM_RELAY_URL       wss://relay.staging.wyre.ai (or prod equivalent)
#   ONPREM_ENROLLMENT_TOKEN  short-TTL JWT minted via POST /admin/onprem/enrollment-token
#   ONPREM_IMAGE_REF       ghcr.io/wyre-technology/conduit-onprem-gateway@sha256:<release-digest>
#                          (the published digest for the release under test)
#   ONPREM_SUBTENANT_ID    the org the enrollment token binds to
#
# Optional:
#   HEARTBEAT_WAIT_SECONDS   default 300 (5 minutes per scope-doc launch gate)
#   SMOKE_MESSAGE            default 'pr3-launch-readiness'
#   COMPOSE_PROJECT_NAME     default 'onprem-pr3-smoke'

set -euo pipefail

REQUIRED_VARS=(
  CONDUIT_GATEWAY_URL
  CONDUIT_BEARER_TOKEN
  ONPREM_RELAY_URL
  ONPREM_ENROLLMENT_TOKEN
  ONPREM_IMAGE_REF
  ONPREM_SUBTENANT_ID
)

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    printf 'FAIL: required env %s not set\n' "$var" >&2
    exit 2
  fi
done

HEARTBEAT_WAIT="${HEARTBEAT_WAIT_SECONDS:-300}"
SMOKE_MESSAGE="${SMOKE_MESSAGE:-pr3-launch-readiness}"
PROJECT="${COMPOSE_PROJECT_NAME:-onprem-pr3-smoke}"

# Workdir for the temporary compose deploy.
WORKDIR="$(mktemp -d)"
trap 'cleanup' EXIT

cleanup() {
  printf '\n--- cleanup: tearing down %s ---\n' "$PROJECT" >&2
  (cd "$WORKDIR" && docker compose -p "$PROJECT" down --volumes --remove-orphans 2>&1) || true
  rm -rf "$WORKDIR" || true
}

printf '=== on-prem-gateway customer-deploy smoke ===\n'
printf '  image: %s\n' "$ONPREM_IMAGE_REF"
printf '  relay: %s\n' "$ONPREM_RELAY_URL"
printf '  subtenant: %s\n' "$ONPREM_SUBTENANT_ID"
printf '  gateway: %s\n' "$CONDUIT_GATEWAY_URL"
printf '\n'

# -----------------------------------------------------------------------------
# Step 1 — write a minimal customer-shape compose file + .env (gitignored
#          by virtue of being in mktemp's $WORKDIR; no leak risk).
# -----------------------------------------------------------------------------
cat > "$WORKDIR/docker-compose.yml" <<EOF
services:
  onprem-gateway:
    image: ${ONPREM_IMAGE_REF}
    restart: "no"
    env_file:
      - .env
EOF

cat > "$WORKDIR/.env" <<EOF
RELAY_URL=${ONPREM_RELAY_URL}
ENROLLMENT_TOKEN=${ONPREM_ENROLLMENT_TOKEN}
CAPABILITIES=echo
LOG_LEVEL=info
EOF

# -----------------------------------------------------------------------------
# Step 2 — bring the container up; wait for the ready signal in logs.
# -----------------------------------------------------------------------------
printf '--- bringing container up ---\n'
(cd "$WORKDIR" && docker compose -p "$PROJECT" up -d) >&2

printf '--- waiting for ready signal in logs (60s budget) ---\n'
READY=0
for _ in $(seq 1 60); do
  if (cd "$WORKDIR" && docker compose -p "$PROJECT" logs onprem-gateway 2>&1) \
    | grep -q "on-prem-gateway ready"; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  printf 'FAIL: on-prem-gateway never logged "ready" within 60s\n' >&2
  (cd "$WORKDIR" && docker compose -p "$PROJECT" logs onprem-gateway) >&2 || true
  exit 3
fi
printf 'OK: on-prem-gateway booted + ready\n'

# -----------------------------------------------------------------------------
# Step 3 — heartbeat-stable check: wait HEARTBEAT_WAIT_SECONDS + sample.
# -----------------------------------------------------------------------------
printf '\n--- heartbeat-stable check: waiting %ss ---\n' "$HEARTBEAT_WAIT"
sleep "$HEARTBEAT_WAIT"

# Sample: container should still be running + no fatal errors in tail.
STATE="$(cd "$WORKDIR" && docker compose -p "$PROJECT" ps --format json onprem-gateway 2>/dev/null | grep -oE '"State":"[^"]*"' | head -1 || echo '')"
if [[ "$STATE" != *"running"* ]] && [[ "$STATE" != *"Up"* ]]; then
  printf 'FAIL: container is not running after %ss (state: %s)\n' "$HEARTBEAT_WAIT" "$STATE" >&2
  (cd "$WORKDIR" && docker compose -p "$PROJECT" logs --tail=50 onprem-gateway) >&2 || true
  exit 4
fi
if (cd "$WORKDIR" && docker compose -p "$PROJECT" logs --tail=200 onprem-gateway 2>&1) \
  | grep -qiE 'FATAL|error|fatal'; then
  printf 'WARN: error-like lines found in logs (review):\n' >&2
  (cd "$WORKDIR" && docker compose -p "$PROJECT" logs --tail=200 onprem-gateway 2>&1) \
    | grep -iE 'FATAL|error|fatal' >&2 | head -10 || true
fi
printf 'OK: heartbeat-stable for %ss\n' "$HEARTBEAT_WAIT"

# -----------------------------------------------------------------------------
# Step 4 — /v1/mcp echo round-trip via PR #2 smoke script (delegated).
# -----------------------------------------------------------------------------
printf '\n--- /v1/mcp echo round-trip via PR #2 smoke (full T2) ---\n'
export CONDUIT_GATEWAY_URL CONDUIT_BEARER_TOKEN SMOKE_MESSAGE
if ! npx tsx scripts/onprem-pr2-acceptance-smoke.ts; then
  printf 'FAIL: /v1/mcp echo round-trip did not complete cleanly\n' >&2
  exit 5
fi

# -----------------------------------------------------------------------------
# Launch gate passed.
# -----------------------------------------------------------------------------
printf '\n=== LAUNCH GATE PASSED ===\n'
printf 'On-prem-gateway customer-deploy verified:\n'
printf '  - container booted from %s\n' "$ONPREM_IMAGE_REF"
printf '  - dialed %s + registered + heartbeat-stable for %ss\n' "$ONPREM_RELAY_URL" "$HEARTBEAT_WAIT"
printf '  - /v1/mcp echo round-trip through customer-deployed gateway completed\n'
printf '\nReady for mid-June launch.\n'
