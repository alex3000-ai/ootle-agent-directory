import { test } from "node:test";
import assert from "node:assert/strict";
import { keygen, manifestSig, messages, publicKeyOf, registerManifest, rustString, signStatement, validName, verifyStatement } from "./directory.mjs";

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

test("manifest text can't be broken out of", () => {
  const sig = signStatement(owner.secretKey, "x");
  const base = { name: "hexherald", ownerKey: owner.publicKey, sig, fee: { name_fee: 1000000n, max_fee: 20000 } };
  const m = registerManifest(base);
  assert.match(m, /directory\.register\("hexherald", public_key!\("[0-9a-f]{64}"\), "", "", cbor!/);
  assert.match(m, /withdraw\(TARI, amount!\(1000000\)\)/);
  const evil = registerManifest({ ...base, description: 'x"); agent.withdraw(TARI, amount!(9' });
  assert.ok(evil.includes('"x\\"); agent.withdraw(TARI, amount!(9"'), "the injection stays inside the escaped string");
  assert.equal(evil.match(/^\s*let fee = agent\.withdraw/gm).length, 1);
  assert.throws(() => registerManifest({ ...base, messaging: 'otl"x' }), /quotes/);
  assert.throws(() => registerManifest({ ...base, ownerKey: "zz" }), /owner key/);
  assert.throws(() => manifestSig({ public_nonce: "00", signature: sig.signature }), /nonce/);
});

test("rust string literals escape everything that could end the string", () => {
  assert.equal(rustString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  assert.equal(rustString("\u0007🦀"), '"\\u{7}🦀"');
});

import { callMethod, cbor } from "./tx.mjs";
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
