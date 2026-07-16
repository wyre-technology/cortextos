'use strict';

// node:test (NOT vitest) — this standalone .cjs unit lives outside the product's
// vitest include (src/** + docs/src/**), so it will not be picked up by `npm test`.
// Run:  node --test scripts/a2a/a2a-send.test.cjs
// Requires the engineering team's signed-agent-cards lib (read-only) for fixtures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAC = process.env.SIGNED_AGENT_CARDS_ROOT
  || path.join(os.homedir(), 'work', 'asachs01', 'signed-agent-cards');
const { generateKeypair } = require(path.join(SAC, 'lib', 'keys'));
const { signCard } = require(path.join(SAC, 'lib', 'agent-card'));
const { startServer } = require(path.join(SAC, 'lib', 'a2a-server'));

const { sendA2A } = require('./a2a-send.cjs');

const INSTANCE = 'testinst';
const SENDER_NAME = `cortext-boss-${INSTANCE}-testhost`;
const PEER_NAME = 'test-peer';
const QUIET = { info() {}, warn() {}, error() {} };

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// Stand up a recipient a2a-server + the temp cortextOS-side layout the wrapper reads.
async function fixture({ trustSender = true } = {}) {
  const root = generateKeypair();
  const me = generateKeypair();    // sender (this instance)
  const peer = generateKeypair();  // recipient
  const expires = new Date(Date.now() + 86400 * 1000).toISOString();
  const mkCard = (name, host, address, pub) => signCard(
    { name, owner: 'test@wyre.ai', host, address, pubkey: pub, capabilities: ['a2a:dispatch:v1'], expires_at: expires },
    root.privateJwk,
  );

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbox-'));
  const { server, close } = await startServer({
    port: 0,
    host: '127.0.0.1',
    ownCard: mkCard(PEER_NAME, 'localhost', '127.0.0.1:0', peer.publicJwk),
    rootPublicJwk: root.publicJwk,
    inboxDir,
    isTrustedPeer: (card) => trustSender && card.name === SENDER_NAME,
    logger: QUIET,
  });
  const { address: host, port } = server.address();
  const peerAddr = `${host}:${port}`;

  // Temp cortextOS layout: <home>/<instance>/{agent-card,discovered-peers,trusted/denied}
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-home-'));
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-keys-'));
  const instDir = path.join(home, INSTANCE);
  // Sender card carries a "-testhost" suffix so key-path derivation is realistic.
  writeJson(path.join(instDir, 'agent-card.json'), mkCard(SENDER_NAME, 'testhost', '127.0.0.1:7701', me.publicJwk));
  // Discovered peer card points at the REAL running address.
  writeJson(path.join(instDir, 'discovered-peers', `${PEER_NAME}.card.json`), mkCard(PEER_NAME, 'localhost', peerAddr, peer.publicJwk));
  writeJson(path.join(instDir, 'trusted-peers.json'), { names: [PEER_NAME] });
  writeJson(path.join(instDir, 'denied-peers.json'), { names: [] });
  // Private key at the observed convention path.
  writeJson(path.join(keysDir, `cortext-boss-${INSTANCE}`, 'private.jwk.json'), me.privateJwk);

  return { close, inboxDir, home, keysDir, peerAddr };
}

const baseOpts = (f, extra = {}) => ({
  instance: INSTANCE, peer: PEER_NAME, cortextosHome: f.home, wyreKeysDir: f.keysDir, logger: QUIET, ...extra,
});

test('signs + dispatches to a discovered, trusting peer -> lands in inbox', async () => {
  const f = await fixture();
  try {
    const res = await sendA2A(baseOpts(f, { payload: { task: 'hello', ref: 'A2A-1' } }));
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    const files = fs.readdirSync(f.inboxDir);
    assert.equal(files.length, 1);
    const entry = JSON.parse(fs.readFileSync(path.join(f.inboxDir, files[0]), 'utf8'));
    assert.equal(entry.sender.name, SENDER_NAME);
    assert.equal(entry.kind, 'dispatch');
    assert.equal(entry.payload.task, 'hello');
  } finally { await f.close(); }
});

test('refuses an undiscovered peer (no verified card on disk)', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => sendA2A(baseOpts(f, { peer: 'nobody', payload: { x: 1 } })),
      /not in discovered-peers/,
    );
    assert.equal(fs.readdirSync(f.inboxDir).length, 0);
  } finally { await f.close(); }
});

test('refuses a denied (revoked) peer and does NOT dispatch', async () => {
  const f = await fixture();
  writeJson(path.join(f.home, INSTANCE, 'denied-peers.json'), { names: [PEER_NAME] });
  try {
    await assert.rejects(
      () => sendA2A(baseOpts(f, { payload: { x: 1 } })),
      /denied-peers/,
    );
    assert.equal(fs.readdirSync(f.inboxDir).length, 0);
  } finally { await f.close(); }
});

test('recipient that does NOT trust us returns 403 — gate enforced end-to-end', async () => {
  const f = await fixture({ trustSender: false });
  try {
    const res = await sendA2A(baseOpts(f, { payload: { task: 'hi' } }));
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(fs.readdirSync(f.inboxDir).length, 0);
  } finally { await f.close(); }
});

test('dry-run resolves identity + peer address but sends nothing', async () => {
  const f = await fixture();
  try {
    const res = await sendA2A(baseOpts(f, { payload: { task: 'x' }, dryRun: true }));
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.address, f.peerAddr);
    assert.equal(fs.readdirSync(f.inboxDir).length, 0);
  } finally { await f.close(); }
});
