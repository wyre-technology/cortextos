#!/usr/bin/env node
/**
 * a2a-send.cjs — INTERIM cortextOS-side A2A outbound dispatch (Stage-5 SEND).
 *
 * WHY THIS EXISTS (read before extending):
 *   The signing + transport SEND code already exists in the engineering team's
 *   `signed-agent-cards` package (lib/a2a-client.js: dispatch/ack/postSigned).
 *   Their inbound a2a-server runs per cortextOS instance (verify-only; no private
 *   key). What was missing is the cortextOS-side glue that LOADS this instance's
 *   card + private key, resolves a discovered peer, applies the local outbound
 *   trust policy, and calls their dispatch(). This file is exactly that glue —
 *   and nothing more. It IMPORTS signed-agent-cards by path; it does NOT modify
 *   that package.
 *
 * INTERIM / RECONCILE:
 *   `signed-agent-cards` has an in-flight official "Stage-5 cortextOS port".
 *   When that lands, ALIGN OR REPLACE this wrapper so we do not run two divergent
 *   SEND paths. Keep this file self-contained and removable.
 *
 * TRUST RULES (hard):
 *   - NEVER auto-add a peer to any trusted-peers.json. This wrapper only READS
 *     trust files; opening a trust gate is a human (Aaron) decision on the
 *     RECIPIENT instance.
 *   - Refuse to send to a peer we have not DISCOVERED (no verified card on disk),
 *     or that is listed in our denied-peers.
 *   - The recipient enforces its OWN trust of us; a send may still be 403'd there
 *     if it has not added our card. That is expected, surfaced, and not bypassed.
 *
 * USAGE (CLI):
 *   node a2a-send.cjs --peer <name> [--instance default] [--kind dispatch|ack]
 *        (--payload '<json>' | --payload-file <path> | payload on stdin) [--dry-run]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Where the engineering team's signed-agent-cards lib lives (matches the PM2
// ecosystem config's SAC_ROOT). Overridable for tests / relocations.
const DEFAULT_SAC_ROOT = process.env.SIGNED_AGENT_CARDS_ROOT
  || path.join(os.homedir(), 'work', 'asachs01', 'signed-agent-cards');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Names list from a {names:[...]} file; absent/malformed file = empty list.
function namesOf(file) {
  try {
    const j = readJson(file);
    return Array.isArray(j.names) ? j.names : [];
  } catch {
    return [];
  }
}

/**
 * Resolve this instance's private signing key.
 * Order: explicit arg -> $A2A_PRIVATE_KEY_FILE
 *        -> ~/.wyre/keys/cortext-boss-<instance>/private.jwk.json   (observed convention)
 *        -> ~/.wyre/keys/<card.name minus "-<host>" suffix>/private.jwk.json (derive)
 * Throws a clear error listing every path tried if none exist.
 */
