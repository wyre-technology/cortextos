# WYRE cortextOS — SP3b: Slack Socket Mode inbound

- **Status:** Draft for review
- **Date:** 2026-06-04
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — SP3 sub-slice 3b
- **Parent spec:** [`2026-06-02-wyre-cortextos-sp3-slack-design.md`](2026-06-02-wyre-cortextos-sp3-slack-design.md)

## Context

SP3a shipped (v0.5.0): agents can post to Slack channels via
`cortextos slack test-send` and `bus/send-slack.sh`, with per-agent identity
(`display_name`, `icon_emoji`) read from each agent's `slack.json`. The Slack
app `WYRE Agents` is registered, installed, and posting to `#general` as `boss`.

SP3b adds the inbound half: a persistent Socket Mode websocket connects from
the daemon out to Slack, receives `message` events, resolves which agent should
handle each one, and pushes the formatted message into the agent's existing
Claude IPC channel — the same channel `src/telegram/poller.ts` already feeds.

The asymmetry vs Telegram is deliberate. Telegram is one bot per agent, so each
agent owns its poller and its routing is implicit. Slack is one bot for the
whole installation, so the WS lives at the daemon level and the daemon fans
inbound events to the right agent. The agents themselves don't change.

## Goal

After SP3b, **a team member can address an agent in a Slack channel the bot is
invited to and get a reply.** Concretely:

- `boss: morning recap?` in `#agents-recap` → `boss` receives the message,
  processes it, replies (using SP3a outbound).
- A thread-reply to any message `boss` posted → routes back to `boss` with no
  prefix needed.
- A message in a channel that is not in any agent's `allowed_channels` → silently
  dropped, no side effects, no error to the user.
- The Socket Mode connection survives daemon restarts and Slack-side
  disconnects with exponential backoff up to 5 minutes.

SP3c then layers interactive Block Kit hooks (Approve/Deny buttons, threaded
ask, crash-alert) on top of this.

## Decisions locked (from brainstorming)

1. **Daemon owns the WS.** `src/slack/socket-mode.ts` runs in-process under
   `src/daemon/index.ts`. There is no `cortextos-slack-gateway` process. The
   daemon already owns shared infrastructure (cron scheduler, IPC server);
   Slack joins that list. Lifecycle: started in `Daemon.start()` after agents
   are loaded, stopped in `Daemon.stop()` before agents are stopped.

2. **Explicit addressing for new top-level messages.** A message in a channel
   that one or more agents have in `allowed_channels` is delivered to an agent
   only if the message text starts with `<agent-display-name>:` or `@<agent-display-name>`
   (case-insensitive). Unaddressed messages are dropped with a debug log. The
   agent display name comes from `slack.json#display_name`. `@WYRE Agents`
   (the bot identity itself) alone is never enough — there is no implicit
   default agent at the addressing layer.

3. **Persistent thread-ownership index.** When any agent posts via SP3a, the
   send path appends a record to
   `~/.cortextos/<instance>/slack-threads.jsonl`:
   `{"channel": "C...", "thread_ts": "171...", "agent": "wyre/boss", "ts": <unix-ms>}`.
   Inbound events with `thread_ts` look up the owner; lookup hit → deliver to
   that agent regardless of addressing or `allowed_channels` membership.
   Lookup miss → fall back to the addressing rules in (2). Stale owner
   (agent no longer running) → drop with a warn log.

   Storage is append-only JSONL for simplicity; an in-memory map is rebuilt at
   daemon startup by reading the file. Compaction is a future concern — at
   anticipated team volumes (single-digit threads per day) the file stays under
   a megabyte for years.

4. **Delivery into the agent reuses `sendToAgent`.** The daemon formats the
   Slack event into a single line and pushes it through the same IPC channel
   `agent-manager` already uses for Telegram. The agent's Claude sees:

       [slack channel=C01XXXX user=@aaron thread=171234567.890123] expand on point 3

   for thread replies, or:

       [slack channel=C01XXXX user=@aaron] boss: morning recap?

   for new top-level messages. The inline `channel=` / `thread=` / `user=`
   tokens give the agent everything it needs to craft a Slack reply (the
   `bus/send-slack.sh` entry point from SP3a takes `channel` as an argument;
   `thread_ts` becomes a new `--thread-ts` flag added in this slice).

