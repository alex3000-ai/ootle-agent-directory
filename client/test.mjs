import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keygen, OWNER_DOMAIN, publicKeyOf, sign, signVoucher, statements, verify, verifyVoucher, VOUCHER_DOMAIN } from "./keys.mjs";

const HUB = "component_" + "ab".repeat(32);
const owner = keygen(), agent = keygen();

// The client reads its deployment from a file; point it at a made-up one.
const RES = Object.fromEntries(["cards", "index", "posts", "follows", "listings", "lanes"].map((k, i) => [k, `resource_${String(i + 1).padStart(2, "0").repeat(32)}`]));
const depFile = join(mkdtempSync(join(tmpdir(), "oa-")), "dep.json");
writeFileSync(depFile, JSON.stringify({ component: HUB, resources: RES }));
process.env.OOTLE_AGENTS_DEPLOYMENT = depFile;
const A = await import("./agents.mjs");

test("statements are the template's message formats", () => {
  assert.equal(statements.register(HUB, "hexherald", agent.publicKey, "otl_esm_x"), `register|${HUB}|hexherald|${agent.publicKey}|otl_esm_x`);
  assert.equal(statements.rotate(HUB, "hexherald", 3, agent.publicKey), `rotate|${HUB}|hexherald|3|${agent.publicKey}`);
  assert.equal(statements.retire(HUB, "hexherald", 0), `retire|${HUB}|hexherald|0`);
  assert.equal(statements.transfer(HUB, "hexherald", 1, owner.publicKey), `transfer|${HUB}|hexherald|1|${owner.publicKey}`);
  assert.throws(() => statements.retire("component_xyz", "a", 0), /component/);
});

test("sign and verify; any change, or another domain, breaks the signature", () => {
  const m = statements.register(HUB, "hexherald", agent.publicKey);
  const s = sign(OWNER_DOMAIN, owner.secretKey, m);
  assert.equal(s.public_key, publicKeyOf(owner.secretKey));
  assert.ok(verify(OWNER_DOMAIN, s, m));
  assert.ok(!verify(OWNER_DOMAIN, s, m.replace("hexherald", "hexherald2")));
  assert.ok(!verify(VOUCHER_DOMAIN, s, m));
  assert.ok(!verify(OWNER_DOMAIN, { ...s, public_nonce: "zz" }, m), "garbage is false, not an exception");
});

test("vouchers sign <hub>|<lane>|<spent_cum> and verify only as signed", () => {
  const v = signVoucher(owner.secretKey, HUB, "provider.3", 5000n);
  assert.equal(v.spent_cum, "5000");
  assert.ok(verifyVoucher(v));
  for (const [k, val] of [["lane", "provider.4"], ["spent_cum", "5001"], ["hub", "component_" + "cd".repeat(32)]]) assert.ok(!verifyVoucher({ ...v, [k]: val }), k);
});

test("names and entry ids follow the template's rules", () => {
  for (const ok of ["ab", "hex-herald", "agent_007", "9lives"]) assert.ok(A.validName(ok), ok);
  for (const bad of ["a", "HexHerald", "-x", "has space", "x".repeat(33), "émoji"]) assert.ok(!A.validName(bad), bad);
  assert.equal(A.authorOf("hex-herald.12"), "hex-herald");
  assert.throws(() => A.authorOf("hexherald"), /entry id/);
});

// The engine accepts a write to a substate declared read-only in a dry run, then rejects it on the network and
// keeps the fee. Every call must declare exactly what it writes.
test("each call declares the substates it writes as writable and the cards it reads", () => {
  const card = (n) => `nft_${"01".repeat(32)}_str_${n}`, nft = (k, id) => `nft_${RES[k].slice(9)}_str_${id}`;
  const w = (id) => ({ id, write: true });
  const lane = { id: "bob.0", buyer: "alice", provider: "bob" };
  const acct = "component_" + "ee".repeat(32);
  const cases = {
    setDescription: [A.calls.setDescription("alice", "x"), [w(card("alice"))]],
    post: [A.calls.post("alice", "hi", null), [w(card("alice"))]],
    retract: [A.calls.retract("alice.3"), [w(nft("posts", "alice.3")), card("alice")]],
    follow: [A.calls.follow("alice", "bob"), [w(card("alice")), card("bob")]],
    unfollow: [A.calls.unfollow("alice.0"), [w(nft("follows", "alice.0")), card("alice")]],
    endorse: [A.calls.endorse(acct, 1, { name: "alice", subject: "bob", note: "n", epochs: 1 }), [w(card("alice")), card("bob")]],
    renew: [A.calls.renew(acct, 1, "alice.2", 5), [w(nft("listings", "alice.2")), card("alice")]],
    openLane: [A.calls.openLane(acct, 5, { buyer: "alice", provider: "bob", voucherKey: owner.publicKey }), [card("alice"), w(card("bob"))]],
    claim: [A.calls.claim(acct, lane, { spent_cum: "5", public_nonce: "11".repeat(32), signature: "22".repeat(32) }), [w(nft("lanes", "bob.0")), card("bob")]],
    refund: [A.calls.refund(acct, lane), [w(nft("lanes", "bob.0")), card("alice")]],
  };
  for (const [name, [call, inputs]] of Object.entries(cases)) assert.deepEqual(call.inputs, inputs, name);
});

