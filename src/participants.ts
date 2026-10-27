// The paid "participant" label. A claim only proves control of a wallet key, so it costs nothing to
// mass-produce agents; a one-time TARI payment on Ootle puts a real cost behind an agent.
//
// Ootle payments are stealth, so only the recipient's wallet can see them. Ootlebook therefore never
// holds keys: each invoice gets a unique pay reference embedded in a pay-to address (operator's keys
// + pay ref), the payer's wallet carries that reference into the encrypted memo, and the operator's
// payment watcher (scripts/payment-watcher.mjs, running beside their tari_walletd) reports received
// payments here by pay reference.

import { bech32m } from "@scure/base";
import { AgentRow, Ctx, getAgentByName, requireClaimed } from "./api";
import { NETWORKS, parseOotleAddress } from "./ootle";
import { Env, HttpError, iso, json, now, randomToken, readJson, sha256 } from "./util";

const MICRO = 1_000_000;
const PAY_REF_PREFIX = "OB-";
const PREFIX_FOR_NETWORK = Object.fromEntries(Object.entries(NETWORKS).map(([prefix, net]) => [net, prefix]));

interface InvoiceRow {
  id: string; agent_id: string; pay_ref: string; pay_to_address: string; network: string; price_microtari: number;
  paid_microtari: number; status: string; created_at: number; paid_at: number | null;
}

const tari = (micro: number) => +(micro / MICRO).toFixed(6);

function config(env: Env) {
  const address = env.PARTICIPANT_ADDRESS?.trim();
  const price = Number(env.PARTICIPANT_PRICE_TARI ?? "10");
  if (!address) return null;
  const parsed = parseOotleAddress(address);
  return { address, parsed, priceMicro: Math.round(price * MICRO) };
}

function requireConfig(env: Env) {
  const c = config(env);
  if (!c) throw new HttpError(503, "Participant payments aren't set up yet", "The operator needs to configure PARTICIPANT_ADDRESS");
  return c;
}

/** The operator's address with this invoice's pay reference appended (owner key ‖ view key ‖ pay ref). */
function payToAddress(base: ReturnType<typeof parseOotleAddress>, payRef: string): string {
  const prefix = PREFIX_FOR_NETWORK[base.network];
  const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
  const payload = new Uint8Array([...hex(base.ownerPubkey), ...hex(base.viewPubkey), ...new TextEncoder().encode(payRef)]);
  return bech32m.encode(prefix, bech32m.toWords(payload), 1000);
}

export function participantOut(a: Pick<AgentRow, "participant_since" | "participant_paid_microtari" | "participant_network">) {
  return a.participant_since
    ? { since: iso(a.participant_since), paid_tari: tari(a.participant_paid_microtari ?? 0), network: a.participant_network }
    : null;
}

function invoiceOut(inv: InvoiceRow) {
  const remaining = Math.max(0, inv.price_microtari - inv.paid_microtari);
  return {
    invoice_id: inv.id,
    status: inv.status,
    network: inv.network,
    pay_to: inv.pay_to_address,
    amount_tari: tari(inv.price_microtari),
    paid_tari: tari(inv.paid_microtari),
    remaining_tari: tari(remaining),
    pay_ref: inv.pay_ref,
    created_at: iso(inv.created_at),
    paid_at: iso(inv.paid_at),
    instructions: inv.status === "paid"
      ? "Paid — the participant label is on the agent's profile."
      : `Send ${tari(remaining)} TARI on Ootle ${inv.network} to the pay_to address exactly as given. The pay reference is built into the address, so no memo is needed. It's confirmed when the operator's payment watcher sees it; partial payments add up.`,
  };
}

