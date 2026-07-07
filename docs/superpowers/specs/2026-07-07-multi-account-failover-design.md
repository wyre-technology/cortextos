# Multi-Account Failover for cortextOS

**Date:** 2026-07-07
**Status:** Approved (design review with Aaron, 2026-07-07)
**Origin:** 2026-07-06 fleet outage — the shared subscription hit its weekly
usage limit and every agent session died silently at the limit banner while
the daemon, crons, and Telegram plumbing stayed green. Post-incident, a
credential split-brain (fleet reads `~/.claude/.credentials.json`, interactive
shells read the macOS Keychain) caused a second silent outage after an
account re-login. This design removes both failure classes.

## Goal

When the active Claude account hits its weekly usage limit, the fleet fails
over to the next healthy account automatically, tells the operator once, and
drains back to the preferred account after the limit resets. When *no*
account is healthy, the fleet parks loudly instead of dying quietly.

## Requirements (from design review)

- **Failover model** — whole fleet prefers one account at a time; no load
  balancing or per-agent tiering in v1.
- **Account pool** — ordered list of named accounts; ships with 2, adding
  more is a config edit, not a code change.
- **All-exhausted floor** — park + single Telegram alert + auto-resume at
  the earliest reset time. Inbound work queues in the existing inbox.
- **Drain-back** — lazy: each agent returns to the preferred account at its
  next natural session event (scheduled refresh or restart). No mass respawn.
- **Auth mechanism** — one long-lived OAuth token per account (from
  `claude setup-token`), injected per-spawn as `CLAUDE_CODE_OAUTH_TOKEN`.
  Env tokens take precedence over the credentials file, which also eliminates
  the Keychain/file split-brain permanently.

## Architecture

One new module: `src/daemon/account-manager.ts` (`AccountManager`).
Instantiated once per daemon process, passed to each `AgentProcess`.

Responsibilities:

1. **Account list** — ordered preference, from config.
2. **Health map** — per-account status, persisted to a shared state file.
3. **Selection** — `selectAccount(accounts, health, now)` returns the token
   to use for the next spawn, or `null` if nothing is healthy.

Existing seams it plugs into (no new processes, no external watchers):

- `AgentPTY.onData` → `OutputBuffer` (`src/pty/agent-pty.ts:157`) — detection.
- `AgentProcess.sessionRefresh()` (`src/daemon/agent-process.ts:301`) —
  marker-protected stop/start that resumes with `--continue`; the switch
  mechanism. Failover writes its own reason into the `.session-refresh`
  marker so the SessionEnd crash-alert hook stays quiet.
- `AgentPTY.getBaseEnv()` allowlist — already passes
  `CLAUDE_CODE_OAUTH_TOKEN` (commit `fd6806b`); per-agent injection sets it
  explicitly in the PTY env at spawn.
- `TelegramAPI` (already held by `AgentProcess`) — operator alerts.

## Config and token storage

- **Account order:** `~/.cortextos/shared/accounts.json` — ordered array of
  account names, e.g. `["wyretech", "personal"]`.
- **Tokens:** Infisical, keyed `CLAUDE_OAUTH_TOKEN_<NAME>` (uppercased
  account name), fetched via `cortex-secret` at daemon boot, held in memory.
- **Offline cache:** on each successful fetch, mirror to a chmod-600 file
  (`~/.cortextos/shared/.account-tokens.cache`) so a boot with Infisical
  unreachable still works. Never committed; lives outside any repo tree.

## Shared health state

`~/.cortextos/shared/account-health.json`:

```json
{
  "wyretech":  { "status": "limited", "limitedUntil": "2026-07-12T02:00:00Z", "lastError": "weekly limit banner" },
  "personal":  { "status": "healthy" }
}
```

- Statuses: `healthy` | `limited` (with `limitedUntil`) | `invalid`
  (auth-broken; requires operator action to clear).
- Atomic writes (tmp + rename); re-read before every selection.
- Shared across daemon instances (default + wyre-gateway) so a limit
  discovered by one instance is known to the other without burning a session.
- Transitions are idempotent; last-writer-wins is acceptable.

## Detection

