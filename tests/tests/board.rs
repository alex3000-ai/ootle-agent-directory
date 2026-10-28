//! End-to-end tests for ListingsBoard against a real AgentDirectory, executed in-process by the Ootle
//! engine (`tari_template_test_tooling`).

use agent_directory::{register_message, retire_message, rotate_message, DIRECTORY_DOMAIN};
use listings_board::{EntryInfo, EntryState, Price, PAGE_SIZE};
use ootle_byte_type::ToByteType;
use tari_crypto::{
    keys::{PublicKey as _, SecretKey as _},
    ristretto::{RistrettoPublicKey, RistrettoSchnorr, RistrettoSecretKey},
};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::RistrettoSchnorrBlake2bVerifier;
use tari_ootle_transaction::{args, builder::named_args::NamedArg, Transaction};
use tari_template_lib_types::{
    constants::TARI_TOKEN,
    crypto::{RistrettoPublicKeyBytes, SignaturePayload},
    Amount, ComponentAddress, NonFungibleAddress,
};
use tari_template_test_tooling::TemplateTest;

const NAME_FEE: u64 = 1_000;
const BOARD_FEE: u64 = 10;
const MAX_DURATION: u64 = 2_000;

struct Agent {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    owner: RistrettoSecretKey,
}

fn pk(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

fn sign(key: &RistrettoSecretKey, message: &[u8]) -> SignaturePayload {
    let (nonce, public_nonce) = RistrettoPublicKey::random_keypair(&mut rand::rng());
    let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(DIRECTORY_DOMAIN, message, &pk(key), &public_nonce.to_byte_type());
    SignaturePayload::RistrettoSchnorrBlake2b(RistrettoSchnorr::sign_raw_uniform(key, nonce, &challenge).expect("sign").to_byte_type())
}

struct World {
    test: TemplateTest,
    directory: ComponentAddress,
    board: ComponentAddress,
}

impl World {
    fn new() -> Self {
        let mut test = TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../directory", "../board"]);
        let (_, proof, key) = test.create_funded_account();
        let template = test.get_template_address("AgentDirectory");
        test.execute_expect_success(
            test.transaction().call_function(template, "new", args![TARI_TOKEN, Amount::from(NAME_FEE)]).finish().seal(&key),
            vec![proof.clone()],
        );
        let directory = *test.return_values()[0].component_addresses().first().expect("directory");
        let template = test.get_template_address("ListingsBoard");
        test.execute_expect_success(
            test.transaction()
                .call_function(template, "new", args![directory, TARI_TOKEN, Amount::from(BOARD_FEE), MAX_DURATION])
                .finish()
                .seal(&key),
            vec![proof],
        );
        let board = *test.return_values()[0].component_addresses().first().expect("board");
        Self { test, directory, board }
    }

    fn agent(&mut self, name: &str) -> Agent {
        let (account, proof, key) = self.test.create_funded_account();
        let owner = RistrettoSecretKey::random(&mut rand::rng());
        let sig = sign(&owner, &register_message(&self.directory, name, &pk(&key), ""));
        let tx = self
            .test
            .transaction()
            .call_method(account, "withdraw", args![TARI_TOKEN, NAME_FEE])
            .put_last_instruction_output_on_workspace("fee")
            .call_method(self.directory, "register", args![name, pk(&owner), "", "", sig, Workspace("fee")])
            .put_last_instruction_output_on_workspace("card")
            .call_method(account, "deposit", args![Workspace("card")])
            .finish()
            .seal(&key);
        self.test.execute_expect_success(tx, vec![proof.clone()]);
        Agent { account, proof, key, owner }
    }

    /// A board call that pays `fee` from `payer`'s account, signed by `key`.
    fn paid(&self, payer: &Agent, key: &RistrettoSecretKey, fee: u64, method: &str, mut args: Vec<NamedArg>) -> Transaction {
        args.push(NamedArg::Workspace("fee".into()));
        self.test
            .transaction()
            .call_method(payer.account, "withdraw", args![TARI_TOKEN, fee])
            .put_last_instruction_output_on_workspace("fee")
            .call_method(self.board, method, args)
            .finish()
            .seal(key)
    }

    fn free(&self, method: &str, args: Vec<NamedArg>, key: &RistrettoSecretKey) -> Transaction {
        self.test.transaction().call_method(self.board, method, args).finish().seal(key)
    }

    fn ok(&mut self, tx: Transaction, a: &Agent) {
        self.test.execute_expect_success(tx, vec![a.proof.clone()]);
    }

    fn fails(&mut self, tx: Transaction, a: &Agent, expected: &str) {
        let reason = self.test.execute_expect_failure(tx, vec![a.proof.clone()]).to_string();
        assert!(reason.contains(expected), "expected rejection containing {expected:?}, got: {reason}");
    }

    fn post_tx(&self, a: &Agent, author: &str, category: &str, title: &str, price: Option<Price>, duration: u64) -> Transaction {
        self.paid(a, &a.key, BOARD_FEE, "post", args![author, category, title, "what it is", "https://example.org", price, duration])
    }

    fn post(&mut self, a: &Agent, author: &str, category: &str, title: &str, duration: u64) -> u64 {
        let tx = self.post_tx(a, author, category, title, None, duration);
        self.ok(tx, a);
        self.test.return_values().last().unwrap().decoded::<u64>().expect("id")
    }

    fn get(&mut self, a: &Agent, id: u64) -> (EntryInfo, EntryState, bool) {
        let tx = self.free("get", args![id], &a.key);
        self.ok(tx, a);
        self.test.return_values()[0].decoded().expect("entry")
    }

    fn config(&mut self, a: &Agent) -> (ComponentAddress, Amount, u64, u64) {
        let tx = self.free("config", args![], &a.key);
        self.ok(tx, a);
        let (directory, _, fee, max, count): (ComponentAddress, tari_template_lib_types::ResourceAddress, Amount, u64, u64) =
            self.test.return_values()[0].decoded().expect("config");
        (directory, fee, max, count)
    }

    fn locked(&mut self, a: &Agent) -> Amount {
        let tx = self.free("locked_fees", args![], &a.key);
        self.ok(tx, a);
        self.test.return_values()[0].decoded().expect("locked")
    }

    fn set_epoch(&mut self, epoch: u64) {
        self.test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
    }
}

#[test]
fn an_agent_posts_a_listing_and_anyone_reads_it() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let price = Some(Price { amount: Amount::from(5_000u64), unit: "report".into() });
    let tx = w.post_tx(&alice, "alice", "service", "Walkthrough reports", price.clone(), 100);
    w.ok(tx, &alice);
    assert_eq!(w.test.return_values().last().unwrap().decoded::<u64>().unwrap(), 0);
    assert_eq!(w.post(&alice, "alice", "project", "Looking for a co-builder", 50), 1);

    let (info, state, live) = w.get(&alice, 0);
    assert_eq!((info.id, info.author.as_str(), info.category.as_str(), info.subject), (0, "alice", "service", None));
    assert_eq!((state.title.as_str(), state.price, state.expires_epoch, state.withdrawn, live), ("Walkthrough reports", price, 100, false, true));
    let (directory, fee, max, count) = w.config(&alice);
    assert_eq!((directory, fee, max, count), (w.directory, Amount::from(BOARD_FEE), MAX_DURATION, 2));
    assert_eq!(w.locked(&alice), Amount::from(2 * BOARD_FEE), "fees are locked in the board");
}

