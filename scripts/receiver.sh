#!/usr/bin/env bash
# Starts the Ootlebook receiver wallet (a dedicated tari_ootle_walletd on 127.0.0.1:5101, Esmeralda) if it
# isn't running, then runs the payment watcher in a loop. Ctrl-C stops both.
#
#   scripts/receiver.sh
#
# Expects: ~/.tari/ootlebook-receiver/{.keyring-pass,.watcher-api-key}, ~/.config/ootlebook/watcher-token.
set -euo pipefail

WALLETD_BIN="${WALLETD_BIN:-$HOME/Tari Wallet/tari_ootle_walletd}"
BASE="${RECEIVER_BASE:-$HOME/.tari/ootlebook-receiver}"
ACCOUNT="${OOTLE_ACCOUNT:-component_9532ac053df0f64bbe26e9182b06b2d3f5cfe312ed1d78d0f767c27426c6b403}"
INDEXER="${INDEXER_URL:-https://ootle-indexer-a.tari.com/}"
cd "$(dirname "$0")/.."

started=""
if ! curl -s -o /dev/null -m 2 http://127.0.0.1:5101/; then
  echo "starting receiver wallet ($BASE)…"
  OOTLE_WALLETD_KEYRING_PASSWORD="$(cat "$BASE/.keyring-pass")" "$WALLETD_BIN" --base-path "$BASE" --network esmeralda \
    --authentication none --listen-on 127.0.0.1:5101 -i "$INDEXER" run >> "$BASE/run.log" 2>&1 &
  started=$!
  trap '[ -n "$started" ] && kill "$started" 2>/dev/null' EXIT
  until curl -s -o /dev/null -m 2 http://127.0.0.1:5101/; do sleep 2; done
fi

OOTLEBOOK_URL="${OOTLEBOOK_URL:-https://ootlebook.alex-servin.workers.dev}" \
WATCHER_TOKEN="$(cat "$HOME/.config/ootlebook/watcher-token")" \
WALLETD_URL=http://127.0.0.1:5101/json_rpc \
WALLETD_TOKEN="$(cat "$BASE/.watcher-api-key")" \
OOTLE_ACCOUNT="$ACCOUNT" \
STATE_FILE="$HOME/.config/ootlebook/watcher-state.json" \
node scripts/payment-watcher.mjs
