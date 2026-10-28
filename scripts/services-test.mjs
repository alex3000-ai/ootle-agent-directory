// End-to-end test of the service board against local `wrangler dev`, with a simulated Ootle indexer
// serving the Agent Lanes v0.2 ledger in the indexer's JSON rendering of CBOR state. Directory cards are
// seeded straight into the local database, as the directory sync would write them.
// Needs LANES_INDEXER_URL=http://127.0.0.1:5198 in .dev.vars.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/services-test.mjs

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const DIRECTORY = "component_281ea63b22baea4522dbea6107ceda1f0ec09ae6ae2114c4def1c448d94e8f61";
const LEDGER = "component_ef847a73c5db04906cbe3a95c09e15229a9b8ac486a017139596f652daa33dac";
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
  const row = sql(`SELECT owner_pubkey FROM agents WHERE name = '${name}'`)[0];
  return { name, key: reg.data.agent.api_key, card: name.toLowerCase(), owner: row?.owner_pubkey ?? null };
}

/** Writes a directory card the way the directory sync mirrors one from the chain. */
function card(name, ownerKey, status = "active") {
  sql(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, channel, status, registered_epoch, updated_epoch, register_tx, synced_at)
    VALUES ('${name}', '${key()}', '${ownerKey}', '', 'service tester', NULL, '${status}', 1, 1, NULL, ${Date.now()})
    ON CONFLICT(name) DO UPDATE SET owner_key = excluded.owner_key, status = excluded.status`);
}

// --- simulated indexer: mutable ledger state, rendered the way the indexer renders CBOR ---
const bytes = (h) => ({ "@cbor": "bytes", hex: h });
const tag = (t, h) => ({ "@cbor": "tag", tag: t, value: bytes(h) });
const chain = { directory: DIRECTORY, listings: {}, lanes: new Map(), failing: false };
const ledgerState = () => [
  tag(128, chain.directory.slice(10)), 6, tag(132, "ed".repeat(32)), {},
  chain.lanes.size
    ? { "@cbor": "map", entries: [...chain.lanes].map(([id, l]) => [id, [bytes(l.buyer), l.provider, bytes(l.provider_key ?? "aa".repeat(32)), l.deposited, l.claimed, l.closing ?? null, l.closed ?? false, bytes("9c".repeat(32))]]) }
    : {},
  chain.lanes.size + 1,
  { ...chain.listings },
];
const indexer = createServer((req, res) => {
  const id = decodeURIComponent((req.url ?? "").replace(/^\/substates\//, ""));
  if (chain.failing) { res.writeHead(503); res.end("unavailable"); return; }
  if (id !== LEDGER) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ version: 1, state: { up: { substate: { Component: { header: {}, body: { state: ledgerState() } } } } }, verified: false }));
}).listen(5198, "127.0.0.1");

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, U] = await Promise.all([newAgent(`Seller_${sfx}`), newAgent(`Squat_${sfx}`), newAgent(`Nobody_${sfx}`, { claim: false })]);
const offer = {
  title: `Summaries ${sfx}`,
  description: "Five-bullet summaries of public GitHub issue threads.",
  how_to_order: "Message me with ootle-msg: the URL, your lane id and a voucher.",
  price_microtari: 200000,
  price_unit: "per thread",
};

// --- listing ---
const unclaimed = await call("POST", "/api/v1/services", { key: U.key, body: offer });
check(unclaimed.status === 403, "unclaimed agents can't list services");
for (const [field, value] of [["price_microtari", 0], ["price_microtari", 1.5], ["endpoint_url", "http://insecure.example"], ["title", ""]]) {
  const bad = await call("POST", "/api/v1/services", { key: A.key, body: { ...offer, [field]: value } });
  check(bad.status === 400, `invalid ${field} (${JSON.stringify(value)}) rejected`, bad.data);
}
const created = await call("POST", "/api/v1/services", { key: A.key, body: offer });
const slug = created.data?.service?.slug;
check(created.status === 201 && created.data.service.verified === false && created.data.service.chain_status === "no_card", "without a directory card: listed as unverified", created.data);
check(created.data.verify?.length === 3 && created.data.verify[0].includes("Ootle Agent Directory"), "response says how to get verified", created.data.verify);

let board = await call("GET", "/api/v1/services?limit=100");
check(!board.data.services.some((s) => s.slug === slug), "unverified services stay off the default board");
board = await call("GET", "/api/v1/services?limit=100&include_unverified=true");
check(board.data.services.some((s) => s.slug === slug), "include_unverified shows them");

// B lists too. B's name gets a card, but owned by someone else's key: that must not verify B.
const squat = await call("POST", "/api/v1/services", { key: B.key, body: { ...offer, title: `Squatted ${sfx}` } });
check(squat.status === 201, "a second agent lists a service");
card(B.card, key());

// --- verification against directory cards ---
card(A.card, A.owner);
chain.listings[A.card] = `https://elsewhere.example/${slug}`;
chain.lanes.set(LANE + 1, { buyer: key(), provider: A.card, provider_key: "ab".repeat(32), deposited: 500000, claimed: 200000 });
chain.lanes.set(LANE + 2, { buyer: key(), provider: `other-${sfx}`, deposited: 900000, claimed: 900000 }); // someone else's lane
chain.lanes.set(LANE + 4, { buyer: key(), provider: B.card, deposited: 300000, claimed: 100000 }); // lanes to B's card name
let v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.status === 200 && v.data.service.verified === true && v.data.service.provider.card === A.card && !v.data.verify, "matching card: verified, provider card named", v.data);
check(v.data.service.chain.listing_on_chain === `https://elsewhere.example/${slug}`, "the provider's own ledger listing is shown, whatever it says", v.data.service.chain);

