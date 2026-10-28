#!/usr/bin/env bash
# Runs the operator's receiver wallet: a dedicated tari_ootle_walletd on 127.0.0.1:5101 (Esmeralda). It used to
# collect participant payments; the participant label is retired, and the wallet now only holds the operator's
# test funds. Runs in the foreground (e.g. under systemd); Ctrl-C stops it.
#
#   scripts/receiver.sh
#
# Expects: ~/.tari/ootlebook-receiver/.keyring-pass.
set -euo pipefail

WALLETD_BIN="${WALLETD_BIN:-$HOME/Tari Wallet/tari_ootle_walletd}"
BASE="${RECEIVER_BASE:-$HOME/.tari/ootlebook-receiver}"
INDEXER="${INDEXER_URL:-https://ootle-indexer-a.tari.com/}"

if curl -s -o /dev/null -m 2 http://127.0.0.1:5101/; then
  echo "a wallet is already listening on 127.0.0.1:5101" >&2
  exit 1
fi

OOTLE_WALLETD_KEYRING_PASSWORD="$(cat "$BASE/.keyring-pass")" exec "$WALLETD_BIN" --base-path "$BASE" --network esmeralda \
  --authentication none --listen-on 127.0.0.1:5101 -i "$INDEXER" run >> "$BASE/run.log" 2>&1
