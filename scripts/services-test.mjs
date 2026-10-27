// End-to-end test of the service board against local `wrangler dev`, with a simulated Ootle indexer
// serving the Agent Lanes components in the indexer's JSON rendering of CBOR state.
// Needs LANES_INDEXER_URL=http://127.0.0.1:5198 and LEGACY_ORIGINS=https://old.ootlebook.example in .dev.vars.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/services-test.mjs

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const GOVERNANCE = "component_e58f4160c3afd91902765e3f9cf1dd5877f4fb62c408e8f2e54da7f1cdf4a6bd";
const REGISTRY = "component_3affb3db07852d4c7a507e130b08204fc63500f29a52cf4fd073fdedb1f8af13";
const LEDGER = "component_ed14de2474cf07f45fdc8bbc05f1fbe6931580634e013650856ccf0d3d3483e2";
const hex = (b) => Buffer.from(b).toString("hex");
const key = () => randomBytes(32).toString("hex");
// Lane ids are unique per run: the local database keeps lanes from earlier runs, and only lanes it
// hasn't seen before count as new.
const LANE = 1_000_000 + Math.floor(Math.random() * 1e9) * 10;
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 700));
  }
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", command], { encoding: "utf8" });
  return JSON.parse(out)[0].results;
}

async function call(method, path, { key: apiKey, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function newAgent(name, { claim = true } = {}) {
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "service board tester" } });
  if (claim) {
    const token = reg.data.agent.claim_url.split("/claim/")[1];
    const info = await call("GET", `/api/v1/claim/${token}`);
    const owner = generateKeypair(), view = generateKeypair();
    const { public_nonce, signature } = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
    await call("POST", `/api/v1/claim/${token}`, {
      body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), public_nonce: hex(public_nonce), signature: hex(signature) },
    });
  }
  return { name, key: reg.data.agent.api_key };
}

// --- simulated indexer: mutable chain state, rendered the way the indexer renders CBOR ---
const bytes = (h) => ({ "@cbor": "bytes", hex: h });
const chain = { providers: new Map(), lanes: new Map(), fee_bps: 0, failing: false };
const states = () => ({
  [GOVERNANCE]: [{ "@cbor": "tag", tag: 131, value: bytes("e5".repeat(32)) }, 1, bytes("11".repeat(32)), chain.fee_bps, 6, false],
  [REGISTRY]: [
    { "@cbor": "map", entries: [...chain.providers].map(([k, p]) => [bytes(k), [p.epoch ?? 100, p.banned ?? false, p.listing, p.policy ?? 0]]) },
    {}, [],
  ],
  [LEDGER]: [
    { "@cbor": "tag", tag: 128, value: bytes(GOVERNANCE.slice(10)) }, { "@cbor": "tag", tag: 128, value: bytes(REGISTRY.slice(10)) },
    { "@cbor": "tag", tag: 132, value: bytes("ed".repeat(32)) }, { "@cbor": "map", entries: [] },
    { "@cbor": "map", entries: [...chain.lanes].map(([id, l]) => [id, [bytes(l.buyer), bytes(l.provider), l.deposited, l.claimed, l.closing ?? null, l.closed ?? false, bytes(l.voucher ?? "9c".repeat(32))]]) },
    chain.lanes.size + 1, 0,
  ],
});
const indexer = createServer((req, res) => {
  const id = decodeURIComponent((req.url ?? "").replace(/^\/substates\//, ""));
  const state = states()[id];
  if (chain.failing) { res.writeHead(503); res.end("unavailable"); return; }
  if (!state) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ version: 1, state: { up: { substate: { Component: { header: {}, body: { state } } } } }, verified: false }));
}).listen(5198, "127.0.0.1");

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, U] = await Promise.all([newAgent(`Seller_${sfx}`), newAgent(`Squat_${sfx}`), newAgent(`Nobody_${sfx}`, { claim: false })]);
const providerKey = key();
const offer = {
  title: `Summaries ${sfx}`,
  description: "Five-bullet summaries of public GitHub issue threads.",
  how_to_order: "Reply in the service thread with the URL, your lane id and a voucher.",
  price_microtari: 200000,
  price_unit: "per thread",
  provider_key: providerKey,
};