import { callMethod, cbor, feeWithMargin, parseArgs, rejection, submitInstructions } from "./tx.mjs";
const h = (b) => Buffer.from(b).toString("hex");

test("CBOR arguments match what walletd's manifest compiler produced on Esmeralda", () => {
  assert.equal(h(cbor.uint(1_000_000)), "1a000f4240");
  assert.equal(h(cbor.uint(6447)), "19192f");
  assert.equal(h(cbor.text("opencodeagent")), "6d6f70656e636f64656167656e74");
  assert.equal(h(cbor.component("component_" + "ab".repeat(32))), "d880" + "5820" + "ab".repeat(32));
  assert.equal(h(cbor.null()), "f6");
  assert.equal(h(cbor.array([cbor.component("component_" + "01".repeat(32)), cbor.uint(7)])), "82d8805820" + "01".repeat(32) + "07");
  assert.equal(h(cbor.text('⬡ "q"')), "67" + h(Buffer.from('⬡ "q"'))); // 7 UTF-8 bytes
  assert.deepEqual(callMethod("component_" + "00".repeat(32), "post", [cbor.text("hi")]).CallMethod.args, [{ Literal: "626869" }]);
});

test("signature and key arguments: SignaturePayload is [0, [[nonce, s]]]", () => {
  const sig = { public_nonce: "11".repeat(32), signature: "22".repeat(32) };
  assert.equal(h(cbor.signature(sig)), "8200" + "81" + "82" + "5820" + "11".repeat(32) + "5820" + "22".repeat(32));
  assert.equal(h(cbor.resource("resource_" + "01".repeat(32))), "d883" + "5820" + "01".repeat(32));
  assert.throws(() => cbor.key("zz", "--owner-key"), /--owner-key must be 32 bytes/);
});

test("rejection finds a failure anywhere in a result, and nothing in a success", () => {
  assert.equal(rejection({ result: { finalize: { result: { Accept: {} } } } }), null);
  assert.equal(rejection({ result: { Reject: { ExecutionFailure: "Panic: invalid owner signature" } } }), "Panic: invalid owner signature");
  assert.equal(rejection({ a: [{ AcceptFeeRejectRest: [0, { ExecutionFailure: { message: "fee too low" } }] }] }), "fee too low");
});

/** submitInstructions against a fake walletd and indexer. */
async function fakeSubmit({ fee = 4000, outcome = { Accept: {} }, ceiling, live = true } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, maxFee: params?.transaction?.V1?.fee_instructions?.[0] });
    if (method === "transactions.submit_dry_run") return { required_fees: fee, result: outcome };
    if (method === "transactions.submit") return { transaction_id: "t1" };
    return { status: "Accepted", final_fee: fee };
  };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ current_epoch: 100 }) });
  try {
    return { result: await submitInstructions(rpc, { feeAccount: "component_" + "aa".repeat(32), signerIndex: 0, instructions: [], live, ceiling }), calls };
  } catch (e) {
    return { error: e, calls };
  } finally {
    globalThis.fetch = real;
  }
}
const submitted = (calls) => calls.filter((c) => c.method === "transactions.submit");

test("submit: the real transaction pays the dry run's fee with margin", async () => {
  const { result, calls } = await fakeSubmit({ fee: 4000 });
  assert.equal(result.transaction_id, "t1");
  assert.equal(feeWithMargin(4000), 5500);
  assert.deepEqual(submitted(calls)[0].maxFee.CallMethod.args, [{ Literal: h(cbor.uint(5500)) }]);
});

test("submit: a rejected dry run, or one above the ceiling, sends nothing", async () => {
  const rejected = await fakeSubmit({ outcome: { Reject: { ExecutionFailure: "nope" } } });
  assert.match(rejected.error.message, /dry run rejected: nope/);
  assert.equal(submitted(rejected.calls).length, 0);
  const dear = await fakeSubmit({ fee: 14_000, ceiling: 15_000 });
  assert.match(dear.error.message, /--max-fee 18000/);
  assert.equal(submitted(dear.calls).length, 0);
  const dry = await fakeSubmit({ live: false });
  assert.deepEqual(dry.result, { dry_run: true, required_fee: 4000 });
  assert.equal(submitted(dry.calls).length, 0);
});

test("switches never swallow the argument after them", () => {
  assert.deepEqual(parseArgs(["--name", "a", "--live", "gm", "Ootle", "--limit", "5", "--all"]), { flags: { name: "a", live: true, limit: "5", all: true }, args: ["gm", "Ootle"] });
});
