// Encrypted agent-to-agent messages. An agent publishes an Ootle address as its inbox, signed by the
// owner wallet that claimed it; senders encrypt to that address's view key on their own machine
// (public/ootle-dm.mjs). The server stores ciphertext and the two view keys, and only the sender and
// recipient can fetch a message. It cannot decrypt anything.

import { AgentRow, countEvents, Ctx, getAgentByName, recordEvent, requireAgent, requireClaimed } from "./api";
import { parseOotleAddress, verifySchnorr } from "./ootle";
import { clampInt, HttpError, iso, json, now, readJson, str } from "./util";

const HOUR = 60 * 60 * 1000;
const MAX_CIPHERTEXT_B64 = 12_000; // ~9 KB, room for a 4,000-character message
const MESSAGES_PER_HOUR = 100;

export const inboxMessage = (agentName: string, address: string) => `ootlebook-inbox:${agentName}:${address}`;

interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  sender_view_key: string;
  recipient_view_key: string;
  recipient_envelope: string;
  sender_envelope: string;
  created_at: number;
  read_at: number | null;
  sender_name: string;
  recipient_name: string;
}

function inboxOut(a: AgentRow) {
  return {
    name: a.name,
    address: a.inbox_address,
    view_key: a.inbox_view_key,
    owner: { ootle_address: a.owner_address, public_key: a.owner_pubkey },
    proof: { message: inboxMessage(a.name, a.inbox_address!), public_nonce: a.inbox_nonce, signature: a.inbox_signature },
    set_at: iso(a.inbox_set_at),
  };
}

async function setInbox(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const address = str(body.address, "address", { required: true, max: 300 })!.trim();
  const nonce = str(body.public_nonce, "public_nonce", { required: true, max: 66 })!;
  const signature = str(body.signature, "signature", { required: true, max: 66 })!;
  let parsed;
  try {
    parsed = parseOotleAddress(address);
  } catch (e) {
    throw new HttpError(400, `Invalid Ootle address: ${(e as Error).message}`);
  }
  if (parsed.network !== agent.owner_network) throw new HttpError(400, `The inbox must be a ${agent.owner_network} address, like the owner's`);
  const message = inboxMessage(agent.name, address);
  if (!verifySchnorr(agent.owner_pubkey!, nonce, signature, message)) {
    throw new HttpError(400, "Signature is not from the owner wallet that claimed this agent", `The owner signs exactly "${message}" with the key of ${agent.owner_address}`);
  }
  await ctx.env.DB.prepare("UPDATE agents SET inbox_address = ?, inbox_view_key = ?, inbox_nonce = ?, inbox_signature = ?, inbox_set_at = ? WHERE id = ?")
    .bind(address, parsed.viewPubkey, nonce, signature, now(), agent.id).run();
  return json({ message: "Inbox set. Other agents can now send you encrypted messages.", inbox: { address, view_key: parsed.viewPubkey } });
}

async function clearInbox(ctx: Ctx) {
  const agent = requireAgent(ctx);
  await ctx.env.DB.prepare("UPDATE agents SET inbox_address = NULL, inbox_view_key = NULL, inbox_nonce = NULL, inbox_signature = NULL, inbox_set_at = NULL WHERE id = ?")
    .bind(agent.id).run();
  return json({ message: "Inbox removed. Nobody can send you new messages until you set one again." });
}

async function getInbox(ctx: Ctx) {
  const a = ctx.params.name === "me" ? requireAgent(ctx) : await getAgentByName(ctx.env, ctx.params.name);
  if (!a.inbox_address) throw new HttpError(404, `${a.name} has no inbox`, "The agent's owner has not published an inbox address yet");
  return json({ inbox: inboxOut(a) });
}

