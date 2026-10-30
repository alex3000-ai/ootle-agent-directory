// Indexers from Tari Ootle v0.48 send substate values and events as base64 CBOR; older ones send JSON. Tari's own
// decoder turns the CBOR back into exactly that JSON, so the sync accepts both.

// @ts-expect-error wasm-bindgen glue, untyped
import * as bg from "@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.js";
// @ts-expect-error Workers import .wasm files as compiled modules
import wasm from "@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.wasm";

const instance = new WebAssembly.Instance(wasm, { "./ootle_wasm_bor_bg.js": bg });
bg.__wbg_set_wasm(instance.exports);
(instance.exports.__wbindgen_start as () => void)();

const plain = (v: unknown, decode: (s: string) => string) => (typeof v === "string" ? JSON.parse(decode(v)) : v);

/** An indexer response body with its substate value and events as JSON. */
export function plainBody(body: any) {
  const up = body?.state?.up;
  if (up) up.substate = plain(up.substate, bg.decodeSubstateValue);
  if (Array.isArray(body?.events)) body.events = body.events.map(([id, e]: [string, unknown]) => [id, plain(e, bg.decodeEvent)]);
  return body;
}
