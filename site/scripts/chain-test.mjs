// The OotleAgents mirror and community sources against local `wrangler dev`, with a simulated Ootle indexer and forum
// on 127.0.0.1:5198 (no network, no tTARI). Needs in .dev.vars: SYNC_TOKEN=local-dev-sync-token,
// OOTLE_AGENTS=component_ followed by c0 32 times, and INDEXER_URL and FORUM_URL both http://127.0.0.1:5198.
// It empties the local mirror tables first.
//   BASE=http://localhost:8787 npm run test:chain

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const BASE = process.env.BASE || "http://localhost:8787";
const SYNC = { "x-sync-token": process.env.SYNC_TOKEN || "local-dev-sync-token" };
const HUB = `component_${"c0".repeat(32)}`;
const RES = { cards: "c1", index: "c2", posts: "c3", follows: "c4", listings: "c5", lanes: "c6" };
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 700));
  }
}

const sql = (command) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook-cache", "--local", "--json", "--command", command], { encoding: "utf8" }))[0].results;

async function call(method, path, { headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const sync = async () => (await call("POST", "/api/v1/chain/sync", { headers: SYNC })).data.result;

// ---- the simulated chain ----
const bytes = (hex) => ({ "@cbor": "bytes", hex });
const tag = (t, hex) => ({ "@cbor": "tag", tag: t, value: bytes(hex) });
const key = (c) => bytes(c.repeat(32));
const chain = {
  epoch: 50,
  agents: [
    { name: "alice", description: "builds games", retired: false },
    { name: "bob", description: "reviews code", retired: false },
    { name: "carol", description: "gone", retired: true },
  ],
  posts: { "alice.0": { body: "gm Ootle", epoch: 20 }, "alice.1": { body: "second", epoch: 21 }, "bob.0": { body: "gm alice", epoch: 22, reply: "alice.0" } },
  follows: { "bob.0": { target: "alice", active: true }, "bob.1": { target: "carol", active: false } },
  listings: {
    "alice.0": { category: "project", title: "Sealed-bid auction game", description: "Looking for a co-builder", link: "https://example.org/auction", expires: 100, created: 30 },
    "bob.0": { category: "service", title: "Code review", description: "Order by ootle-msg", link: "", price: [150000, "review"], expires: 100, created: 31 },
    "bob.1": { category: "endorsement", subject: "alice", title: "Endorses alice", description: "Shipped on time", link: "", expires: 100, created: 32 },
    "alice.1": { category: "resource", title: "Old resource", description: "", link: "", expires: 100, created: 33, withdrawn: true },
    "alice.2": { category: "other", title: "Expired note", description: "", link: "", expires: 40, created: 34 },
    "carol.0": { category: "project", title: "By a retired agent", description: "", link: "", expires: 100, created: 35 },
  },
  lanes: {
    "alice.0": { buyer: "bob", deposited: 500000, claimed: 200000, refunded: 0 },
    "alice.1": { buyer: "bob", deposited: 1, claimed: 0, refunded: 0 },                          // dust, never paid: not work history
    "alice.2": { buyer: "carol", deposited: 40000, claimed: 0, refunded: 40000, closed: true },   // refunded, never paid
    "bob.0": { buyer: "alice", deposited: 300000, claimed: 300000, refunded: 0, closed: true },
  },
  retracted: new Set(),
  events: [], // [topic, payload], oldest first
  forumOk: true,
};
const count = (kind, name) => Object.keys(chain[kind]).filter((id) => id.startsWith(`${name}.`)).length;
const nft = (data, mutable_data) => ({ state: { up: { substate: { NonFungible: { data, mutable_data } } } } });
const event = (topic, payload) => chain.events.push([`OotleAgents.agents.${topic}`, payload]);
const ENTRY = {
  cards: (name) => {
    const a = chain.agents.find((x) => x.name === name);
    const n = chain.agents.indexOf(a);
    return a && nft([name, n, 10], [key("a" + n), key("b" + n), "", a.description, a.retired, 0, count("posts", name), count("follows", name), count("listings", name), count("lanes", name), 10]);
  },
  posts: (id) => chain.posts[id] && nft([id.split(".")[0], chain.posts[id].epoch, chain.posts[id].body, chain.posts[id].reply ?? null], [chain.retracted.has(id)]),
  follows: (id) => chain.follows[id] && nft([id.split(".")[0], chain.follows[id].target, 20], [chain.follows[id].active]),
  listings: (id) => {
    const l = chain.listings[id];
    return l && nft([id.split(".")[0], l.category, l.subject ?? null, l.created], [l.title, l.description, l.link, l.price ?? null, l.expires, l.withdrawn === true, l.created]);
  },
  lanes: (id) => {
    const l = chain.lanes[id];
    return l && nft([l.buyer, id.split(".")[0], key("ef"), 10], [l.deposited, l.claimed, l.refunded, l.closed ? 12 : null, l.closed === true]);
  },
};
const FORUM_POST = `<h2>Quick Navigation</h2><ol>
<li><a href="https://caravellabs.net/?utm_source=x" rel="nofollow">Caravel Labs</a> — Communication / Private Messages</li>
<li><a href="https://community.example/t/1">Forum-only app</a> — Games</li>
</ol><h2>Current apps</h2>`;

const server = createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = new URL(req.url, "http://x"), p = url.pathname;
  if (p === `/substates/${HUB}`) {
    const shelf = (k) => [tag(131, RES[k].repeat(32)), [tag(132, "dd".repeat(32))]];
    return send(200, { state: { up: { substate: { Component: { header: { template_address: "00".repeat(32) }, body: { state: [
      tag(131, RES.cards.repeat(32)), shelf("index"), shelf("posts"), shelf("follows"), shelf("listings"), shelf("lanes"), chain.agents.length,
      tag(132, "de".repeat(32)), tag(132, "df".repeat(32)), 10000000, 10000, 2000, 6,
    ] } } } } } });
  }
  if (p === "/epoch-manager/stats") return send(200, { current_epoch: chain.epoch });
  if (p === "/transactions/events") {
    return send(200, { events: chain.events.map(([topic, payload], i) => [`tx${i}`, { substate_id: url.searchParams.get("substate_id") === HUB ? HUB : "other", topic, payload }]).reverse() });
  }
  const index = new RegExp(`^/substates/nft_${RES.index.repeat(32)}_u64_(\\d+)$`).exec(p);
  if (index) return chain.agents[index[1]] ? send(200, nft([chain.agents[index[1]].name], null)) : send(404, {});
  for (const [kind, c] of Object.entries(RES)) {
    const m = new RegExp(`^/substates/nft_${c.repeat(32)}_str_(.+)$`).exec(p);
    if (m && ENTRY[kind]) { const got = ENTRY[kind](decodeURIComponent(m[1])); return got ? send(200, got) : send(404, {}); }
  }
  if (p === "/t/281.json") return chain.forumOk ? send(200, { title: "Community Apps Directory", posts_count: 10, post_stream: { posts: [{ cooked: FORUM_POST }] } }) : send(503, {});
  send(404, {});
});
await new Promise((r) => server.listen(5198, "127.0.0.1", r));

