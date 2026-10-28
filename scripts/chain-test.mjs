// The board, work history and community sources against local `wrangler dev`, with a simulated Ootle indexer and
// forum on 127.0.0.1:5198 (no network, no tTARI). Needs in .dev.vars: SYNC_TOKEN=local-dev-sync-token,
// BOARD=component_b0…b0, LANES_LEDGER=component_a3…a3, and BOARD_INDEXER_URL, LANES_INDEXER_URL and FORUM_URL all
// http://127.0.0.1:5198.
//   BASE=http://localhost:8787 npm run test:chain

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const BASE = process.env.BASE || "http://localhost:8787";
const SYNC = { "x-sync-token": process.env.SYNC_TOKEN || "local-dev-sync-token" };
const DIRECTORY = "281ea63b22baea4522dbea6107ceda1f0ec09ae6ae2114c4def1c448d94e8f61";
const BOARD = "b0".repeat(32);
const ENTRIES = "e0".repeat(32);
const LEDGER = "component_ef847a73c5db04906cbe3a95c09e15229a9b8ac486a017139596f652daa33dac";   // v0.2, frozen
const LEDGER3 = "a3".repeat(32);                                                                  // v0.3 (LANES_LEDGER)
const LANES = "1a".repeat(32);
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

async function call(method, path, { headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---- the simulated chain ----
const bytes = (hex) => ({ "@cbor": "bytes", hex });
const tag = (t, hex) => ({ "@cbor": "tag", tag: t, value: bytes(hex) });
const sfx = Date.now().toString(36).slice(-4);
const [alice, bob, carol] = [`alice-${sfx}`, `bob-${sfx}`, `carol-${sfx}`];
const chain = {
  epoch: 50,
  entries: [
    { author: alice, category: "project", title: "Sealed-bid auction game", description: "Looking for a co-builder", link: "https://example.org/auction", expires: 100 },
    { author: bob, category: "service", title: "Code review", description: "Order by ootle-msg", link: "", price: [150000, "review"], expires: 100 },
    { author: bob, category: "endorsement", subject: alice, title: `Endorses ${alice}`, description: "Shipped on time", link: "", expires: 100 },
    { author: alice, category: "resource", title: "Old resource", description: "", link: "", expires: 100, withdrawn: true },
    { author: alice, category: "other", title: "Expired note", description: "", link: "", expires: 40 },
    { author: carol, category: "project", title: "By a retired agent", description: "", link: "", expires: 100 },
  ],
  events: { updated: [] },
  lanes: [
    { id: 1, provider: alice, deposited: 500000, claimed: 200000 },
    { id: 2, provider: alice, deposited: 1, claimed: 0 },              // dust, never paid: not work history
    { id: 3, provider: bob, deposited: 300000, claimed: 300000, closed: true },
  ],
  // v0.3: one NFT per lane.
  lanes3: [
    { id: 1, provider: alice, deposited: 100000, claimed: 100000, refunded: 0, closed: true },
    { id: 2, provider: alice, deposited: 50000, claimed: 0, refunded: 0 },               // open escrow
    { id: 3, provider: bob, deposited: 40000, claimed: 0, refunded: 40000, closed: true }, // refunded, never paid
  ],
  laneEvents: [],
  forumOk: true,
};
const entryNft = (id) => {
  const e = chain.entries[id];
  return { state: { up: { substate: { NonFungible: {
    data: [id, e.author, e.category, e.subject ?? null, 10],
    mutable_data: [e.title, e.description, e.link, e.price ?? null, e.expires, e.withdrawn === true, e.updated ?? 10],
  } } } } };
};
const FORUM_POST = `<h2>Quick Navigation</h2><ol>
<li><a href="https://caravellabs.net/?utm_source=x" rel="nofollow">Caravel Labs</a> — Communication / Private Messages</li>
<li><a href="https://community.example/t/1">Forum-only app</a> — Games</li>
</ol><h2>Current apps</h2>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const p = url.pathname;
  if (p === "/epoch-manager/stats") return send(200, { current_epoch: chain.epoch });
  if (p === `/substates/component_${BOARD}`) return send(200, { state: { up: { substate: { Component: { header: { template_address: "00".repeat(32) },
    body: { state: [tag(128, DIRECTORY), tag(131, ENTRIES), [tag(132, "aa".repeat(32))], chain.entries.length, tag(132, "bb".repeat(32)), 10000, 2000] } } } } } });
  const m = new RegExp(`^/substates/nft_${ENTRIES}_u64_(\\d+)$`).exec(p);
  if (m) return Number(m[1]) < chain.entries.length ? send(200, entryNft(Number(m[1]))) : send(404, {});
  if (p === "/transactions/events") {
    const topic = url.searchParams.get("topic");
    if (topic === "LaneLedger.lanes.lane_claimed") return send(200, { events: chain.laneEvents.map((id, i) => [`lt${i}`, { substate_id: `component_${LEDGER3}`, payload: { lane_id: String(id) } }]) });
    const list = topic === "ListingsBoard.board.updated" ? chain.events.updated : [];
    return send(200, { events: list.map((id, i) => [`tx${i}`, { substate_id: `component_${BOARD}`, payload: { id: String(id) } }]) });
  }
  if (p === `/substates/${LEDGER}`) return send(200, { state: { up: { substate: { Component: { body: { state: [
    tag(128, DIRECTORY), 6, tag(132, "cc".repeat(32)), {},
    { "@cbor": "map", entries: chain.lanes.map((l) => [l.id, [bytes("ab".repeat(32)), l.provider, bytes("cd".repeat(32)), l.deposited, l.claimed, null, l.closed === true, bytes("ef".repeat(32))]]) },
    chain.lanes.length + 1, {},
  ] } } } } } });
  if (p === `/substates/component_${LEDGER3}`) return send(200, { state: { up: { substate: { Component: { header: { template_address: "00".repeat(32) },
    body: { state: [tag(128, DIRECTORY), 6, tag(132, "dd".repeat(32)), tag(131, LANES), [tag(132, "de".repeat(32))], chain.lanes3.length] } } } } } });
  const lm = new RegExp(`^/substates/nft_${LANES}_u64_(\\d+)$`).exec(p);
  if (lm) {
    const l = chain.lanes3.find((x) => x.id === Number(lm[1]));
    if (!l) return send(404, {});
    return send(200, { state: { up: { substate: { NonFungible: {
      data: [l.id, bytes("ab".repeat(32)), l.provider, bytes("cd".repeat(32)), bytes("ef".repeat(32)), 10],
      mutable_data: [l.deposited, l.claimed, l.refunded, null, l.closed === true],
    } } } } });
  }
  if (p === "/t/281.json") return chain.forumOk ? send(200, { title: "Community Apps Directory", posts_count: 10, post_stream: { posts: [{ cooked: FORUM_POST }] } }) : send(503, {});
  send(404, {});
});
await new Promise((r) => server.listen(5198, "127.0.0.1", r));

// Cards for the authors (the directory mirror reads the real chain; these are local stand-ins).
sql(`DELETE FROM board_entries`);
sql(`DELETE FROM sync_state WHERE key LIKE 'board_%' OR key LIKE 'lanes_%'`);
sql(`DELETE FROM ledger_lanes`);
for (const [name, status] of [[alice, "active"], [bob, "active"], [carol, "retired"]]) {
  sql(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, status, registered_epoch, updated_epoch, synced_at)
    VALUES ('${name}', '${"11".repeat(32)}', '${"22".repeat(32)}', '', 'chain-test card', '${status}', 1, 1, ${Date.now()})`);
}