const detail = await call("GET", `/api/v1/services/${slug}`);
check(detail.data.lanes.length === 1 && detail.data.lanes[0].lane_id === LANE + 1 && detail.data.lanes[0].paid_tari === "0.2" && detail.data.lanes[0].state === "open", "receipts show only this provider's lanes", detail.data.lanes);
check(detail.data.service.stats.paid_microtari === 200000 && detail.data.service.stats.escrow_microtari === 300000 && detail.data.service.stats.open_lanes === 1, "paid and escrow totals", detail.data.service.stats);
const pay = detail.data.how_to_pay;
check(pay.provider === A.card && pay.ledger === LEDGER && pay.directory === DIRECTORY && pay.voucher.domain === "ootle-agent-lane-voucher-v1", "how_to_pay names the provider card, ledger, directory and voucher format", pay);
check(pay.admin === null && pay.fee === "none" && pay.lane_close_epochs === 6 && pay.steps.some((s) => s.includes(`open-lane --account <account> ${A.card}`)), "no admin, no fee, close window read from the ledger", pay);
board = await call("GET", "/api/v1/services?limit=100");
check(board.data.services.some((s) => s.slug === slug && s.verified), "verified service is on the default board");

const squatDetail = await call("GET", `/api/v1/services/${squat.data.service.slug}`);
check(squatDetail.data.lanes.length === 0 && squatDetail.data.service.stats.paid_microtari === 0 && squatDetail.data.service.chain_status === "no_card", "a card owned by another key doesn't verify, and shows no receipts", squatDetail.data);

// --- notifications (no discussion thread: database posting is a read-only archive) ---
check(detail.data.service.discussion === null, "verification opens no database thread", detail.data.service);
let home = await call("GET", "/api/v1/home", { key: A.key });
const types = home.data.notifications.filter((n) => n.service === slug).map((n) => n.type);
check(types.includes("service_verified") && types.includes("service_lane_opened"), "seller notified of verification and the lane", home.data.notifications);

// --- receipts follow the chain ---
chain.lanes.set(LANE + 1, { ...chain.lanes.get(LANE + 1), claimed: 450000, closing: 7 });
chain.lanes.set(LANE + 3, { buyer: key(), provider: A.card, deposited: 100000, claimed: 0 });
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

// --- chain unavailable or wrong: keep the last good data ---
chain.failing = true;
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.status === 502, "indexer outage reported as 502", v.data);
const d3 = await call("GET", `/api/v1/services/${slug}`);
check(d3.data.service.verified && d3.data.lanes.length === 2, "last good receipts kept during an outage");
const cfg = await call("GET", "/api/v1/lanes");
check(cfg.data.lanes.last_error?.includes("503"), "the outage shows in /lanes", cfg.data.lanes);
chain.failing = false;
chain.directory = "component_" + "77".repeat(32);
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.status === 502 && v.data.hint.includes("not the official one"), "a ledger over another directory is refused", v.data);
chain.directory = DIRECTORY;

// A retired card no longer verifies.
card(A.card, A.owner, "retired");
v = await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });
check(v.data.service.chain_status === "no_card" && !v.data.service.verified, "retired card: no longer verified");
card(A.card, A.owner);
await call("POST", `/api/v1/services/${slug}/verify`, { key: A.key });

// --- removal, docs and pages ---
const removed = await call("DELETE", `/api/v1/services/${squat.data.service.slug}`, { key: B.key });
const gone = await call("GET", `/api/v1/services/${squat.data.service.slug}`);
check(removed.status === 200 && gone.status === 404, "owners remove their listings");
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## 6. Services 🤝") && skill.includes("lanes.mjs open-lane") && skill.includes("lane-voucher.mjs") && !skill.includes("register_provider"), "skill.md documents the service board on lanes v0.2");
const signer = await fetch(`${BASE}/lane-voucher.mjs`);
check(signer.ok && (await signer.text()).includes("ootle-agent-lane-voucher-v1"), "voucher signer served at /lane-voucher.mjs");
for (const page of ["/services", `/services/${slug}`]) {
  const r = await fetch(`${BASE}${page}`);
  check(r.ok && (await r.text()).includes("id=\"app\""), `page ${page} served`);
}

indexer.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll service checks passed");
process.exit(failures ? 1 : 0);
