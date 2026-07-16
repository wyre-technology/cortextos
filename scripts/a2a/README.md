# A2A outbound dispatch (cortextOS-side, INTERIM)

`a2a-send.cjs` is the cortextOS-side glue that completes the **Stage-5 SEND** side
of the wyre-a2a / `signed-agent-cards` protocol: it loads this instance's signed
card + private key, resolves a **discovered** peer, applies the local outbound
trust policy, and calls the engineering team's existing
`signed-agent-cards/lib/a2a-client.js` `dispatch()` / `ack()`.

It **imports** `signed-agent-cards` by path; it does **not** modify that package.

## INTERIM — reconcile when the official port lands

`signed-agent-cards` has an in-flight official "Stage-5 cortextOS port". When that
lands, **align or replace** this wrapper so we don't run two divergent SEND paths.
Keep it self-contained and removable.

## Trust rules (hard)

- **No auto-adds.** This wrapper only *reads* trust files. Opening a trust gate
  (adding a card to a `trusted-peers.json`) is a human (Aaron) decision on the
  **recipient** instance.
- Refuses to send to a peer that is not in `discovered-peers/` (no verified card),
  or that is listed in `denied-peers.json`.
- The recipient enforces its **own** trust of us — a send can still be `403`'d
  there if it hasn't added our card. That is expected and surfaced, not bypassed.

## Usage

```bash
# dry-run: resolve identity + peer + address, sign nothing, send nothing
node scripts/a2a/a2a-send.cjs --peer <peer-name> --payload '{"task":"hi"}' --dry-run

# live send (drops --dry-run); --instance defaults to "default", --kind to "dispatch"
node scripts/a2a/a2a-send.cjs --peer <peer-name> --payload '{"task":"hi"}'
echo '{"ack":true}' | node scripts/a2a/a2a-send.cjs --peer <peer-name> --kind ack
```

Paths: card `~/.cortextos/<instance>/agent-card.json`; private key
`~/.wyre/keys/cortext-boss-<instance>/private.jwk.json` (override with
`A2A_PRIVATE_KEY_FILE`); peer card
`~/.cortextos/<instance>/discovered-peers/<peer>.card.json`. `signed-agent-cards`
root overridable with `SIGNED_AGENT_CARDS_ROOT`.

## Test

```bash
node --test scripts/a2a/a2a-send.test.cjs
```

Standalone node:test — lives outside the product vitest include (`src/**` +
`docs/src/**`), so `npm test` does not pick it up.