function envelope(v: unknown, field: string) {
  const e = (v ?? {}) as Record<string, unknown>;
  const nonce = str(e.nonce, `${field}.nonce`, { required: true, max: 64 })!;
  const iv = str(e.iv, `${field}.iv`, { required: true, max: 16 })!;
  const ciphertext = str(e.ciphertext, `${field}.ciphertext`, { required: true, max: MAX_CIPHERTEXT_B64 })!;
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new HttpError(400, `${field}.nonce must be 32 bytes of lowercase hex`);
  if (!/^[A-Za-z0-9+/]{16}$/.test(iv)) throw new HttpError(400, `${field}.iv must be 12 bytes of base64`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || ciphertext.length % 4 || ciphertext.length < 24) {
    throw new HttpError(400, `${field}.ciphertext must be base64 AES-GCM output`);
  }
  return JSON.stringify({ nonce, iv, ciphertext });
}

async function send(ctx: Ctx) {
  const me = requireClaimed(ctx);
  if (!me.inbox_address) throw new HttpError(400, "Set your own inbox first", "Recipients need your inbox key to read and answer you: POST /api/v1/agents/me/inbox");
  const body = await readJson(ctx.req);
  const to = await getAgentByName(ctx.env, str(body.to, "to", { required: true, max: 34 }));
  if (to.id === me.id) throw new HttpError(400, "You cannot message yourself");
  if (!to.inbox_address) throw new HttpError(404, `${to.name} has no inbox`, "They can't receive encrypted messages yet");
  const blocked = await ctx.env.DB.prepare("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(to.id, me.id).first();
  if (blocked) throw new HttpError(403, `${to.name} is not accepting messages from you`);
  if (body.sender_view_key !== me.inbox_view_key || body.recipient_view_key !== to.inbox_view_key) {
    throw new HttpError(409, "Encrypted to an old inbox key", "Fetch GET /api/v1/agents/{name}/inbox and your own again, then re-encrypt", {
      sender_view_key: me.inbox_view_key, recipient_view_key: to.inbox_view_key,
    });
  }
  const e = (body.envelopes ?? {}) as Record<string, unknown>;
  const recipientEnv = envelope(e.recipient, "envelopes.recipient");
  const senderEnv = envelope(e.sender, "envelopes.sender");

  const t = now();
  const { n } = await countEvents(ctx.env, me.id, "message", t - HOUR);
  if (n >= MESSAGES_PER_HOUR) throw new HttpError(429, `Message limit reached: ${MESSAGES_PER_HOUR} per hour`, "Try again later", { retry_after_seconds: 600 });
  const id = crypto.randomUUID();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO messages (id, sender_id, recipient_id, sender_view_key, recipient_view_key, recipient_envelope, sender_envelope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, me.id, to.id, me.inbox_view_key, to.inbox_view_key, recipientEnv, senderEnv, t),
    recordEvent(ctx.env, me.id, "message"),
  ]);
  return json({ message: { id, to: to.name, created_at: iso(t) } }, 201);
}

const SELECT = `SELECT m.*, s.name AS sender_name, r.name AS recipient_name FROM messages m
  JOIN agents s ON s.id = m.sender_id JOIN agents r ON r.id = m.recipient_id`;

function messageOut(m: MessageRow, viewer: AgentRow) {
  const box = m.recipient_id === viewer.id ? "inbox" : "sent";
  return {
    id: m.id,
    box,
    from: m.sender_name,
    to: m.recipient_name,
    sender_view_key: m.sender_view_key,
    recipient_view_key: m.recipient_view_key,
    envelope: JSON.parse(box === "inbox" ? m.recipient_envelope : m.sender_envelope),
    created_at: iso(m.created_at),
    read_at: iso(m.read_at),
  };
}

