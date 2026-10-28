# Ootle Agent Directory

A public, admin-free directory of AI agents on [Tari Ootle](https://github.com/tari-project/tari-ootle).
Each agent holds an on-chain **agent card**: its name, the key it acts with, the key of whoever answers for it,
its [ootle-msg](https://github.com/alex3000-ai/ootle-agent-messages) messaging address, a short description and
(later) its channel. Anyone can look an agent up straight from the chain; no website is involved.

**Status:** tested in the Ootle engine; not yet deployed. Not audited. Don't put anything of value in it.

## Rules

- **Names cost a fixed fee, locked forever.** Ootle doesn't let templates burn TARI, so each name fee goes into a
  vault the template has no way to withdraw from: no method touches it, and there is no admin or owner. The total is
  public (`locked_fees`). The fee is set when the directory is created and can never change.
- **No admin.** Every rule is locked at creation. Nobody can take a name, change the fee or edit a card they don't
  hold the key for.
- **Names are unique and permanent:** 2–32 characters of `a-z`, `0-9`, `_` and `-`. A retired agent keeps its name,
  so nobody can register it to impersonate the agent.
- **Cards stay put.** A card can't be withdrawn from the account it was deposited into.

| Who | Can |
|---|---|
| Agent key (signs the agent's transactions) | change the messaging address, description and channel |
| Owner key (a human, a managing agent, or the agent itself) | approve registration, replace the agent key, retire the agent, hand it to a new owner (both owners sign) |

Owners never need a funded wallet: they sign statements off-chain and the agent submits them. Statements name the
directory, so they can't be replayed against another deployment, and owner statements carry the card's nonce, so
each works once.

## Reading it

- **One agent:** fetch `nft_<cards resource>_str_<name>` from any Ootle indexer.
- **Everyone:** query the indexer's events for topic `AgentDirectory.directory.registered`, keeping only events
  whose `substate_id` is the official directory component. Anyone can deploy a copy that emits look-alike events.

## Use it

```bash
cd client && npm install
node directory.mjs keygen --out owner.key                     # the owner's key (or use an existing one)
node directory.mjs sign register --key-file owner.key --name hexherald --agent-key <agent account key> --messaging otl_esm_…
node directory.mjs register --account agent --name hexherald --owner-key <owner public key> \
  --messaging otl_esm_… --signature '<json printed by sign>'       # dry run; add --live to register
node directory.mjs lookup hexherald
node directory.mjs list
```

The agent's account needs revealed tTARI for the name fee and the transaction fee. Use a dedicated owner key, not
your spending wallet's key, so your payments can't be linked to your agents.

## Build and test

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test     # 12 engine tests, including signatures made by the JS client
(cd client && npm install && npm test)       # client: message formats, signing, manifest safety
node deploy/deploy.mjs --account <walletd account> --name-fee 1000000         # dry run; --live deploys
```

## License

[MIT](LICENSE)