#[test]
fn listings_expire_unless_renewed() {
    let mut w = World::new();
    let alice = w.agent("alice");
    w.set_epoch(10);
    let id = w.post(&alice, "alice", "game", "Connect four, open table", 5);
    assert_eq!(w.get(&alice, id).1.expires_epoch, 15);
    w.set_epoch(14);
    assert!(w.get(&alice, id).2, "live until its expiry epoch");
    w.set_epoch(15);
    assert!(!w.get(&alice, id).2, "expired at its expiry epoch, with no transaction");

    // Renewing runs from now, and even an expired listing can be renewed.
    let tx = w.paid(&alice, &alice.key, BOARD_FEE, "renew", args![id, 20u64]);
    w.ok(tx, &alice);
    let (_, state, live) = w.get(&alice, id);
    assert_eq!((state.expires_epoch, live), (35, true));
    assert_eq!(w.locked(&alice), Amount::from(2 * BOARD_FEE), "renewing pays the fee again");
}

#[test]
fn durations_and_fees_are_exact() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let tx = w.post_tx(&alice, "alice", "project", "x", None, 0);
    w.fails(tx, &alice, "at least one epoch");
    let tx = w.post_tx(&alice, "alice", "project", "x", None, MAX_DURATION + 1);
    w.fails(tx, &alice, "longer than the board allows");
    w.post(&alice, "alice", "project", "x", MAX_DURATION);
    for fee in [BOARD_FEE - 1, BOARD_FEE + 1] {
        let tx = w.paid(&alice, &alice.key, fee, "post", args!["alice", "project", "x", "", "", None::<Price>, 10u64]);
        w.fails(tx, &alice, "exactly the board's fee");
    }
}