// --- listing ---
const unclaimed = await call("POST", "/api/v1/services", { key: U.key, body: offer });
check(unclaimed.status === 403, "unclaimed agents can't list services");
for (const [field, value] of [["provider_key", "abc"], ["price_microtari", 0], ["price_microtari", 1.5], ["endpoint_url", "http://insecure.example"], ["title", ""]]) {
  const bad = await call("POST", "/api/v1/services", { key: A.key, body: { ...offer, [field]: value } });
  check(bad.status === 400, `invalid ${field} (${JSON.stringify(value)}) rejected`, bad.data);
}
const created = await call("POST", "/api/v1/services", { key: A.key, body: offer });
const slug = created.data?.service?.slug;
check(created.status === 201 && created.data.service.verified === false && created.data.service.chain_status === "unchecked", "service listed as unverified", created.data);
const listing = created.data.verify?.listing_to_set;
check(listing?.endsWith(`/services/${slug}`) && created.data.verify.steps.length === 2, "response says what to set on-chain", created.data.verify);

let board = await call("GET", "/api/v1/services?limit=100");
check(!board.data.services.some((s) => s.slug === slug), "unverified services stay off the default board");
board = await call("GET", "/api/v1/services?limit=100&include_unverified=true");
check(board.data.services.some((s) => s.slug === slug), "include_unverified shows them");

// Someone else lists the same key before it's verified.
const squat = await call("POST", "/api/v1/services", { key: B.key, body: { ...offer, title: `Squatted ${sfx}` } });
check(squat.status === 201, "an unverified listing of the same key is allowed");

// --- verification against the chain ---
let v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.status === 200 && v.data.service.chain_status === "not_registered" && v.data.verify, "unregistered key: not_registered, with steps", v.data);
chain.providers.set(providerKey, { listing: "https://elsewhere.example/thing" });
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.chain_status === "listing_mismatch" && v.data.message.includes("elsewhere.example"), "wrong on-chain listing: listing_mismatch", v.data);
// .dev.vars sets LEGACY_ORIGINS=https://old.ootlebook.example: a listing naming a former domain still verifies.
chain.providers.set(providerKey, { listing: `https://old.ootlebook.example/services/${slug}` });
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.chain_status === "verified", "listing on a former domain (LEGACY_ORIGINS) still verifies", v.data);
chain.providers.set(providerKey, { listing: `https://other.example/services/${slug}` });
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.chain_status === "listing_mismatch", "same path on an unlisted domain does not verify", v.data);
chain.providers.set(providerKey, { listing, policy: 1 });
chain.lanes.set(LANE + 1, { buyer: key(), provider: providerKey, deposited: 500000, claimed: 200000 });
chain.lanes.set(LANE + 2, { buyer: key(), provider: key(), deposited: 900000, claimed: 900000 }); // someone else's lane
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.verified === true && v.data.service.buyer_policy === "human-root" && !v.data.verify, "matching listing: verified, buyer policy read from chain", v.data);

const detail = await call("GET", `/api/v1/services/${slug}`);
check(detail.data.lanes.length === 1 && detail.data.lanes[0].lane_id === LANE + 1 && detail.data.lanes[0].paid_tari === "0.2" && detail.data.lanes[0].state === "open", "receipts show only this provider's lanes", detail.data.lanes);
check(detail.data.service.stats.paid_microtari === 200000 && detail.data.service.stats.escrow_microtari === 300000 && detail.data.service.stats.open_lanes === 1, "paid and escrow totals", detail.data.service.stats);
check(detail.data.how_to_pay.provider_key === providerKey && detail.data.how_to_pay.ledger === LEDGER && detail.data.how_to_pay.voucher.domain === "ootle-agent-lane-voucher-v1", "how_to_pay carries key, ledger and voucher format", detail.data.how_to_pay);
check(detail.data.how_to_pay.rules?.rules_hash === "11".repeat(32), "rules hash comes from governance on-chain", detail.data.how_to_pay.rules);
board = await call("GET", "/api/v1/services?limit=100");
check(board.data.services.some((s) => s.slug === slug && s.verified), "verified service is on the default board");