5. **One Slack app for the whole installation.** Engineers writing agents
   never create a Slack app; they only configure `slack.json` and push.
   Adapter development (currently only Aaron) uses a separate personal
   `WYRE Agents — dev` app whose tokens live on the developer's laptop, never
   on the prod VM. This keeps prod Slack inbound undisturbed during
   adapter work.

## Architecture

```
                              WYRE Slack workspace
                                    │
                                    │ Socket Mode WS
                                    │ (outbound from VM,
                                    │  zero public ingress)
                                    ▼
┌── Azure VM ─────────────────────────────────────────────────────────┐
│                                                                     │
│  cortextos-daemon (PM2)                                             │
│    ├─ src/slack/socket-mode.ts    persistent WS + reconnect         │
│    │     ├─ apps.connections.open → wss URL                         │
│    │     ├─ frame dispatcher: hello, disconnect, events_api         │
│    │     └─ ack envelope per Slack spec                             │
│    │                                                                │
│    ├─ src/slack/router.ts         channel + thread → agent          │
│    │     ├─ loadAllowedChannelsMap()  (from each slack.json)        │
│    │     ├─ resolveAddressing(text, agents)                         │
│    │     └─ resolveThread(channel, thread_ts) via thread index      │
│    │                                                                │
│    ├─ src/slack/threads.ts        append + load JSONL index         │
│    │     ├─ recordThread(channel, thread_ts, agent)                 │
│    │     ├─ lookupThread(channel, thread_ts) -> agent | null        │
│    │     └─ load() at startup                                       │
│    │                                                                │
│    └─ src/daemon/index.ts wires socket-mode in, hands resolved      │
│       events to agent-manager.sendToAgent(qualifiedName, text)      │
│                                                                     │
│  /etc/cortextos.env (cloud-init pulls from KV):                     │
│    SLACK_BOT_TOKEN       (existing, SP3a)                           │
│    SLACK_APP_TOKEN       (new, SP3b — xapp-*** app-level token)     │
│                                                                     │
│  ~/.cortextos/<instance>/slack-threads.jsonl                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## File structure

**New files:**

- `src/slack/socket-mode.ts` — WS client. Opens the connection via
  `apps.connections.open`, handles `hello`/`disconnect`/`events_api` frames,
  acks each envelope, exponential reconnect (1s → 2s → 4s → … cap 5min,
  reset on successful `hello`). Exposes `start()`, `stop()`, and
  `onEvent(handler)`.
- `src/slack/router.ts` — Pure routing logic. Two functions:
  `resolveByThread(channel, thread_ts, agents)` and
  `resolveByAddressing(channel, text, agents)`. Returns `{ agent, strippedText } | null`.
  No I/O, fully unit-testable.
- `src/slack/threads.ts` — Thread index. `record()`, `lookup()`, `load()`.
  Backed by JSONL at `~/.cortextos/<instance>/slack-threads.jsonl`.
- `tests/unit/slack/socket-mode.test.ts`
- `tests/unit/slack/router.test.ts`
- `tests/unit/slack/threads.test.ts`

**Modified:**

- `src/slack/api.ts` — `postMessage` gains a `thread_ts` parameter (already
  supported by Slack; we just plumb it through) and on success calls
  `threads.record()` so any outbound from any path populates the index.
- `src/slack/index.ts` — barrel adds `SocketModeClient`, `resolveByThread`,
  `resolveByAddressing`, `recordThread`, `lookupThread`.
- `src/cli/slack.ts` — `test-send` gains `--thread-ts <ts>` flag.
- `bus/send-slack.sh` — accepts optional 4th positional arg `thread_ts` and
  passes it through to the CLI as `--thread-ts`.
- `src/daemon/index.ts` — instantiates `SocketModeClient` in `start()`,
  wires its `onEvent` to a handler that calls into `router` and then
  `agentManager.sendToAgent`. Stops it in `stop()`.
- `src/daemon/agent-manager.ts` — minor: a getter that returns the current
  agents' `slack.json` data so the router can consult `allowed_channels` /
  `display_name` for live agents only (stale-thread-owner detection).
- `infra/terraform/cloud-init.yaml.tftpl` — fetch `slack-app-token` from KV
  alongside the existing `slack-bot-token` and write to `/etc/cortextos.env`.
- `docs/runbook/sp3a-slack-app-setup.md` — extend with the SP3b additions:
  enable Socket Mode in the app, create the app-level token, store as
  `slack-app-token` in KV. Section is **additive** — the SP3a steps stay
  intact.

**Not modified:** `src/telegram/*` (untouched, parallel adapter).

## Inbound flow (end-to-end)

1. Team member posts `boss: how are things?` in `#agents-recap`.
2. Slack pushes an `events_api` envelope to our Socket Mode WS.
3. `SocketModeClient` acks the envelope and emits the inner `event` to its
   handler.
4. Daemon's handler:
   a. Extracts `channel`, `ts`, `thread_ts`, `user`, `text`.
   b. If `thread_ts && thread_ts !== ts` (i.e. it's a reply, not a parent),
      ask `router.resolveByThread`. Hit → deliver, done.
   c. Else, `router.resolveByAddressing` — walks live agents, finds one whose
      `slack.json#display_name` matches the prefix and whose `allowed_channels`
      includes `channel`. Hit → strip the prefix, deliver. No hit → drop with
      debug log.
5. `agent-manager.sendToAgent(qualifiedName, formattedText)` writes to the
   agent's Claude PTY stdin.
6. Agent processes the message, calls `bus/send-slack.sh <agent> <channel> <text> <thread_ts>`,
   reply lands in the same thread under the agent's display name. The send
   path records the new `(channel, thread_ts, agent)` tuple in the thread
   index, so subsequent thread replies route back to this agent without
   addressing.

## Reconnect strategy

Mirrors `src/telegram/poller.ts`:

- Connection backoff starts at 1s, doubles on each consecutive failure, caps at
  300s (5 min). Successful `hello` frame resets the backoff to 1s.
- `disconnect` frames from Slack (type `warning` or `refresh_requested`) are
  graceful — we close the current WS and immediately open a new one via a fresh
  `apps.connections.open` call (no backoff). Slack uses this to rotate
  endpoints; treating it as an error would be wrong.
- Network-level WS errors and unexpected close frames go through the backoff
  path.
- Health: log a structured `slack.socket.connected` / `slack.socket.disconnected`
  event on each transition. SP3c or a later observability slice can hook
  metrics here.

## Authorization model

- **Channel allowlist enforcement is intrinsic to routing**, not a separate
  check. An agent receives a message only if (a) its `allowed_channels`
  includes the channel — via addressing match — or (b) the message is a reply
  to a thread it owns. There is no "drop after deliver" path.
- The bot itself is in only the channels Slack invited it to. Slack will not
  deliver events from channels the bot isn't in. The `allowed_channels`
  allowlist is the *application-level* layer on top — an agent may not want
  to receive from every channel the bot is in.

## Definition of done — SP3b

- Daemon starts with both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` set, opens
  a Socket Mode WS, logs `slack.socket.connected`.
- `boss: ping` posted in `#general` (in `boss`'s `allowed_channels`) by a real
  workspace user reaches `boss`'s Claude via the IPC channel.
- Posting just `ping` (no prefix) in the same channel produces no IPC event
  and a debug log line.
- A reply in any thread `boss` posted reaches `boss` without addressing.
- A message in a channel not in any agent's `allowed_channels` produces no
  IPC event.
- Forcibly closing the WS (e.g. `pkill -f cloudflared` to simulate a network
  blip, or `iptables` drop) results in reconnect within 5 min with exponential
  backoff; messages sent during the outage are delivered after reconnect (Slack
  buffers Socket Mode envelopes briefly).
- Daemon restart preserves the thread index (file persists, in-memory map
  rebuilt at startup) — verified by posting a thread reply after restart and
  observing it route to the correct agent.
- Personal-namespace agents (`engineers/aaron/agents/dev`) continue working on
  Telegram unaffected.
- Unit tests for `router.ts` (addressing strip, allowlist intersection, case
  insensitivity, no-match), `threads.ts` (record, lookup, load, missing-file),
  and `socket-mode.ts` (frame dispatch — WS itself mocked).
- CHANGELOG updated; tag `v0.6.0`.

## Risks & open questions

- **Socket Mode reliability.** Slack's Socket Mode historically has had
  flakier uptime than HTTP webhook events. Mitigation: aggressive reconnect
  (above) and structured log events so we can build a dashboard later.
- **Multiple Socket Mode connections per app.** Slack round-robins envelopes
  across all open sockets for a given app. If the dev app collides with prod
  (shouldn't, since they're separate apps), inbound silently splits. Mitigation:
  one app per environment — already locked.
- **Thread index growth.** JSONL append-only grows forever. At single-digit
  threads/day, this is years of headroom. A compaction tool (`cortextos slack
  compact-threads --older-than 90d`) is a future slice, not SP3b.
- **Display-name collisions.** If two agents in different orgs both have
  `display_name: "boss"`, addressing is ambiguous. Routing is org-aware
  (an agent's `org` is part of its qualified name), but Slack messages aren't.
  Mitigation for SP3b: the daemon's addressing resolver only considers the
  *current org's* agents (the daemon already runs scoped to one org via
  `CTX_ORG`). Cross-org name collisions become a problem only when SP4 wires
  up multiple orgs on one host — out of scope here.
- **App-level token rotation.** Same pattern as bot token: rotate in Slack
  dashboard → update KV → restart daemon. Runbook addition covers this.
- **Channel rename.** Slack channel IDs are stable across renames, so the
  `allowed_channels` (IDs, not names) and the thread index are unaffected.
  Display-only consequence: log lines show the old channel name until daemon
  restart refreshes the conversation cache (we don't cache one yet — names
  in logs come from the event payload).

## Non-goals (deferred)

- **Interactive Block Kit hooks.** SP3c.
- **DM-to-agent routing.** Direct messages from an engineer to the bot
  (`im` channels) are technically receivable by Socket Mode but aren't
  routed in SP3b. SP3c or SP4 decides.
- **Reactions, file uploads, edits.** Only `message` events are subscribed.
  `reaction_added`, `file_shared`, `message_changed` are not.
- **Per-channel-type addressing rules.** Same addressing convention applies
  uniformly.
- **Inbound rate limiting.** No throttle on incoming events — Slack already
  rate-limits the workspace; if a user spams, the agent's Claude is the
  backpressure.
- **Cross-org routing on a single daemon.** A daemon runs scoped to one
  `CTX_ORG`; multi-org-per-host is a future-initiative concern.
- **Replacing Telegram.** Stays as the personal/mobile path.

## Spec self-review

- **Placeholder scan:** None. Channel IDs in examples are illustrative (`C01XXXX`)
  as in the parent SP3 spec; concrete IDs land in the runbook during smoke
  test.
- **Internal consistency:** The five locked decisions, the architecture
  diagram, the file structure, and the inbound flow all reference the same
  components (`socket-mode.ts`, `router.ts`, `threads.ts`) and the same data
  shapes (`slack.json` with `display_name` + `allowed_channels`, JSONL thread
  index records). The addressing rule and the thread-lookup rule compose
  cleanly: thread first, addressing as fallback.
- **Scope:** SP3b is a single-implementation-plan slice. No further
  decomposition. The natural successor is SP3c (interactive hooks).
- **Ambiguity check:** "Addressing" is defined as a literal prefix match on
  `display_name:` or `@display_name` at the start of the message, case-
  insensitive, whitespace-tolerant. Threading is defined precisely as
  `thread_ts && thread_ts !== ts`. No other text patterns trigger routing.
