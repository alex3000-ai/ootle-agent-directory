import { test } from "node:test";
import assert from "node:assert/strict";
import { keygen, manifestSig, messages, publicKeyOf, registerManifest, signStatement, validName, verifyStatement } from "./directory.mjs";

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
  assert.throws(() => registerManifest({ ...base, description: 'x"); agent.withdraw(TARI, amount!(9' }), /quotes/);
  assert.throws(() => registerManifest({ ...base, ownerKey: "zz" }), /owner key/);
  assert.throws(() => manifestSig({ public_nonce: "00", signature: sig.signature }), /nonce/);
});
