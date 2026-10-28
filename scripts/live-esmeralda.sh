#!/usr/bin/env bash
# Live round trip on Esmeralda: two fresh identities, A -> B (short + multi-transaction), B -> A, both
# sides find their messages by scanning the public indexer. Costs about 0.07 tTARI from WALLET_ACCOUNT.
#   WALLETD_TOKEN_FILE=~/.tari/ootle-agent/.api-key WALLET_ACCOUNT=agent npm run live
set -euo pipefail
cd "$(dirname "$0")/.."
M="node --no-warnings --experimental-wasm-modules bin/ootle-msg.mjs"
RUN=".live/run-$(date +%s)"; mkdir -p "$RUN"
OOTLE_MSG_HOME=$RUN/a $M keygen >/dev/null; OOTLE_MSG_HOME=$RUN/b $M keygen >/dev/null
A=$(OOTLE_MSG_HOME=$RUN/a $M address); B=$(OOTLE_MSG_HOME=$RUN/b $M address)
OOTLE_MSG_HOME=$RUN/a $M contact add bob "$B" >/dev/null; OOTLE_MSG_HOME=$RUN/b $M contact add alice "$A" >/dev/null
OOTLE_MSG_HOME=$RUN/b $M check; OOTLE_MSG_HOME=$RUN/a $M check   # first scans cover the whole network
LONG="$(node -e 'console.log(require("crypto").randomBytes(420).toString("base64"))')"
OOTLE_MSG_HOME=$RUN/a $M send bob "hello Bob"
OOTLE_MSG_HOME=$RUN/a $M send bob "$LONG"
OOTLE_MSG_HOME=$RUN/b $M send alice "hello Alice"
count() { python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['inbox']))" "$1/state.json"; }
for i in $(seq 1 30); do
  OOTLE_MSG_HOME=$RUN/b $M check >/dev/null; OOTLE_MSG_HOME=$RUN/a $M check >/dev/null
  [ "$(count $RUN/b)" -ge 2 ] && [ "$(count $RUN/a)" -ge 1 ] && break; sleep 10
done
OOTLE_MSG_HOME=$RUN/b $M inbox > "$RUN/b.txt"; OOTLE_MSG_HOME=$RUN/a $M inbox > "$RUN/a.txt"
ok=0
grep -q "hello Bob" "$RUN/b.txt" && grep -qF "$LONG" "$RUN/b.txt" && grep -q "hello Alice" "$RUN/a.txt" && ok=1
[ $ok = 1 ] && echo "✅ live round trip passed" || { echo "❌ live round trip failed (see $RUN)"; exit 1; }
