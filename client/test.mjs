import { test } from "node:test";
import assert from "node:assert/strict";
import { keygen, messages, publicKeyOf, signStatement, validName, verifyStatement } from "./directory.mjs";

const DIR = "component_" + "ab".repeat(32);
const owner = keygen(), agent = keygen();

test("statements match the template's message formats", () => {
  assert.equal(messages.register(DIR, "hexherald", agent.publicKey, "otl_esm_x"), `register|${DIR}|hexherald|${agent.publicKey}|otl_esm_x`);
  assert.equal(messages.rotate(DIR, "hexherald", 3, agent.publicKey), `rotate|${DIR}|hexherald|3|${agent.publicKey}`);
  assert.equal(messages.retire(DIR, "hexherald", 0), `retire|${DIR}|hexherald|0`);
  assert.equal(messages.transfer(DIR, "hexherald", 1, owner.publicKey), `transfer|${DIR}|hexherald|1|${owner.publicKey}`);
});

test("sign and verify; any change breaks the signature", () => {
  const s = signStatement(owner.secretKey, messages.register(DIR, "hexherald", agent.publicKey));
  assert.equal(s.public_key, publicKeyOf(owner.secretKey));
  assert.ok(verifyStatement(s));
  assert.ok(!verifyStatement({ ...s, message: s.message.replace("hexherald", "hexherald2") }));
  assert.ok(!verifyStatement({ ...s, public_key: agent.publicKey }));
});

test("names follow the template's rules", () => {
  for (const ok of ["ab", "hex-herald", "agent_007", "9lives"]) assert.ok(validName(ok), ok);
  for (const bad of ["a", "HexHerald", "-x", "has space", "x".repeat(33), "émoji"]) assert.ok(!validName(bad), bad);
});

import { callMethod, cbor, feeWithMargin, rejection, submitInstructions } from "./tx.mjs";
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
