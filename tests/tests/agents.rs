//! End-to-end tests for OotleAgents, executed in-process by the Ootle engine (`tari_template_test_tooling`).

use ootle_agents::*;
use ootle_byte_type::ToByteType;
use tari_crypto::{
    keys::{PublicKey as _, SecretKey as _},
    ristretto::{RistrettoPublicKey, RistrettoSchnorr, RistrettoSecretKey},
    tari_utilities::hex::Hex,
};
use tari_engine_types::{
    indexed_value::IndexedValue,
    virtual_substate::{VirtualSubstate, VirtualSubstateId},
};
use tari_ootle_common_types::RistrettoSchnorrBlake2bVerifier;
use tari_ootle_transaction::{args, builder::named_args::NamedArg, Transaction};
use tari_template_lib_types::{
    constants::TARI_TOKEN,
    crypto::{RistrettoPublicKeyBytes, SignaturePayload},
    Amount, ComponentAddress, NonFungibleAddress, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const NAME_FEE: u64 = 1_000;
const LISTING_FEE: u64 = 100;
const MAX_LISTING: u64 = 50;
const CLOSE_WINDOW: u64 = 6;

fn pk(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

fn new_key() -> RistrettoSecretKey {
    RistrettoSecretKey::random(&mut rand::rng())
}

fn schnorr(domain: &[u8], key: &RistrettoSecretKey, message: &[u8]) -> SignaturePayload {
    let (nonce, public_nonce) = RistrettoPublicKey::random_keypair(&mut rand::rng());
    let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(domain, message, &pk(key), &public_nonce.to_byte_type());
    SignaturePayload::RistrettoSchnorrBlake2b(RistrettoSchnorr::sign_raw_uniform(key, nonce, &challenge).expect("sign").to_byte_type())
}

struct Agent {
    name: String,
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    owner: RistrettoSecretKey,
}

struct Hub {
    test: TemplateTest,
    hub: ComponentAddress,
    reader: Agent,
}

impl Hub {
    fn deploy() -> Self {
        let mut test = TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../template"]);
        let (account, proof, key) = test.create_funded_account();
        let template = test.get_template_address("OotleAgents");
        let new = args![TARI_TOKEN, Amount::from(NAME_FEE), Amount::from(LISTING_FEE), MAX_LISTING, CLOSE_WINDOW];
        test.execute_expect_success(test.transaction().call_function(template, "new", new).finish().seal(&key), vec![proof.clone()]);
        let hub = *test.return_values()[0].component_addresses().first().expect("component");
        let reader = Agent { name: String::new(), account, proof, key, owner: new_key() };
        Self { test, hub, reader }
    }

    fn party(&mut self, name: &str) -> Agent {
        let (account, proof, key) = self.test.create_funded_account();
        Agent { name: name.into(), account, proof, key, owner: new_key() }
    }

    fn register_tx(&self, a: &Agent, owner_key: RistrettoPublicKeyBytes, sig: SignaturePayload, fee: u64) -> Transaction {
        self.paid(a, fee, "register", args![a.name.as_str(), owner_key, "otl_esm_example", "test agent", sig])
    }

    /// A registered agent, owned by its own fresh owner key.
    fn agent(&mut self, name: &str) -> Agent {
        let a = self.party(name);
        let sig = schnorr(OWNER_DOMAIN, &a.owner, &register_message(&self.hub, name, &pk(&a.key), "otl_esm_example"));
        let tx = self.register_tx(&a, pk(&a.owner), sig, NAME_FEE);
        self.ok(tx, &a);
        a
    }

    /// `method` signed by `payer`, with `amount` withdrawn from its account as the last argument.
    fn paid(&self, payer: &Agent, amount: u64, method: &str, mut args: Vec<NamedArg>) -> Transaction {
        args.push(NamedArg::Workspace("funds".into()));
        let b = self.test.transaction().call_method(payer.account, "withdraw", args![TARI_TOKEN, amount]).put_last_instruction_output_on_workspace("funds");
        let b = b.call_method(self.hub, method, args);
        // register returns the card, a bucket for the agent's account
        let b = if method == "register" { b.put_last_instruction_output_on_workspace("card").call_method(payer.account, "deposit", args![Workspace("card")]) } else { b };
        b.finish().seal(&payer.key)
    }

    fn signed(&self, a: &Agent, method: &str, args: Vec<NamedArg>) -> Transaction {
        self.test.transaction().call_method(self.hub, method, args).finish().seal(&a.key)
    }

    fn ok(&mut self, tx: Transaction, a: &Agent) {
        self.test.execute_expect_success(tx, vec![a.proof.clone()]);
    }

    fn fails(&mut self, tx: Transaction, a: &Agent, expected: &str) {
        let reason = self.test.execute_expect_failure(tx, vec![a.proof.clone()]).to_string();
        assert!(reason.contains(expected), "expected rejection containing {expected:?}, got: {reason}");
    }

    fn call(&mut self, a: &Agent, method: &str, args: Vec<NamedArg>) {
        let tx = self.signed(a, method, args);
        self.ok(tx, a);
    }

    fn call_fails(&mut self, a: &Agent, method: &str, args: Vec<NamedArg>, expected: &str) {
        let tx = self.signed(a, method, args);
        self.fails(tx, a, expected);
    }

    /// The return value of a read (CBOR-only types can't go through `call_method`).
    fn read(&mut self, method: &str, args: Vec<NamedArg>) -> IndexedValue {
        let tx = self.signed(&self.reader, method, args);
        self.test.execute_expect_success(tx, vec![self.reader.proof.clone()]);
        self.test.return_values()[0].clone()
    }

    fn returned(&self) -> String {
        self.test.return_values().iter().find_map(|v| v.decoded::<String>().ok()).expect("an id")
    }

    fn card(&mut self, name: &str) -> Card {
        let tx = self.signed(&self.reader, "card", args![name]);
        self.test.execute_expect_success(tx, vec![self.reader.proof.clone()]);
        self.test.return_values()[0].decoded().expect("card")
    }

    fn rotate(&mut self, a: &mut Agent) {
        // The new key comes with an account to sign from.
        let (account, proof, new) = self.test.create_funded_account();
        let nonce = self.card(&a.name).nonce;
        let sig = schnorr(OWNER_DOMAIN, &a.owner, &rotate_message(&self.hub, &a.name, nonce, &pk(&new)));
        let tx = self.signed(&self.reader, "rotate_agent_key", args![a.name.as_str(), pk(&new), sig]);
        self.test.execute_expect_success(tx, vec![self.reader.proof.clone()]);
        (a.account, a.proof, a.key) = (account, proof, new);
    }

    fn retire(&mut self, a: &Agent) {
        let nonce = self.card(&a.name).nonce;
        let sig = schnorr(OWNER_DOMAIN, &a.owner, &retire_message(&self.hub, &a.name, nonce));
        let tx = self.signed(&self.reader, "retire", args![a.name.as_str(), sig]);
        self.test.execute_expect_success(tx, vec![self.reader.proof.clone()]);
    }

    fn balance(&mut self, a: &Agent) -> Amount {
        self.test.call_method(a.account, "balance", args![TARI_TOKEN], vec![])
    }

    fn balances(&mut self) -> (Amount, Amount) {
        self.read("balances", args![]).decoded().expect("balances")
    }

    fn set_epoch(&mut self, epoch: u64) {
        self.test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
    }

    fn post(&mut self, a: &Agent, body: &str, reply_to: Option<String>) -> String {
        let tx = self.signed(a, "post", args![a.name.as_str(), body, reply_to]);
        self.ok(tx, a);
        self.returned()
    }

    fn list(&mut self, a: &Agent, title: &str, epochs: u64) -> String {
        let tx = self.paid(a, LISTING_FEE, "list", args![a.name.as_str(), "service", title, "what it is", "https://example.org", Some(Price { amount: 500u64.into(), unit: "report".into() }), epochs]);
        self.ok(tx, a);
        self.returned()
    }

    fn listing(&mut self, id: &str) -> (Listing, ListingState, bool) {
        self.read("get_listing", args![id]).decoded().expect("listing")
    }

    fn open_lane(&mut self, buyer: &Agent, provider: &str, voucher_key: &RistrettoSecretKey, amount: u64) -> String {
        let tx = self.paid(buyer, amount, "open_lane", args![buyer.name.as_str(), provider, pk(voucher_key)]);
        self.ok(tx, buyer);
        self.returned()
    }

    fn voucher(&self, key: &RistrettoSecretKey, lane: &str, spent: u64) -> SignaturePayload {
        schnorr(VOUCHER_DOMAIN, key, &voucher_message(&self.hub, lane, spent.into()))
    }

    fn claim_tx(&self, a: &Agent, lane: &str, spent: u64, voucher: SignaturePayload) -> Transaction {
        self.test
            .transaction()
            .call_method(self.hub, "claim", args![lane, Amount::from(spent), voucher])
            .put_last_instruction_output_on_workspace("paid")
            .call_method(a.account, "deposit", args![Workspace("paid")])
            .finish()
            .seal(&a.key)
    }

    fn refund_tx(&self, a: &Agent, lane: &str) -> Transaction {
        self.test
            .transaction()
            .call_method(self.hub, "refund", args![lane])
            .put_last_instruction_output_on_workspace("back")
            .call_method(a.account, "deposit", args![Workspace("back")])
            .finish()
            .seal(&a.key)
    }

    fn lane(&mut self, id: &str) -> LaneState {
        self.read("get_lane", args![id]).decoded::<(Lane, LaneState)>().expect("lane").1
    }

    /// escrow == what every lane still holds.
    fn assert_conserved(&mut self, lanes: &[&str]) {
        let held = lanes.iter().map(|l| self.lane(l).remaining()).fold(Amount::zero(), |a, b| a + b);
        assert_eq!(self.balances().1, held, "escrow doesn't match the lanes");
    }
}

// ---- cards ----

#[test]
fn settings_are_fixed_and_nothing_is_admin_gated() {
    let mut h = Hub::deploy();
    let settings: (Amount, Amount, u64, u64) = h.read("settings", args![]).decoded().unwrap();
    assert_eq!(settings, (NAME_FEE.into(), LISTING_FEE.into(), MAX_LISTING, CLOSE_WINDOW));
    let alice = h.agent("alice");
    assert_eq!(h.balances().0, Amount::from(NAME_FEE), "the name fee is locked");
    let resources: (ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, u64) = h.read("resources", args![]).decoded().unwrap();
    assert_eq!(resources.6, 1);
    // Cards can't leave the account they were deposited into.
    let tx = h.test.transaction().call_method(alice.account, "withdraw", args![resources.0, Amount::from(1u64)]).put_last_instruction_output_on_workspace("c")
        .call_method(h.reader.account, "deposit", args![Workspace("c")]).finish().seal(&alice.key);
    h.fails(tx, &alice, "");
}

#[test]
fn registration_needs_a_unique_valid_name_the_exact_fee_and_the_owners_signature() {
    let mut h = Hub::deploy();
    h.agent("alice");
    let twin = h.party("alice");
    let sig = schnorr(OWNER_DOMAIN, &twin.owner, &register_message(&h.hub, "alice", &pk(&twin.key), "otl_esm_example"));
    let tx = h.register_tx(&twin, pk(&twin.owner), sig, NAME_FEE);
    h.fails(tx, &twin, "");

    for bad in ["A", "Alice", "-x", "has space", &"x".repeat(33)] {
        let p = h.party(bad);
        let sig = schnorr(OWNER_DOMAIN, &p.owner, &register_message(&h.hub, bad, &pk(&p.key), "otl_esm_example"));
        let tx = h.register_tx(&p, pk(&p.owner), sig, NAME_FEE);
        h.fails(tx, &p, "invalid name");
    }
    let bob = h.party("bob");
    let sig = schnorr(OWNER_DOMAIN, &bob.owner, &register_message(&h.hub, "bob", &pk(&bob.key), "otl_esm_example"));
    let tx = h.register_tx(&bob, pk(&bob.owner), sig.clone(), NAME_FEE - 1);
    h.fails(tx, &bob, "fee must be exact");
    // Signed for a different agent key, or by someone other than the named owner.
    let wrong = schnorr(OWNER_DOMAIN, &bob.owner, &register_message(&h.hub, "bob", &pk(&new_key()), "otl_esm_example"));
    let tx = h.register_tx(&bob, pk(&bob.owner), wrong, NAME_FEE);
    h.fails(tx, &bob, "invalid owner signature");
    let tx = h.register_tx(&bob, pk(&new_key()), sig, NAME_FEE);
    h.fails(tx, &bob, "invalid owner signature");
    // An agent may own itself.
    let carol = h.party("carol");
    let sig = schnorr(OWNER_DOMAIN, &carol.key, &register_message(&h.hub, "carol", &pk(&carol.key), "otl_esm_example"));
    let tx = h.register_tx(&carol, pk(&carol.key), sig, NAME_FEE);
    h.ok(tx, &carol);
    assert_eq!(h.read("resources", args![]).decoded::<(ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, ResourceAddress, u64)>().unwrap().6, 2);
}

#[test]
fn only_the_agent_key_edits_and_only_owner_statements_rotate_retire_or_transfer() {
    let mut h = Hub::deploy();
    let mut alice = h.agent("alice");
    let bob = h.agent("bob");
    h.call(&alice, "set_description", args!["alice", "audits templates"]);
    h.call_fails(&bob, "set_description", args!["alice", "hijacked"], "only the agent's current key");
    assert_eq!(h.card("alice").description, "audits templates");

    // A rotation takes effect at once, and its statement works only once (the nonce moves).
    let old = alice.key.clone();
    h.rotate(&mut alice);
    let stale = Agent { name: "alice".into(), account: h.reader.account, proof: h.reader.proof.clone(), key: old, owner: new_key() };
    h.call_fails(&stale, "set_messaging_address", args!["alice", ""], "only the agent's current key");
    h.call(&alice, "set_messaging_address", args!["alice", ""]);
    let sig = schnorr(OWNER_DOMAIN, &alice.owner, &rotate_message(&h.hub, "alice", 0, &pk(&new_key())));
    h.call_fails(&bob, "rotate_agent_key", args!["alice", pk(&new_key()), sig], "invalid owner signature");

    // A transfer needs both owners.
    let next = new_key();
    let nonce = h.card("alice").nonce;
    let message = transfer_message(&h.hub, "alice", nonce, &pk(&next));
    let both = (schnorr(OWNER_DOMAIN, &alice.owner, &message), schnorr(OWNER_DOMAIN, &next, &message));
    h.call_fails(&bob, "transfer_owner", args!["alice", pk(&next), both.0.clone(), both.0.clone()], "invalid new owner signature");
    h.call(&bob, "transfer_owner", args!["alice", pk(&next), both.0, both.1]);
    assert_eq!(h.card("alice").owner_key, pk(&next));
    alice.owner = next;

    // Retiring is permanent and keeps the name taken.
    h.retire(&alice);
    assert!(h.card("alice").retired);
    h.call_fails(&alice, "set_description", args!["alice", "back"], "agent is retired");
    let nonce = h.card("alice").nonce;
    let sig = schnorr(OWNER_DOMAIN, &alice.owner, &retire_message(&h.hub, "alice", nonce));
    h.call_fails(&bob, "retire", args!["alice", sig], "agent is retired");
}

#[test]
fn signatures_from_the_javascript_client_are_accepted() {
    let mut h = Hub::deploy();
    let a = h.party("jsagent");
    let owner = new_key();
    let message = register_message(&h.hub, "jsagent", &pk(&a.key), "otl_esm_example");
    let script = "import { sign } from './client/keys.mjs'; \
        const [domain, key, msg] = process.argv.slice(1); \
        const s = sign(domain, key, Buffer.from(msg, 'hex')); process.stdout.write(s.public_nonce + ' ' + s.signature);";
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
    let out = std::process::Command::new("node")
        .current_dir(root)
        .args(["--input-type=module", "-e", script, "ootle-agents-owner-v1", &owner.to_hex(), &message.to_hex()])
        .output()
        .expect("run node (install Node.js and `npm install` in client/)");
    assert!(out.status.success(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
    let out = String::from_utf8(out.stdout).expect("utf8");
    let (nonce, s) = out.split_once(' ').expect("nonce and signature");
    let (nonce, s) = (RistrettoPublicKey::from_hex(nonce).expect("nonce"), RistrettoSecretKey::from_hex(s).expect("s"));
    let payload = SignaturePayload::RistrettoSchnorrBlake2b(RistrettoSchnorr::new(nonce, s).to_byte_type());
    let tx = h.register_tx(&a, pk(&owner), payload, NAME_FEE);
    h.ok(tx, &a);
}

// ---- posts and follows ----

#[test]
fn posts_are_numbered_per_agent_and_retractions_keep_them() {
    let mut h = Hub::deploy();
    let alice = h.agent("alice");
    let bob = h.agent("bob");
    assert_eq!(h.post(&alice, "gm Ootle", None), "alice.0");
    assert_eq!(h.post(&bob, "gm alice", Some("alice.0".into())), "bob.0");
    assert_eq!(h.post(&alice, "second", None), "alice.1");
    assert_eq!((h.card("alice").posts, h.card("bob").posts), (2, 1));
    let (post, _): (Post, PostState) = h.read("get_post", args!["bob.0"]).decoded().unwrap();
    assert_eq!((post.author.as_str(), post.reply_to.as_deref()), ("bob", Some("alice.0")));

    h.call_fails(&bob, "post", args!["alice", "as alice", None::<String>], "only the agent's current key");
    h.call_fails(&alice, "post", args!["alice", "  ", None::<String>], "post is empty");
    h.call_fails(&alice, "post", args!["alice", "x".repeat(POST_MAX + 1), None::<String>], "post too long");
    h.call_fails(&bob, "retract", args!["alice.0"], "only the agent's current key");
    h.call(&alice, "retract", args!["alice.0"]);
    let (post, state): (Post, PostState) = h.read("get_post", args!["alice.0"]).decoded().unwrap();
    assert_eq!((post.body.as_str(), state.retracted), ("gm Ootle", true));

    h.retire(&alice);
    h.call_fails(&alice, "post", args!["alice", "still here?", None::<String>], "agent is retired");
}

#[test]
fn follows_are_entries_of_their_own() {
    let mut h = Hub::deploy();
    let alice = h.agent("alice");
    let bob = h.agent("bob");
    let carol = h.agent("carol");
    let tx = h.signed(&alice, "follow", args!["alice", "bob"]);
    h.ok(tx, &alice);
    assert_eq!(h.returned(), "alice.0");
    h.call(&alice, "follow", args!["alice", "carol"]);
    assert_eq!(h.card("alice").follows, 2);
    h.call_fails(&alice, "follow", args!["alice", "alice"], "can't follow yourself");
    h.call_fails(&bob, "unfollow", args!["alice.0"], "only the agent's current key");
    h.call(&alice, "unfollow", args!["alice.0"]);
    let (follow, state): (Follow, FollowState) = h.read("get_follow", args!["alice.0"]).decoded().unwrap();
    assert_eq!((follow.target.as_str(), state.active), ("bob", false));
    h.retire(&carol);
    h.call_fails(&bob, "follow", args!["bob", "carol"], "that agent is retired");
}

#[test]
fn entries_roll_over_into_a_new_page_vault() {
    let mut h = Hub::deploy();
    let alice = h.agent("alice");
    // A transaction may emit at most 256 events, so post in batches.
    for batch in (0..=PAGE_SIZE).collect::<Vec<_>>().chunks(50) {
        let mut b = h.test.transaction();
        for i in batch {
            b = b.call_method(h.hub, "post", args!["alice", format!("post {i}"), None::<String>]);
        }
        let tx = b.finish().seal(&alice.key);
        h.ok(tx, &alice);
    }
    let last = format!("alice.{PAGE_SIZE}");
    let (post, _): (Post, PostState) = h.read("get_post", args![last.as_str()]).decoded().unwrap();
    assert_eq!(post.body, format!("post {PAGE_SIZE}"));
}

// ---- the board ----

#[test]
fn listings_expire_unless_renewed_and_fees_are_exact() {
    let mut h = Hub::deploy();
    let alice = h.agent("alice");
    h.set_epoch(10);
    let id = h.list(&alice, "Walkthrough reports", 5);
    assert_eq!(id, "alice.0");
    let (info, state, live) = h.listing(&id);
    assert_eq!((info.category.as_str(), state.expires_epoch, live), ("service", 15, true));
    h.set_epoch(15);
    assert!(!h.listing(&id).2, "expired at its expiry epoch, with no transaction");
    let tx = h.paid(&alice, LISTING_FEE, "renew", args![id.as_str(), 20u64]);
    h.ok(tx, &alice);
    assert_eq!(h.listing(&id).1.expires_epoch, 35);
    assert_eq!(h.balances().0, Amount::from(NAME_FEE + 2 * LISTING_FEE));

    let tx = h.paid(&alice, LISTING_FEE, "renew", args![id.as_str(), MAX_LISTING + 1]);
    h.fails(tx, &alice, "a listing lasts");
    let tx = h.paid(&alice, LISTING_FEE - 1, "renew", args![id.as_str(), 5u64]);
    h.fails(tx, &alice, "fee must be exact");
    let tx = h.paid(&alice, LISTING_FEE, "list", args!["alice", "spam", "t", "", "", None::<Price>, 5u64]);
    h.fails(tx, &alice, "unknown category");
    let tx = h.paid(&alice, LISTING_FEE, "list", args!["alice", "other", "x".repeat(TITLE_MAX + 1), "", "", None::<Price>, 5u64]);
    h.fails(tx, &alice, "title must be");
}

#[test]
fn only_the_author_updates_or_withdraws_and_endorsements_cant_be_edited() {
    let mut h = Hub::deploy();
    let alice = h.agent("alice");
    let bob = h.agent("bob");
    let id = h.list(&alice, "Code review", 10);
    h.call_fails(&bob, "update", args![id.as_str(), "Mine now", "", "", None::<Price>], "only the agent's current key");
    h.call(&alice, "update", args![id.as_str(), "Code review, faster", "", "", None::<Price>]);
    assert_eq!(h.listing(&id).1.title, "Code review, faster");
    h.call(&alice, "withdraw", args![id.as_str()]);
    assert!(!h.listing(&id).2);
    h.call_fails(&alice, "withdraw", args![id.as_str()], "listing was withdrawn");

    let tx = h.paid(&bob, LISTING_FEE, "endorse", args!["bob", "alice", "Delivered on time", 10u64]);
    h.ok(tx, &bob);
    let e = h.returned();
    let (info, state, _) = h.listing(&e);
    assert_eq!((info.category.as_str(), info.subject.as_deref(), state.title.as_str()), (ENDORSEMENT, Some("alice"), "Endorses alice"));
    h.call_fails(&bob, "update", args![e.as_str(), "x", "", "", None::<Price>], "can't be edited");
    let tx = h.paid(&bob, LISTING_FEE, "endorse", args!["bob", "bob", "I'm great", 10u64]);
    h.fails(tx, &bob, "can't endorse yourself");
    h.retire(&alice);
    let tx = h.paid(&bob, LISTING_FEE, "endorse", args!["bob", "alice", "again", 10u64]);
    h.fails(tx, &bob, "that agent is retired");
}

// ---- lanes ----

#[test]
fn claims_pay_the_provider_and_escrow_is_conserved() {
    let mut h = Hub::deploy();
    let buyer = h.agent("buyer");
    let provider = h.agent("provider");
    let vk = new_key();
    let lane = h.open_lane(&buyer, "provider", &vk, 10_000);
    assert_eq!((lane.as_str(), h.card("provider").lanes), ("provider.0", 1));
    h.assert_conserved(&[&lane]);
    let before = h.balance(&provider);
    let tx = h.claim_tx(&provider, &lane, 3_000, h.voucher(&vk, &lane, 3_000));
    h.ok(tx, &provider);
    let tx = h.claim_tx(&provider, &lane, 5_000, h.voucher(&vk, &lane, 5_000));
    h.ok(tx, &provider);
    assert_eq!(h.balance(&provider), before + Amount::from(5_000u64));
    assert_eq!(h.lane(&lane).claimed, Amount::from(5_000u64));
    h.assert_conserved(&[&lane]);

    let tx = h.claim_tx(&provider, &lane, 5_000, h.voucher(&vk, &lane, 5_000));
    h.fails(tx, &provider, "does not exceed");
    let tx = h.claim_tx(&provider, &lane, 10_001, h.voucher(&vk, &lane, 10_001));
    h.fails(tx, &provider, "exceeds the lane's escrow");
    let tx = h.claim_tx(&provider, &lane, 6_000, h.voucher(&new_key(), &lane, 6_000));
    h.fails(tx, &provider, "invalid voucher signature");
    let tx = h.claim_tx(&provider, &lane, 6_000, h.voucher(&vk, "provider.1", 6_000));
    h.fails(tx, &provider, "invalid voucher signature");
    let tx = h.claim_tx(&buyer, &lane, 6_000, h.voucher(&vk, &lane, 6_000));
    h.fails(tx, &buyer, "only the agent's current key");
}

#[test]
fn closing_waits_for_the_window_and_release_refunds_at_once() {
    let mut h = Hub::deploy();
    let buyer = h.agent("buyer");
    let provider = h.agent("provider");
    let vk = new_key();
    h.set_epoch(100);
    let a = h.open_lane(&buyer, "provider", &vk, 10_000);
    let b = h.open_lane(&buyer, "provider", &vk, 4_000);
    let tx = h.paid(&buyer, 1_000, "fund_lane", args![a.as_str()]);
    h.ok(tx, &buyer);
    h.call(&buyer, "request_close", args![a.as_str()]);
    let tx = h.refund_tx(&buyer, &a);
    h.fails(tx, &buyer, "close window has not passed");
    let tx = h.paid(&buyer, 1_000, "fund_lane", args![a.as_str()]);
    h.fails(tx, &buyer, "closing or closed");
    let tx = h.claim_tx(&provider, &a, 2_000, h.voucher(&vk, &a, 2_000));
    h.ok(tx, &provider);
    h.set_epoch(100 + CLOSE_WINDOW);
    let before = h.balance(&buyer);
    let tx = h.refund_tx(&buyer, &a);
    h.ok(tx, &buyer);
    assert_eq!(h.balance(&buyer), before + Amount::from(9_000u64));

    h.call_fails(&buyer, "release_lane", args![b.as_str()], "only the agent's current key");
    h.call(&provider, "release_lane", args![b.as_str()]);
    let tx = h.claim_tx(&provider, &b, 1_000, h.voucher(&vk, &b, 1_000));
    h.fails(tx, &provider, "lane is closed");
    let tx = h.refund_tx(&buyer, &b);
    h.ok(tx, &buyer);
    let tx = h.refund_tx(&buyer, &b);
    h.fails(tx, &buyer, "nothing to refund");
    h.assert_conserved(&[&a, &b]);
}

#[test]
fn lanes_follow_the_card_and_retired_providers_still_settle() {
    let mut h = Hub::deploy();
    let buyer = h.agent("buyer");
    let mut provider = h.agent("provider");
    let outsider = h.party("outsider");
    let vk = new_key();
    let tx = h.paid(&outsider, 1_000, "open_lane", args!["outsider", "provider", pk(&vk)]);
    h.fails(tx, &outsider, "");
    let tx = h.paid(&buyer, 1_000, "open_lane", args!["buyer", "buyer", pk(&vk)]);
    h.fails(tx, &buyer, "cannot open a lane to yourself");
    let lane = h.open_lane(&buyer, "provider", &vk, 5_000);

    let old = provider.key.clone();
    h.rotate(&mut provider);
    let stale = Agent { name: "provider".into(), account: h.reader.account, proof: h.reader.proof.clone(), key: old, owner: new_key() };
    let tx = h.claim_tx(&stale, &lane, 1_000, h.voucher(&vk, &lane, 1_000));
    h.fails(tx, &stale, "only the agent's current key");
    let tx = h.claim_tx(&provider, &lane, 1_000, h.voucher(&vk, &lane, 1_000));
    h.ok(tx, &provider);

    h.retire(&provider);
    let tx = h.paid(&buyer, 1_000, "open_lane", args!["buyer", "provider", pk(&vk)]);
    h.fails(tx, &buyer, "that agent is retired");
    let tx = h.claim_tx(&provider, &lane, 2_000, h.voucher(&vk, &lane, 2_000));
    h.ok(tx, &provider);
    h.call(&provider, "release_lane", args![lane.as_str()]);
    let tx = h.refund_tx(&buyer, &lane);
    h.ok(tx, &buyer);
    h.assert_conserved(&[&lane]);
}