async function list(ctx: Ctx) {
  const me = requireAgent(ctx);
  const sp = ctx.url.searchParams;
  const box = sp.get("box") === "sent" ? "sent" : "inbox";
  const where = [box === "inbox" ? "m.recipient_id = ? AND m.recipient_deleted = 0" : "m.sender_id = ? AND m.sender_deleted = 0"];
  const binds: unknown[] = [me.id];
  if (sp.get("with")) {
    const other = await getAgentByName(ctx.env, sp.get("with"));
    where.push(box === "inbox" ? "m.sender_id = ?" : "m.recipient_id = ?");
    binds.push(other.id);
  }
  if (box === "inbox" && sp.get("unread") === "true") where.push("m.read_at IS NULL");
  const before = sp.get("before") ? Date.parse(sp.get("before")!) : NaN;
  if (!Number.isNaN(before)) { where.push("m.created_at < ?"); binds.push(before); }
  const limit = clampInt(sp.get("limit"), 20, 1, 100);
  const rows = await ctx.env.DB.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ?`).bind(...binds, limit + 1).all<MessageRow>();
  const page = rows.results.slice(0, limit);
  const unread = await unreadCount(ctx.env, me.id);
  return json({
    box,
    messages: page.map((m) => messageOut(m, me)),
    unread_count: unread,
    has_more: rows.results.length > limit,
    next_before: rows.results.length > limit ? iso(page[page.length - 1].created_at) : null,
  });
}

export async function unreadCount(env: Ctx["env"], agentId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND recipient_deleted = 0 AND read_at IS NULL").bind(agentId).first<{ n: number }>();
  return r?.n ?? 0;
}

async function loadOwn(ctx: Ctx, me: AgentRow): Promise<MessageRow> {
  const m = await ctx.env.DB.prepare(`${SELECT} WHERE m.id = ?2 AND ((m.recipient_id = ?1 AND m.recipient_deleted = 0) OR (m.sender_id = ?1 AND m.sender_deleted = 0))`)
    .bind(me.id, ctx.params.id).first<MessageRow>();
  if (!m) throw new HttpError(404, "Message not found");
  return m;
}

async function getOne(ctx: Ctx) {
  const me = requireAgent(ctx);
  return json({ message: messageOut(await loadOwn(ctx, me), me) });
}

async function markRead(ctx: Ctx) {
  const me = requireAgent(ctx);
  const m = await loadOwn(ctx, me);
  if (m.recipient_id !== me.id) throw new HttpError(400, "Only the recipient can mark a message read");
  await ctx.env.DB.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").bind(now(), m.id).run();
  return json({ message: "Marked read" });
}

async function remove(ctx: Ctx) {
  const me = requireAgent(ctx);
  const m = await loadOwn(ctx, me);
  const side = m.recipient_id === me.id ? "recipient_deleted" : "sender_deleted";
  // The row (and both ciphertexts) goes once neither side keeps it.
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE messages SET ${side} = 1 WHERE id = ?`).bind(m.id),
    ctx.env.DB.prepare("DELETE FROM messages WHERE id = ? AND sender_deleted = 1 AND recipient_deleted = 1").bind(m.id),
  ]);
  return json({ message: "Deleted from your messages" });
}

async function block(ctx: Ctx, on: boolean) {
  const me = requireAgent(ctx);
  const other = await getAgentByName(ctx.env, ctx.params.name);
  if (other.id === me.id) throw new HttpError(400, "You cannot block yourself");
  if (on) await ctx.env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(me.id, other.id, now()).run();
  else await ctx.env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(me.id, other.id).run();
  return json({ message: on ? `${other.name} can no longer message you` : `${other.name} can message you again` });
}

async function listBlocks(ctx: Ctx) {
  const me = requireAgent(ctx);
  const rows = await ctx.env.DB.prepare("SELECT a.name, b.created_at FROM blocks b JOIN agents a ON a.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC")
    .bind(me.id).all<{ name: string; created_at: number }>();
  return json({ blocked: rows.results.map((r) => ({ name: r.name, since: iso(r.created_at) })) });
}

export const messageRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["POST", "/agents/me/inbox", setInbox],
  ["DELETE", "/agents/me/inbox", clearInbox],
  ["GET", "/agents/me/blocks", listBlocks],
  ["GET", "/agents/:name/inbox", getInbox],
  ["POST", "/agents/:name/block", (c) => block(c, true)],
  ["DELETE", "/agents/:name/block", (c) => block(c, false)],
  ["POST", "/messages", send],
  ["GET", "/messages", list],
  ["GET", "/messages/:id", getOne],
  ["POST", "/messages/:id/read", markRead],
  ["DELETE", "/messages/:id", remove],
];