function resolvePrivateKeyFile({ instance, senderCard, wyreKeysDir, explicit }) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.A2A_PRIVATE_KEY_FILE) candidates.push(process.env.A2A_PRIVATE_KEY_FILE);
  candidates.push(path.join(wyreKeysDir, `cortext-boss-${instance}`, 'private.jwk.json'));
  if (senderCard && senderCard.name && senderCard.host) {
    const derived = senderCard.name.replace(new RegExp(`-${senderCard.host}$`), '');
    candidates.push(path.join(wyreKeysDir, derived, 'private.jwk.json'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const err = new Error(
    `A2A private key not found. Tried:\n  ${candidates.join('\n  ')}\n`
    + `Set A2A_PRIVATE_KEY_FILE or place the key at `
    + `~/.wyre/keys/cortext-boss-${instance}/private.jwk.json`,
  );
  err.code = 'A2A_NO_PRIVATE_KEY';
  throw err;
}

/**
 * Send a signed A2A message to a discovered peer.
 * Path inputs default to the real cortextOS layout; tests inject temp dirs.
 * Returns { ok, status, kind, peer, peerName, address, sender, body }.
 */
async function sendA2A(opts = {}) {
  const {
    instance = 'default',
    peer,
    payload,
    kind = 'dispatch',
    dryRun = false,
    cortextosHome = path.join(os.homedir(), '.cortextos'),
    wyreKeysDir = path.join(os.homedir(), '.wyre', 'keys'),
    privateKeyFile,
    sacRoot = DEFAULT_SAC_ROOT,
    logger = console,
  } = opts;

  if (!peer) throw new Error('sendA2A: `peer` (peer name) is required');
  if (payload === undefined || payload === null) throw new Error('sendA2A: `payload` is required');
  if (kind !== 'dispatch' && kind !== 'ack') {
    throw new Error(`sendA2A: kind must be dispatch|ack, got '${kind}'`);
  }

  const instDir = path.join(cortextosHome, instance);

  // 1. Sender identity (this instance's signed card).
  const cardFile = path.join(instDir, 'agent-card.json');
  if (!fs.existsSync(cardFile)) throw new Error(`sender card not found: ${cardFile}`);
  const senderCard = readJson(cardFile);

  // 2. Peer must be DISCOVERED (a verified card on disk) — refuse strangers.
  const peerCardFile = path.join(instDir, 'discovered-peers', `${peer}.card.json`);
  if (!fs.existsSync(peerCardFile)) {
    throw new Error(
      `peer '${peer}' is not in discovered-peers (${peerCardFile}). `
      + `Discover + verify the peer's card first; refusing to send to an unknown peer.`,
    );
  }
  const peerCard = readJson(peerCardFile);
  const address = peerCard.address;
  if (!address) throw new Error(`discovered peer card '${peer}' has no address field`);

  // 3. Local outbound trust policy (READ-ONLY — never auto-add to any list).
  const denied = namesOf(path.join(instDir, 'denied-peers.json'));
  if (denied.includes(peer) || denied.includes(peerCard.name)) {
    throw new Error(`peer '${peer}' is in denied-peers (revoked). Refusing to send.`);
  }
  const trusted = namesOf(path.join(instDir, 'trusted-peers.json'));
  if (!(trusted.includes(peer) || trusted.includes(peerCard.name))) {
    // trusted-peers governs INBOUND acceptance; outbound is allowed but noted.
    logger.warn(
      `[a2a-send] note: '${peer}' is not in our trusted-peers (that list governs INBOUND). `
      + `Outbound send proceeds; the recipient still enforces its own trust of us.`,
    );
  }

  // 4. Signing key for this instance.
  const keyFile = resolvePrivateKeyFile({ instance, senderCard, wyreKeysDir, explicit: privateKeyFile });
  const senderPrivateJwk = readJson(keyFile);

  if (dryRun) {
    return { ok: true, dryRun: true, kind, peer, peerName: peerCard.name, address, sender: senderCard.name };
  }

  // 5. Dispatch via the engineering team's client (imported, never modified).
  const client = require(path.join(sacRoot, 'lib', 'a2a-client.js'));
  const fn = kind === 'ack' ? client.ack : client.dispatch;
  const result = await fn(address, payload, { senderCard, senderPrivateJwk });
  return {
    ok: result.ok,
    status: result.status,
    kind,
    peer,
    peerName: peerCard.name,
    address,
    sender: senderCard.name,
    body: result.body,
  };
}

// ----------------------------- CLI -----------------------------
function parseArgs(argv) {
  const a = { instance: 'default', kind: 'dispatch', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--instance': a.instance = argv[++i]; break;
      case '--peer': a.peer = argv[++i]; break;
      case '--kind': a.kind = argv[++i]; break;
      case '--payload': a.payloadRaw = argv[++i]; break;
      case '--payload-file': a.payloadFile = argv[++i]; break;
      case '--dry-run': a.dryRun = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.peer) {
    process.stderr.write(
      'usage: a2a-send.cjs --peer <name> [--instance default] [--kind dispatch|ack]\n'
      + "       (--payload '<json>' | --payload-file <path> | payload on stdin) [--dry-run]\n",
    );
    process.exit(a.peer ? 0 : 2);
  }
  let payloadStr = a.payloadRaw;
  if (!payloadStr && a.payloadFile) payloadStr = fs.readFileSync(a.payloadFile, 'utf8');
  if (!payloadStr) payloadStr = readStdin();
  if (!payloadStr || !payloadStr.trim()) {
    throw new Error('no payload (use --payload, --payload-file, or stdin)');
  }
  let payload;
  try { payload = JSON.parse(payloadStr); } catch (e) {
    throw new Error(`payload is not valid JSON: ${e.message}`);
  }

  const res = await sendA2A({
    instance: a.instance, peer: a.peer, kind: a.kind, dryRun: a.dryRun, payload,
  });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[a2a-send] ERROR: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { sendA2A, resolvePrivateKeyFile };