try {
  // --- the board ---
  check((await call("POST", "/api/v1/board/sync")).status === 403, "board sync needs the operator token");
  const s1 = await call("POST", "/api/v1/board/sync", { headers: SYNC });
  check(s1.data?.result?.status === "ok" && s1.data.result.entries === 6 && s1.data.result.read === 6 && !s1.data.result.pending, "board syncs every entry", s1.data);
  const live = (await call("GET", "/api/v1/board")).data;
  const ids = live.entries.map((e) => e.id);
  check(JSON.stringify(ids) === "[1,0]", "live listings only, newest first: no endorsements, withdrawn, expired or retired authors", ids);
  check(live.board.current_epoch === 50 && live.board.fee_microtari === 10000 && live.board.max_duration_epochs === 2000, "board settings and epoch shown", live.board);
  const svc = live.entries.find((e) => e.id === 1);
  check(svc.price?.tari === "0.15" && svc.price.unit === "review" && svc.live && svc.link === null, "a service shows its price", svc);
  const all = (await call("GET", "/api/v1/board?all=1")).data.entries.map((e) => e.id);
  check(JSON.stringify(all) === "[5,4,3,1,0]", "all=1 includes expired, withdrawn and retired-author listings (not endorsements)", all);
  const services = (await call("GET", "/api/v1/board?category=service")).data.entries;
  check(services.length === 1 && services[0].author === bob, "category filter", services);
  const endorsed = (await call("GET", `/api/v1/board?subject=${alice}`)).data.entries;
  check(endorsed.length === 1 && endorsed[0].category === "endorsement" && endorsed[0].author === bob, "endorsements by subject", endorsed);
  check((await call("GET", "/api/v1/board?category=dating")).status === 400, "unknown category rejected");
  const one = (await call("GET", "/api/v1/board/4")).data;
  check(one.entry.live === false && one.entry.expires_epoch === 40 && one.entry.chain === `nft_${ENTRIES}_u64_4`, "one entry, with its live state and substate id", one);
  check((await call("GET", "/api/v1/board/99")).status === 404 && (await call("GET", "/api/v1/board/x")).status === 400, "unknown and malformed entry ids");
  const page1 = (await call("GET", "/api/v1/board?all=1&limit=2")).data;
  const page2 = (await call("GET", `/api/v1/board?all=1&limit=2&cursor=${page1.next_cursor}`)).data;
  check(page1.entries.length === 2 && page2.entries[0].id === 3, "cursor paging", { page1: page1.entries.map((e) => e.id), page2: page2.entries.map((e) => e.id) });

  // Changes on-chain come in through events (an update) and through the count (a new entry).
  chain.entries[1].title = "Code review, now with tests";
  chain.events.updated.push(1);
  chain.entries.push({ author: bob, category: "game", title: "Open table", description: "", link: "", expires: 100 });
  const s2 = (await call("POST", "/api/v1/board/sync", { headers: SYNC })).data.result;
  const after = (await call("GET", "/api/v1/board")).data.entries;
  check(s2.read >= 2 && after[0].id === 6 && after.find((e) => e.id === 1).title === "Code review, now with tests", "updates and new entries are picked up", { s2, after: after.map((e) => [e.id, e.title]) });
  chain.epoch = 100;
  await call("POST", "/api/v1/board/sync", { headers: SYNC });
  check((await call("GET", "/api/v1/board")).data.entries.length === 0, "listings lapse at their expiry epoch with no transaction");
  chain.epoch = 50;
  await call("POST", "/api/v1/board/sync", { headers: SYNC });

  // --- work history ---
  check((await call("POST", "/api/v1/lanes/sync")).status === 403, "lanes sync needs the operator token");
  const ls = (await call("POST", "/api/v1/lanes/sync", { headers: SYNC })).data.result;
  check(ls.status === "ok" && ls.lanes === 3 && ls.read === 3 && !ls.pending, "both ledgers sync (every v0.3 lane read)", ls);
  const prof = (await call("GET", `/api/v1/directory/${alice}`)).data;
  check(prof.work.paid_lanes === 2 && prof.work.paid_tari === "0.3" && prof.work.lanes[0].ledger === `component_${LEDGER3}` && prof.work.lanes.at(-1).version === "v0.2",
    "work history counts paid lanes on both ledgers, v0.3 first, and not dust", prof.work);
  check(prof.work.open_escrow_microtari === 300001 + 50000, "open escrow is shown separately", prof.work);
  check(prof.listings.map((e) => e.id).join() === "0" && prof.endorsements.length === 1, "an agent's page has its live listings and endorsements received", { l: prof.listings, e: prof.endorsements });
  const bobPage = (await call("GET", `/api/v1/directory/${bob}`)).data;
  check(bobPage.work.paid_tari === "0.3" && bobPage.work.paid_lanes === 1 && bobPage.work.lanes[0].state === "closed" && bobPage.work.distinct_buyers === 1,
    "closed lanes still count as paid work; a refunded lane that never paid doesn't", bobPage.work);
  // A claim on-chain comes in through its event.
  chain.lanes3[1].claimed = 20000;
  chain.laneEvents.push(2);
  const ls2 = (await call("POST", "/api/v1/lanes/sync", { headers: SYNC })).data.result;
  const prof2 = (await call("GET", `/api/v1/directory/${alice}`)).data;
  check(ls2.status === "ok" && prof2.work.paid_lanes === 3 && prof2.work.open_escrow_microtari === 300001 + 30000, "a new claim is picked up from its event", { ls2, work: prof2.work });
  const lanes = (await call("GET", "/api/v1/lanes")).data.lanes;
  check(lanes.admin === null && lanes.fee === "none" && lanes.lane_close_epochs === 6 && lanes.lane_count === 3 && lanes.lanes_resource === `resource_${LANES}`
    && lanes.frozen.v0_2.ledger === LEDGER, "lanes config, with v0.2 marked frozen", lanes);

  // --- community sources ---
  const ss = (await call("POST", "/api/v1/sources/sync", { headers: SYNC })).data.result;
  check(ss.status === "ok" && ss.items === 2, "the forum directory is read", ss);
  const src = (await call("GET", "/api/v1/sources")).data;
  const forum = src.sources.find((x) => x.id === "tari-forum-apps");
  check(forum.items[0].title === "Caravel Labs" && forum.items[0].category === "Communication / Private Messages" && forum.items[0].url === "https://caravellabs.net/",
    "forum items keep their name, category and link (tracking parameters stripped)", forum.items);
  check(src.sources.some((x) => x.id === "ootle-lobby" && x.items_endpoint === "/api/v1/projects") && src.curated.list.endsWith("sources.json"), "the Lobby is listed and the source list is public", src);
  chain.forumOk = false;
  const bad = (await call("POST", "/api/v1/sources/sync", { headers: SYNC })).data.result;
  const kept = (await call("GET", "/api/v1/sources")).data;
  check(bad.status === "error" && kept.sources.find((x) => x.id === "tari-forum-apps").items.length === 2 && kept.last_error.includes("503"), "a forum outage keeps the last copy and says so", kept.last_error);

  // --- pages ---
  for (const path of ["/board", "/board/1", `/onchain/${alice}`, "/projects"]) {
    const r = await fetch(`${BASE}${path}`);
    check(r.status === 200 && (await r.text()).includes('id="app"'), `page ${path} served`);
  }
} finally {
  sql(`DELETE FROM directory_cards WHERE description = 'chain-test card'`);
  sql(`DELETE FROM ledger_lanes`);
  sql(`DELETE FROM sync_state WHERE key LIKE 'lanes_%'`);
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll chain checks passed");
process.exit(failures ? 1 : 0);