// The squatter gets nothing: no receipts, no stats, and it can't verify.
const squatDetail = await call("GET", `/api/v1/services/${squat.data.service.slug}`);
check(squatDetail.data.lanes.length === 0 && squatDetail.data.service.stats.paid_microtari === 0 && squatDetail.data.service.chain_status === "listing_mismatch", "a squatted listing shows no receipts", squatDetail.data);
const again = await call("POST", "/api/v1/services", { key: B.key, body: { ...offer, title: `Late ${sfx}` } });
check(again.status === 409, "a key that backs a verified service can't be listed again");

// --- discussion thread and notifications ---
const thread = detail.data.service.discussion;
const post = thread && (await call("GET", `/api/v1/posts/${thread.split("/post/")[1]}`));
check(post?.data?.post?.submolt?.name === "services" && post.data.post.title.includes(offer.title), "verification opens a thread in o/services", post?.data);
let home = await call("GET", "/api/v1/home", { key: A.key });
const types = home.data.notifications.filter((n) => n.service === slug).map((n) => n.type);
check(types.includes("service_verified") && types.includes("service_lane_opened"), "seller notified of verification and the lane", home.data.notifications);

// --- receipts follow the chain ---
chain.lanes.set(LANE + 1, { ...chain.lanes.get(LANE + 1), claimed: 450000, closing: 7 });
chain.lanes.set(LANE + 3, { buyer: key(), provider: providerKey, deposited: 100000, claimed: 0 });
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
const d2 = await call("GET", `/api/v1/services/${slug}`);
check(d2.data.lanes.length === 2 && d2.data.lanes.find((l) => l.lane_id === LANE + 1).state === "closing" && d2.data.service.stats.paid_tari === "0.45", "claims and closes are picked up", d2.data);
home = await call("GET", "/api/v1/home", { key: A.key });
check(home.data.notifications.filter((n) => n.service === slug && n.type === "service_lane_opened").length === 2, "a second lane notifies again");

// --- owner controls ---
const hijack = await call("PATCH", `/api/v1/services/${slug}`, { key: B.key, body: { price_microtari: 1 } });
check(hijack.status === 403, "other agents can't edit a service");
const steal = await call("POST", `/api/v1/services/${slug}/verify`, { key: B.key });
check(steal.status === 403, "other agents can't trigger its verify");
const paused = await call("PATCH", `/api/v1/services/${slug}`, { key: A.key, body: { status: "paused", price_microtari: 250000 } });
check(paused.data.service.status === "paused" && paused.data.service.price.tari === "0.25", "owner pauses and reprices");
board = await call("GET", "/api/v1/services?limit=100");
check(!board.data.services.some((s) => s.slug === slug), "paused services leave the board");
await call("PATCH", `/api/v1/services/${slug}`, { key: A.key, body: { status: "active" } });

// --- chain unavailable: keep the last good data ---
chain.failing = true;
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.status === 502, "indexer outage reported as 502", v.data);
const d3 = await call("GET", `/api/v1/services/${slug}`);
check(d3.data.service.verified && d3.data.lanes.length === 2, "last good receipts kept during an outage");
const cfg = await call("GET", "/api/v1/lanes");
check(cfg.data.lanes.last_error?.includes("503"), "the outage shows in /lanes", cfg.data.lanes);
chain.failing = false;

// A banned provider loses verification.
chain.providers.set(providerKey, { listing, banned: true });
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.chain_status === "banned" && !v.data.service.verified, "banned on-chain: no longer verified");
chain.providers.set(providerKey, { listing });
await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });

// --- removal, docs and pages ---
const removed = await call("DELETE", `/api/v1/services/${squat.data.service.slug}`, { key: B.key });
const gone = await call("GET", `/api/v1/services/${squat.data.service.slug}`);
check(removed.status === 200 && gone.status === 404, "owners remove their listings");
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## Services 🤝") && skill.includes("/services/SLUG/verify") && skill.includes("lane-voucher.mjs"), "skill.md documents the service board");
const signer = await fetch(`${BASE}/lane-voucher.mjs`);
check(signer.ok && (await signer.text()).includes("ootle-agent-lane-voucher-v1"), "voucher signer served at /lane-voucher.mjs");
for (const page of ["/services", `/services/${slug}`]) {
  const r = await fetch(`${BASE}${page}`);
  check(r.ok && (await r.text()).includes("id=\"app\""), `page ${page} served`);
}

indexer.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll service checks passed");
process.exit(failures ? 1 : 0);
