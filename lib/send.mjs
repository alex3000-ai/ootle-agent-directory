// Sending: each chunk becomes the memo of a 1 µT stealth output to the recipient, sent through the agent's
// own Ootle wallet daemon (tari_ootle_walletd). Inputs and the fee come from stealth funds only
// (ConfidentialOnly), so the public transaction shows no account of the sender's.

import { TARI } from "./scan.mjs";
import { toHex } from "./message.mjs";

// Paying the fee inside the transfer statement stretches to two recipient outputs plus change; more
// needs a separate fee input. Two chunks per transaction keeps every send to a single stealth input.
const CHUNKS_PER_TX = 2;
const DUST = 1; // µT carried by each message output

export function walletd({ url = "http://127.0.0.1:5100/json_rpc", token }) {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await res.json().catch(() => ({ error: { message: `walletd HTTP ${res.status}` } }));
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

const transferParams = (account, to, chunks, maxFee, dryRun) => ({
  owner_account: { Name: account },
  fee_params: { input_selection: "ConfidentialOnly", pay_fee_with_swap: null },
  input_selection: "ConfidentialOnly",
  resource_address: TARI,
  badge_usage: "None",
  transfers: chunks.map((c) => ({
    destination_address: to, blinded_output_amount: DUST, revealed_output_amount: 0,
    output_memo: { Bytes: toHex(c) }, pay_to: "StealthPublicKey", attach_sender_address: false, pay_ref: null,
  })),
  max_fee: maxFee,
  dry_run: dryRun,
});

/**
 * Send the chunks of one message, two per transaction. Each transaction is dry-run first and then sent
 * with max_fee set just above that estimate (walletd charges the whole max_fee, not the actual cost).
 * Returns [{transaction_id, fee, chunks}]. Stops at the first failure; earlier transactions stay sent.
 */
export async function sendChunks(rpc, { account = "agent", to, chunks, feeCeiling = 100_000, onTx }) {
  const sent = [];
  for (let i = 0; i < chunks.length; i += CHUNKS_PER_TX) {
    const group = chunks.slice(i, i + CHUNKS_PER_TX);
    const dry = await rpc("accounts.stealth_transfer", transferParams(account, to, group, feeCeiling, true));
    const est = await rpc("transactions.wait_result", { transaction_id: dry.transaction_id, timeout_secs: 60 });
    // A dry run can "succeed" with an outcome that would fail on the network (Reject, or AcceptFeeRejectRest:
    // fee taken, transfer rejected).
    const outcome = JSON.stringify(est.result ?? est);
    if (/"(Reject|AcceptFeeRejectRest)"\s*:/.test(outcome)) {
      throw new Error(`dry run rejected: ${(outcome.match(/"ExecutionFailure":\s*(\{[^}]*\})/)?.[1] ?? "the transfer would fail").slice(0, 300)}`);
    }
    if (!est.final_fee) throw new Error("dry run returned no fee estimate");
    // walletd charges the whole max_fee, but a dry run's estimate has come in up to ~12% low, and a transfer that
    // runs out of fee fails and still costs it. Leave 10%.
    const maxFee = Math.ceil(est.final_fee * 1.1);
    if (maxFee > feeCeiling) throw new Error(`fee ${maxFee} µT is above the ceiling ${feeCeiling}`);
    const tx = await rpc("accounts.stealth_transfer", transferParams(account, to, group, maxFee, false));
    const result = await rpc("transactions.wait_result", { transaction_id: tx.transaction_id, timeout_secs: 120 });
    if (result.status !== "Accepted") throw new Error(`transaction ${tx.transaction_id} ${result.status}${result.timed_out ? " (timed out)" : ""}`);
    const entry = { transaction_id: tx.transaction_id, fee: result.final_fee, chunks: group.length };
    sent.push(entry);
    onTx?.(entry);
  }
  return sent;
}
