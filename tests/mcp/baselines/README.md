# MCP tool-surface baselines

Snapshots of the `tools/list` JSON-RPC response from the conduit MCP gateway,
captured per-env. These are the surface-of-record that
`scripts/mcp-tool-surface-check.ts` diffs against on every CI run to detect
vendor-MCP regressions (a tool disappearing, a vendor going dark, a routing
rule dropping the surface).

## Files

- `staging-tools.json` — snapshot of `https://staging.conduit.wyre.ai/v1/mcp`
  via the `Cortext Boss Agent` service-client. Captured 2026-06-09 by boss
  during the credential-mint validation. 459 tools across 8 vendors.

## Refreshing a baseline

When an intentional vendor change ships (new tools, removed tools, vendor
added), refresh the baseline so CI passes again:

```bash
# Get a token, fetch the live surface, and write the new baseline.
TOKEN=$(curl -sS -X POST "$CONDUIT_GATEWAY_URL/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CONDUIT_CLIENT_ID&client_secret=$CONDUIT_CLIENT_SECRET" \
  | jq -r '.access_token')

curl -sS -X POST "$CONDUIT_GATEWAY_URL/v1/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '{
      captured_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
      env: "staging",
      gateway: env.CONDUIT_GATEWAY_URL,
      total_tools: (.result.tools | length),
      vendors: (.result.tools
        | group_by(.name | split("__")[0])
        | map({vendor: .[0].name | split("__")[0], count: length, tools: (map(.name | split("__")[1]) | sort)}))
        | sort_by(.vendor)
    }' > tests/mcp/baselines/staging-tools.json
```

Then commit the updated baseline with the PR that introduced the intentional
change. The PR description should call out the surface delta (added/removed
tools, vendor changes) so reviewers see what the customer-facing impact is.

## What constitutes "drift" vs intentional

By default the script fails on ANY of: vendor added, vendor removed, tool
removed from a known vendor, tool added to a known vendor, total-count
mismatch. Set `ALLOW_NEW_TOOLS=1` in the CI workflow on schedule-fire (vs
PR-fire) to flag-but-not-fail new tools — schedule runs are meant to detect
silent vendor releases, not block the build on them.