#[test]
fn listing_limits() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let cases: [(&str, String, String, String, &str); 6] = [
        ("dating", "x".into(), "".into(), "".into(), "unknown category"),
        ("endorsement", "x".into(), "".into(), "".into(), "unknown category"),
        ("project", "  ".into(), "".into(), "".into(), "title is empty"),
        ("project", "x".repeat(81), "".into(), "".into(), "title too long"),
        ("project", "x".into(), "x".repeat(601), "".into(), "description too long"),
        ("project", "x".into(), "".into(), "x".repeat(201), "link too long"),
    ];
    for (category, title, description, link, expected) in cases {
        let tx = w.paid(&alice, &alice.key, BOARD_FEE, "post", args!["alice", category, title, description, link, None::<Price>, 10u64]);
        w.fails(tx, &alice, expected);
    }
    let bad_unit = Some(Price { amount: Amount::from(1u64), unit: "".into() });
    let tx = w.post_tx(&alice, "alice", "service", "x", bad_unit, 10);
    w.fails(tx, &alice, "price unit");
    let tx = w.paid(&alice, &alice.key, BOARD_FEE, "post", args!["alice", "project", "x".repeat(80), "x".repeat(600), "x".repeat(200), None::<Price>, 10u64]);
    w.ok(tx, &alice);
}

#[test]
fn only_the_authors_current_key_writes() {
    let mut w = World::new();
    let (alice, mallory) = (w.agent("alice"), w.agent("mallory"));
    let tx = w.post_tx(&mallory, "alice", "project", "not alice", None, 10);
    w.fails(tx, &mallory, "only the agent's current key");
    let id = w.post(&alice, "alice", "project", "mine", 10);
    let tx = w.paid(&mallory, &mallory.key, BOARD_FEE, "renew", args![id, 10u64]);
    w.fails(tx, &mallory, "only the agent's current key");
    let tx = w.free("withdraw", args![id], &mallory.key);
    w.fails(tx, &mallory, "only the agent's current key");
    let tx = w.free("update", args![id, "hijacked", "", "", None::<Price>], &mallory.key);
    w.fails(tx, &mallory, "only the agent's current key");

    // The owner rotates Alice's agent key: her listings follow the card, so only the new key manages them.
    let (_, new_proof, new_key) = w.test.create_funded_account();
    let sig = sign(&alice.owner, &rotate_message(&w.directory, "alice", 0, &pk(&new_key)));
    let tx = w.test.transaction().call_method(w.directory, "rotate_agent_key", args!["alice", pk(&new_key), sig]).finish().seal(&alice.key);
    w.ok(tx, &alice);
    let tx = w.free("withdraw", args![id], &alice.key);
    w.fails(tx, &alice, "only the agent's current key");
    let tx = w.free("withdraw", args![id], &new_key);
    w.test.execute_expect_success(tx, vec![new_proof]);
}

#[test]
fn retired_agents_cant_post_or_be_endorsed() {
    let mut w = World::new();
    let (alice, bob) = (w.agent("alice"), w.agent("bob"));
    let sig = sign(&alice.owner, &retire_message(&w.directory, "alice", 0));
    let tx = w.test.transaction().call_method(w.directory, "retire", args!["alice", sig]).finish().seal(&alice.key);
    w.ok(tx, &alice);
    let tx = w.post_tx(&alice, "alice", "project", "still here?", None, 10);
    w.fails(tx, &alice, "agent is retired");
    let tx = w.paid(&bob, &bob.key, BOARD_FEE, "endorse", args!["bob", "alice", "great work", 10u64]);
    w.fails(tx, &bob, "that agent is retired");
    let tx = w.post_tx(&bob, "nobody-here", "project", "x", None, 10);
    w.test.execute_expect_failure(tx, vec![bob.proof.clone()]);
}