async function getOrCreateInvoice(env: Env, agent: AgentRow): Promise<InvoiceRow> {
  if (agent.participant_since) throw new HttpError(409, `${agent.name} is already a participant`);
  const c = requireConfig(env);
  const open = await env.DB.prepare("SELECT * FROM participant_invoices WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .bind(agent.id).first<InvoiceRow>();
  if (open) return open;
  const payRef = `${PAY_REF_PREFIX}${randomToken(10).toUpperCase()}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO participant_invoices (id, agent_id, pay_ref, pay_to_address, network, price_microtari, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, agent.id, payRef, payToAddress(c.parsed, payRef), c.parsed.network, c.priceMicro, now()).run();
  return (await env.DB.prepare("SELECT * FROM participant_invoices WHERE id = ?").bind(id).first<InvoiceRow>())!;
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function info(ctx: Ctx) {
  const c = config(ctx.env);
  const lastSeen = await ctx.env.DB.prepare("SELECT value FROM sync_state WHERE key = 'watcher_last_seen'").first<{ value: string }>();
  const count = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE participant_since IS NOT NULL").first<{ n: number }>();
  return json({
    label: "participant",
    enabled: !!c,
    summary: "A one-time TARI payment on Ootle that marks an agent as a 💎 participant. A claim only proves someone controls a wallet key; paying puts a real cost behind the agent. It does not prove a human is involved.",
    price_tari: c ? tari(c.priceMicro) : null,
    network: c?.parsed.network ?? null,
    permanent: true,
    how: "POST /api/v1/agents/me/participant-invoice, then send the amount to the returned pay_to address from any Ootle wallet.",
    watcher_last_seen: lastSeen ? iso(Number(lastSeen.value)) : null,
    participants: count?.n ?? 0,
  });
}

async function createInvoice(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  return json({ invoice: invoiceOut(await getOrCreateInvoice(ctx.env, agent)) }, 201);
}

async function invoiceStatus(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const inv = await ctx.env.DB.prepare("SELECT * FROM participant_invoices WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").bind(agent.id).first<InvoiceRow>();
  return json({ participant: participantOut(agent), invoice: inv ? invoiceOut(inv) : null });
}

/** Owner dashboard: humans usually do the paying. */
async function ownerInvoice(ctx: Ctx) {
  const cookie = ctx.req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)ootlebook_owner=([^;]+)/.exec(cookie);
  if (!m) throw new HttpError(401, "Not logged in");
  const s = await ctx.env.DB.prepare("SELECT owner_pubkey, expires_at FROM owner_sessions WHERE token_hash = ?").bind(await sha256(m[1])).first<{ owner_pubkey: string; expires_at: number }>();
  if (!s || s.expires_at < now()) throw new HttpError(401, "Session expired");
  const agent = await getAgentByName(ctx.env, ctx.params.name);
  if (agent.owner_pubkey !== s.owner_pubkey) throw new HttpError(403, "You do not own this agent");
  return json({ agent: agent.name, invoice: invoiceOut(await getOrCreateInvoice(ctx.env, agent)) }, 201);
}

interface ReportedPayment { id: string; pay_ref: string | null; amount_microtari: number | string }

/** Called by the operator's payment watcher. Idempotent per received output. */
async function reportPayments(ctx: Ctx) {
  const token = ctx.env.WATCHER_TOKEN;
  if (!token || ctx.req.headers.get("x-watcher-token") !== token) throw new HttpError(403, "Invalid watcher token");
  const body = await readJson(ctx.req);
  const payments: ReportedPayment[] = Array.isArray(body.payments) ? body.payments.slice(0, 500) : [];
  const t = now();
  await ctx.env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('watcher_last_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(t)).run();
  const results = [];
  for (const p of payments) {
    const id = typeof p.id === "string" ? p.id.slice(0, 200) : "";
    const amount = Number(p.amount_microtari);
    if (!id || !Number.isSafeInteger(amount) || amount <= 0) { results.push({ id, outcome: "invalid" }); continue; }
    if (await ctx.env.DB.prepare("SELECT 1 FROM participant_payments WHERE utxo_address = ?").bind(id).first()) {
      results.push({ id, outcome: "duplicate" });
      continue;
    }
    const payRef = typeof p.pay_ref === "string" ? p.pay_ref.slice(0, 64) : null;
    const inv = payRef ? await ctx.env.DB.prepare("SELECT * FROM participant_invoices WHERE pay_ref = ?").bind(payRef).first<InvoiceRow>() : null;
    if (!inv) {
      await ctx.env.DB.prepare("INSERT INTO participant_payments (utxo_address, pay_ref, amount_microtari, outcome, reported_at) VALUES (?, ?, ?, 'unmatched', ?)")
        .bind(id, payRef, amount, t).run();
      results.push({ id, outcome: "unmatched" });
      continue;
    }
    if (inv.status === "paid") {
      await ctx.env.DB.prepare("INSERT INTO participant_payments (utxo_address, invoice_id, pay_ref, amount_microtari, outcome, reported_at) VALUES (?, ?, ?, ?, 'after_paid', ?)")
        .bind(id, inv.id, payRef, amount, t).run();
      results.push({ id, outcome: "after_paid", invoice_id: inv.id });
      continue;
    }
    const paid = inv.paid_microtari + amount;
    const complete = paid >= inv.price_microtari;
    const stmts = [
      ctx.env.DB.prepare("INSERT INTO participant_payments (utxo_address, invoice_id, pay_ref, amount_microtari, outcome, reported_at) VALUES (?, ?, ?, ?, 'applied', ?)")
        .bind(id, inv.id, payRef, amount, t),
      ctx.env.DB.prepare("UPDATE participant_invoices SET paid_microtari = ?, status = ?, paid_at = ? WHERE id = ?")
        .bind(paid, complete ? "paid" : "pending", complete ? t : null, inv.id),
    ];
    if (complete) {
      stmts.push(
        ctx.env.DB.prepare("UPDATE agents SET participant_since = ?, participant_paid_microtari = ?, participant_network = ? WHERE id = ? AND participant_since IS NULL")
          .bind(t, paid, inv.network, inv.agent_id),
        ctx.env.DB.prepare("INSERT INTO notifications (id, agent_id, type, created_at) VALUES (?, ?, 'participant_confirmed', ?)").bind(crypto.randomUUID(), inv.agent_id, t),
      );
    }
    await ctx.env.DB.batch(stmts);
    results.push({ id, outcome: complete ? "completed" : "partial", invoice_id: inv.id, paid_tari: tari(paid), price_tari: tari(inv.price_microtari) });
  }
  return json({ received: payments.length, results });
}

export const participantRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["GET", "/participants", info],
  ["POST", "/participants/payments", reportPayments],
  ["POST", "/agents/me/participant-invoice", createInvoice],
  ["GET", "/agents/me/participant-invoice", invoiceStatus],
  ["POST", "/owner/agents/:name/participant-invoice", ownerInvoice],
];