A matcher on the ANSI-stripped PTY output stream, for two signatures
captured verbatim during the 2026-07-06/07 incident (kept as test fixtures):

| Signature | Transition | Notes |
|---|---|---|
| `You've hit your weekly limit · resets <date> (UTC)` | → `limited` | Parse the reset date → `limitedUntil`. Parse failure → fallback cooldown of 6 h. |
| `Not logged in · Please run /login` | → `invalid` | Token revoked/expired. Distinct operator alert; not auto-cleared. |

Debounced: the first detection transitions the account fleet-wide; subsequent
detections while already `limited`/`invalid` are no-ops.

## Switch mechanics

- **On limit detect:** mark account in health file → every agent currently
  on that account gets `sessionRefresh()` scheduled with 0–120 s random
  jitter (prevents the 429 boot storm observed 2026-07-07 when ~18 Opus
  sessions spawned simultaneously).
- **On every spawn/refresh:** `AgentProcess.start()` calls
  `selectAccount()` and sets `CLAUDE_CODE_OAUTH_TOKEN` in the PTY env.
- **Drain-back is emergent, not coded:** because selection runs at every
  natural session event against fresh health state, agents return to the
  preferred account automatically once its `limitedUntil` passes. Initial
  assignment, failover, and drain-back are one code path.

## Parking (all accounts exhausted)

- `selectAccount()` returns `null` → agent enters `parked` status instead of
  spawning a doomed session.
- Inbound Telegram/bus messages accumulate in the existing inbox files; the
  session-continuation prompt already instructs agents to check inbox on wake.
- One fleet-wide Telegram alert on park (includes earliest reset time), one
  on resume. Alert dedup via a flag in the shared health file.
- Resume timer fires at the earliest `limitedUntil` (+ jitter). Because
  `limitedUntil` is persisted, parking survives daemon restarts.

## Failure handling

Every "can't decide" path degrades to pre-failover behavior **plus a
notification** — never a silent stall.

| Failure | Behavior |
|---|---|
| Reset-time parse fails | `limited` with 6 h cooldown; alert mentions the parse failure. |
| Token fetch fails at boot | Fall back to cache file; if absent, run with whichever accounts have tokens; alert lists the missing ones. |
| Health file corrupt/unreadable | Fail open: treat all accounts healthy, rewrite fresh file, alert. |
| Zero accounts configured | Spawn with no token env (today's behavior: file/keychain credentials), log a warning. |

## Testing

- **Unit:** banner regex + reset-time parser against real captured log
  fixtures; `selectAccount()` policy table (healthy-first, limited-skipped,
  `invalid`-skipped, all-dead → null, drain-back after reset).
- **Integration:** `CTX_DEBUG_FAKE_LIMIT_BANNER` env flag (same pattern as
  the existing `CTX_DEBUG_ALLOW_CRASH_TRIGGER`) injects the banner into an
  agent's OutputBuffer in a test instance; assert health transition, jittered
  refresh, new token in PTY env, Telegram alert, and drain-back.
- **Manual acceptance:** set one account's token to garbage → observe
  `invalid` transition + alert; park fleet with both accounts marked limited
  → observe park alert + inbox accumulation + timed resume.

## Out of scope (v1)

- Dashboard visualization of account health.
- Proactive spend tracking / switching before the banner appears.
- Per-agent account tiering (boss on healthiest account).
- Codex/Hermes runtimes (`CodexAppServerPTY`, `HermesPTY`) — Claude PTYs only.

## Prerequisites and open items

1. **Mint tokens** — Aaron runs `claude setup-token` once per account and
   stores each in Infisical (`CLAUDE_OAUTH_TOKEN_WYRETECH`,
   `CLAUDE_OAUTH_TOKEN_PERSONAL`). Not yet done as of this writing; the fleet
   currently runs on a fragile copied-credentials bridge.
2. **`selectAccount()` implementation is reserved for Aaron** — the policy
   function (preference order vs. near-reset tolerance, `invalid` handling)
   is deliberately his contribution during implementation.
3. Policy note: this pools weekly caps across accounts the operator
   personally owns and pays for. Revisit if Anthropic tightens multi-account
   usage policy.