#[test]
fn update_and_withdraw() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let id = w.post(&alice, "alice", "service", "Reports", 10);
    let price = Some(Price { amount: Amount::from(7_000u64), unit: "report".into() });
    let tx = w.free("update", args![id, "Better reports", "now with charts", "https://example.org/v2", price.clone()], &alice.key);
    w.ok(tx, &alice);
    let (info, state, _) = w.get(&alice, id);
    assert_eq!((info.category.as_str(), state.title.as_str(), state.link.as_str(), state.price), ("service", "Better reports", "https://example.org/v2", price));
    assert_eq!(w.locked(&alice), Amount::from(BOARD_FEE), "updates are free");

    let tx = w.free("withdraw", args![id], &alice.key);
    w.ok(tx, &alice);
    let (_, state, live) = w.get(&alice, id);
    assert!(state.withdrawn && !live);
    assert_eq!(state.title, "Better reports", "content stays on-chain");
    let tx = w.free("withdraw", args![id], &alice.key);
    w.fails(tx, &alice, "already withdrawn");
    let tx = w.paid(&alice, &alice.key, BOARD_FEE, "renew", args![id, 10u64]);
    w.fails(tx, &alice, "entry was withdrawn");
    let tx = w.free("update", args![id, "back", "", "", None::<Price>], &alice.key);
    w.fails(tx, &alice, "entry was withdrawn");
    let tx = w.free("get", args![99u64], &alice.key);
    w.fails(tx, &alice, "no such entry");
}

#[test]
fn endorsements_are_board_entries() {
    let mut w = World::new();
    let (alice, bob) = (w.agent("alice"), w.agent("bob"));
    let tx = w.paid(&bob, &bob.key, BOARD_FEE, "endorse", args!["bob", "alice", "Delivered three reports on time", 100u64]);
    w.ok(tx, &bob);
    let id = w.test.return_values().last().unwrap().decoded::<u64>().unwrap();
    let (info, state, live) = w.get(&bob, id);
    assert_eq!((info.author.as_str(), info.category.as_str(), info.subject.as_deref()), ("bob", "endorsement", Some("alice")));
    assert_eq!((state.title.as_str(), state.description.as_str(), live), ("Endorses alice", "Delivered three reports on time", true));

    let tx = w.paid(&bob, &bob.key, BOARD_FEE, "endorse", args!["bob", "bob", "I'm great", 100u64]);
    w.fails(tx, &bob, "can't endorse yourself");
    let tx = w.paid(&bob, &bob.key, BOARD_FEE, "endorse", args!["bob", "alice", " ", 100u64]);
    w.fails(tx, &bob, "note is empty");
    let tx = w.paid(&alice, &alice.key, BOARD_FEE, "endorse", args!["bob", "alice", "self-dealing", 100u64]);
    w.fails(tx, &alice, "only the agent's current key");
    let tx = w.free("update", args![id, "Endorses alice", "edited", "", None::<Price>], &bob.key);
    w.fails(tx, &bob, "can't be edited");
    let tx = w.free("withdraw", args![id], &bob.key);
    w.ok(tx, &bob);
}

#[test]
fn entries_roll_over_into_a_new_page_vault() {
    let mut w = World::new();
    let alice = w.agent("alice");
    // A transaction may emit at most 256 events (withdrawals emit some too), so post in batches.
    let ids: Vec<u64> = (0..=PAGE_SIZE).collect();
    for batch in ids.chunks(20) {
        let mut builder = w.test.transaction();
        for i in batch {
            builder = builder
                .call_method(alice.account, "withdraw", args![TARI_TOKEN, BOARD_FEE])
                .put_last_instruction_output_on_workspace("fee")
                .call_method(w.board, "post", args!["alice", "other", format!("listing {i}"), "", "", None::<Price>, 10u64, Workspace("fee")]);
        }
        let tx = builder.finish().seal(&alice.key);
        w.ok(tx, &alice);
    }
    assert_eq!(w.config(&alice).3, PAGE_SIZE + 1);
    assert_eq!(w.get(&alice, PAGE_SIZE).1.title, format!("listing {PAGE_SIZE}"));
}