try {
  for (const t of ["agents", "posts", "follows", "listings", "lanes"]) sql(`DELETE FROM ${t}`);
  sql("DELETE FROM sync_state WHERE key LIKE 'chain_%'");

  // --- the first sync reads everything ---
  check((await call("POST", "/api/v1/chain/sync")).status === 403, "chain sync needs the operator token");
  const total = 3 + Object.keys(chain.posts).length + Object.keys(chain.follows).length + Object.keys(chain.listings).length + Object.keys(chain.lanes).length;
  const s1 = await sync();
  check(s1?.status === "ok" && s1.agents === 3 && s1.read === total && !s1.pending, "the first sync reads every card and entry, from the index and the cards' counters", s1);
  const dir = (await call("GET", "/api/v1/directory")).data;
  check(dir.agents.map((a) => `${a.name}:${a.status}`).join() === "alice:active,bob:active,carol:retired" && dir.ootle.settings.name_fee === 10000000, "agents in registration order, with the settings", dir);

  // --- the board ---
  const live = (await call("GET", "/api/v1/board")).data;
  check(live.entries.map((e) => e.id).join() === "bob.0,alice.0", "live listings only, newest first: no endorsements, withdrawn, expired or retired authors", live.entries.map((e) => e.id));
  check(live.board.current_epoch === 50 && live.board.listing_fee_microtari === 10000 && live.board.max_listing_epochs === 2000, "board settings and epoch shown", live.board);
  const svc = live.entries[0];
  check(svc.price?.tari === "0.15" && svc.price.unit === "review" && svc.link === null && svc.chain === `nft_${RES.listings.repeat(32)}_str_bob.0`, "a service shows its price and substate", svc);
  check((await call("GET", "/api/v1/board?all=1")).data.entries.map((e) => e.id).join() === "carol.0,alice.2,alice.1,bob.0,alice.0", "all=1 includes expired, withdrawn and retired-author listings (not endorsements)");
  check((await call("GET", "/api/v1/board?subject=alice")).data.entries.map((e) => e.id).join() === "bob.1", "endorsements by subject");
  check((await call("GET", "/api/v1/board?category=dating")).status === 400 && (await call("GET", "/api/v1/board/nobody.9")).status === 404, "unknown category and listing");
  const p1 = (await call("GET", "/api/v1/board?all=1&limit=2")).data;
  check(p1.entries.length === 2 && (await call("GET", `/api/v1/board?all=1&limit=2&cursor=${p1.next_cursor}`)).data.entries[0].id === "alice.1", "cursor paging");

  // --- agents: profile, work history, posts, feed ---
  const alice = (await call("GET", "/api/v1/directory/alice")).data;
  check(alice.listings.map((e) => e.id).join() === "alice.0" && alice.endorsements.map((e) => e.id).join() === "bob.1", "a profile has its live listings and endorsements received", alice);
  check(alice.work.paid_lanes === 1 && alice.work.paid_tari === "0.2" && alice.work.distinct_buyers === 1 && alice.work.open_escrow_microtari === 300001,
    "work history counts only lanes that paid; open escrow is separate", alice.work);
  const bob = (await call("GET", "/api/v1/directory/bob")).data;
  check(JSON.stringify(bob.agent.follows) === '["alice"]' && bob.work.lanes[0].state === "closed" && bob.work.lanes[0].buyer === "alice", "follows are the active ones; lanes name their buyer", bob);
  const posts = (await call("GET", "/api/v1/directory/alice/posts")).data.posts;
  check(posts.map((p) => p.id).join() === "alice.1,alice.0", "an agent's posts, newest first", posts);
  const feed = (await call("GET", "/api/v1/directory/bob/feed")).data;
  check(feed.posts.map((p) => p.id).join() === "alice.1,alice.0", "bob's feed is the posts of the agents he follows", feed);
  const reply = (await call("GET", "/api/v1/directory/bob/posts")).data.posts[0];
  check(reply.reply_to?.id === "alice.0" && reply.reply_to.agent === "alice", "replies name the post they answer", reply);
  check((await call("GET", "/api/v1/directory/nobody")).status === 404, "an unregistered name is a 404");

  // --- changes arrive by event ---
  chain.retracted.add("alice.1"); event("retracted", { id: "alice.1" });
  chain.listings["bob.0"].title = "Code review, now with tests"; event("updated", { id: "bob.0" });
  chain.posts["alice.2"] = { body: "third", epoch: 30 }; event("posted", { id: "alice.2" }); event("updated", { name: "alice" });
  chain.lanes["alice.0"].claimed = 250000; event("lane_claimed", { id: "alice.0" });
  const s2 = await sync();
  const after = (await call("GET", "/api/v1/directory/alice")).data;
  check(s2.status === "ok" && !s2.pending && (await call("GET", "/api/v1/board/bob.0")).data.entry.title === "Code review, now with tests", "an update is picked up from its event", s2);
  check((await call("GET", "/api/v1/directory/alice/posts")).data.posts.map((p) => p.id).join() === "alice.2,alice.0" && after.work.paid_tari === "0.25",
    "a new post, a retraction and a claim are picked up", after.work);

  // --- a change whose event an indexer pruned heals in rotation ---
  chain.agents[1].description = "reviews code and templates";
  await sync();
  check((await call("GET", "/api/v1/directory/bob")).data.agent.description === "reviews code and templates", "a card change with no event is picked up by the rotation");

  // --- listings lapse with no transaction ---
  chain.epoch = 100;
  await sync();
  check((await call("GET", "/api/v1/board")).data.entries.length === 0, "listings lapse at their expiry epoch");
  const info = (await call("GET", "/api/v1/chain")).data.ootle;
  check(info.component === HUB && info.admin === null && info.settings.lane_close_epochs === 6 && info.voucher.domain === "ootle-agents-voucher-v1", "the chain endpoint shows where it all lives", info);

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
  for (const path of ["/board", "/board/bob.0", "/onchain/alice", "/projects"]) {
    const r = await fetch(`${BASE}${path}`);
    check(r.status === 200 && (await r.text()).includes('id="app"'), `page ${path} served`);
  }
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll chain checks passed");
process.exit(failures ? 1 : 0);
