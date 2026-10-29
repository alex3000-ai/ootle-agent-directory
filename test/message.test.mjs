import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newIdentity } from "../lib/identity.mjs";
import { decodeMessage, encodeMessage, MAX_BODY, MEMO_MAX, parseChunk } from "../lib/message.mjs";
import { Store } from "../lib/store.mjs";

const alice = newIdentity("esmeralda"), bob = newIdentity("esmeralda"), eve = newIdentity("esmeralda");

const reassemble = (myAddress, chunks) => {
  const cs = chunks.map(parseChunk);
  return decodeMessage(myAddress, cs[0].id, Object.fromEntries(cs.map((c) => [c.index, c.data])), cs[0].total);
};

test("short message: one chunk, round trip, signed by the sender", () => {
  const { chunks } = encodeMessage(alice, bob.address, "gm Bob");
  assert.equal(chunks.length, 1);
  const m = reassemble(bob.address, chunks);
  assert.equal(m.text, "gm Bob");
  assert.equal(m.from, alice.address);
});

test("long message: chunks fit a memo and reassemble", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${Math.random().toString(36)}`).join("\n").slice(0, 6000);
  const { chunks } = encodeMessage(alice, bob.address, text);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.length <= MEMO_MAX));
  assert.equal(reassemble(bob.address, chunks).text, text);
});

test("compressible text is deflated; incompressible text is sent raw", () => {
  const big = encodeMessage(alice, bob.address, "ootle ".repeat(500));
  assert.equal(big.chunks.length, 1);
  assert.equal(reassemble(bob.address, big.chunks).text, "ootle ".repeat(500));
  const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(300))).toString("base64");
  assert.equal(reassemble(bob.address, encodeMessage(alice, bob.address, noise).chunks).text, noise);
});

test("too long is refused", () => {
  const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(MAX_BODY))).toString("base64");
  assert.throws(() => encodeMessage(alice, bob.address, noise), /too long/);
});

test("a message signed for Bob does not verify for anyone else", () => {
  const { chunks } = encodeMessage(alice, bob.address, "for Bob only");
  assert.throws(() => reassemble(eve.address, chunks), /bad signature/);
});

test("tampering with any byte breaks the signature", () => {
  const { chunks } = encodeMessage(alice, bob.address, "pay 5 tTARI to lane 7");
  for (const offset of [13 + 2, 13 + 70, chunks[0].length - 1]) { // sender key, timestamp, body
    const bad = Uint8Array.from(chunks[0]);
    bad[offset] ^= 1;
    assert.throws(() => reassemble(bob.address, [bad]), /bad signature|invalid|inflat|decod/i, `offset ${offset}`);
  }
});

test("claiming to be someone else fails", () => {
  const { chunks } = encodeMessage(eve, bob.address, "hi, I'm Alice");
  const forged = Uint8Array.from(chunks[0]);
  const aliceParts = encodeMessage(alice, bob.address, "x").chunks[0];
  forged.set(aliceParts.subarray(13 + 2, 13 + 66), 13 + 2); // swap in Alice's keys
  assert.throws(() => reassemble(bob.address, [forged]), /bad signature/);
});

test("the identity file must match its address", () => {
  assert.throws(() => encodeMessage({ ...alice, owner_secret_key: eve.owner_secret_key }, bob.address, "x"), /does not match/);
});

test("non-message memos are ignored", () => {
  assert.equal(parseChunk(Buffer.from("OB-J4MHRFFXQY payment")), null);
  assert.equal(parseChunk(new Uint8Array(5)), null);
});

test("store: out-of-order and duplicate chunks, forged messages counted and dropped", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "om-")));
  const text = Buffer.from(crypto.getRandomValues(new Uint8Array(400))).toString("base64");
  const { chunks } = encodeMessage(alice, bob.address, text);
  assert.ok(chunks.length >= 2);
  const memos = chunks.map((bytes, i) => ({ id: String(i), bytes })).reverse();
  assert.equal(store.ingest(bob.address, [memos[0]]).length, 0); // still waiting
  const got = store.ingest(bob.address, memos);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, text);
  assert.equal(store.ingest(bob.address, memos).length, 0); // already have it
  const forged = encodeMessage(eve, alice.address, "not for Bob").chunks.map((bytes) => ({ id: "f", bytes }));
  assert.equal(store.ingest(bob.address, forged).length, 0);
  assert.equal(store.state.rejected, 1);
});
