//! End-to-end tests for AgentChannel against a real AgentDirectory, executed in-process by the Ootle
//! engine (`tari_template_test_tooling`).

use agent_channel::{Post, PostRef, PAGE_SIZE};
use agent_directory::{register_message, retire_message, rotate_message, DIRECTORY_DOMAIN};
use ootle_byte_type::ToByteType;
use tari_crypto::{
    keys::{PublicKey as _, SecretKey as _},
    ristretto::{RistrettoPublicKey, RistrettoSchnorr, RistrettoSecretKey},
};
use tari_ootle_common_types::RistrettoSchnorrBlake2bVerifier;
use tari_ootle_transaction::{args, builder::named_args::NamedArg, Transaction};
use tari_template_lib_types::{
    constants::TARI_TOKEN,
    crypto::{RistrettoPublicKeyBytes, SignaturePayload},
    Amount, ComponentAddress, NonFungibleAddress, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const FEE: u64 = 1_000;

struct Agent {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    owner: RistrettoSecretKey,
    channel: ComponentAddress,
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
}

impl World {
    fn new() -> Self {
        let mut test = TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../directory", "../channel"]);
        let template = test.get_template_address("AgentDirectory");
        let (_, proof, key) = test.create_funded_account();
        test.execute_expect_success(
            test.transaction().call_function(template, "new", args![TARI_TOKEN, Amount::from(FEE)]).finish().seal(&key),
            vec![proof],
        );
        let directory = *test.return_values()[0].component_addresses().first().expect("directory");
        Self { test, directory }
    }

    /// Registers `name` in the directory, creates its channel and links it from the card.
    fn agent(&mut self, name: &str) -> Agent {
        let (account, proof, key) = self.test.create_funded_account();
        let owner = RistrettoSecretKey::random(&mut rand::rng());
        let sig = sign(&owner, &register_message(&self.directory, name, &pk(&key), ""));
        let tx = self
            .test
            .transaction()
            .call_method(account, "withdraw", args![TARI_TOKEN, FEE])
            .put_last_instruction_output_on_workspace("fee")
            .call_method(self.directory, "register", args![name, pk(&owner), "", "", sig, Workspace("fee")])
            .put_last_instruction_output_on_workspace("card")
            .call_method(account, "deposit", args![Workspace("card")])
            .finish()
            .seal(&key);
        self.test.execute_expect_success(tx, vec![proof.clone()]);
        let channel = self.create_channel(&key, &proof, name);
        let tx = self.test.transaction().call_method(self.directory, "set_channel", args![name, Some(channel)]).finish().seal(&key);
        self.test.execute_expect_success(tx, vec![proof.clone()]);
        Agent { account, proof, key, owner, channel }
    }

    fn create_channel(&mut self, key: &RistrettoSecretKey, proof: &NonFungibleAddress, name: &str) -> ComponentAddress {
        let template = self.test.get_template_address("AgentChannel");
        let tx = self.test.transaction().call_function(template, "new", args![self.directory, name]).finish().seal(key);
        self.test.execute_expect_success(tx, vec![proof.clone()]);
        *self.test.return_values()[0].component_addresses().first().expect("channel")
    }

    fn tx(&self, a: &Agent, channel: ComponentAddress, method: &str, args: Vec<NamedArg>, key: &RistrettoSecretKey) -> Transaction {
        let _ = a;
        self.test.transaction().call_method(channel, method, args).finish().seal(key)
    }

    fn call(&mut self, a: &Agent, method: &str, args: Vec<NamedArg>) {
        let tx = self.tx(a, a.channel, method, args, &a.key);
        self.test.execute_expect_success(tx, vec![a.proof.clone()]);
    }

    fn fails(&mut self, tx: Transaction, proof: &NonFungibleAddress, expected: &str) {
        let reason = self.test.execute_expect_failure(tx, vec![proof.clone()]).to_string();
        assert!(reason.contains(expected), "expected rejection containing {expected:?}, got: {reason}");
    }

    fn post(&mut self, a: &Agent, body: &str, reply_to: Option<PostRef>) -> u64 {
        self.call(a, "post", args![body, reply_to]);
        self.test.return_values()[0].decoded::<u64>().expect("seq")
    }

    /// `Post` is CBOR-only, so read it from a transaction's return value.
    fn read(&mut self, a: &Agent, seq: u64) -> (Post, bool) {
        self.call(a, "get_post", args![seq]);
        self.test.return_values()[0].decoded().expect("post")
    }

    fn info(&mut self, a: &Agent) -> (ComponentAddress, String, ResourceAddress, u64, u64) {
        self.call(a, "info", args![]);
        self.test.return_values()[0].decoded().expect("info")
    }

    fn follows(&mut self, a: &Agent) -> Vec<String> {
        self.call(a, "follows", args![]);
        self.test.return_values()[0].decoded().expect("follows")
    }
}

#[test]
fn an_agent_posts_and_anyone_reads_posts_by_number() {
    let mut w = World::new();
    let alice = w.agent("alice");
    assert_eq!(w.post(&alice, "gm Ootle", None), 0);
    assert_eq!(w.post(&alice, "second post", None), 1);
    let (post, retracted) = w.read(&alice, 1);
    assert_eq!((post.seq, post.author.as_str(), post.body.as_str(), retracted), (1, "alice", "second post", false));
    let (directory, name, _, count, _) = w.info(&alice);
    assert_eq!((directory, name.as_str(), count), (w.directory, "alice", 2));
}

#[test]
fn replies_point_at_another_channels_post() {
    let mut w = World::new();
    let (alice, bob) = (w.agent("alice"), w.agent("bob"));
    let seq = w.post(&alice, "who wants to pair on escrow?", None);
    let reply = PostRef { channel: alice.channel, seq };
    let r = w.post(&bob, "me!", Some(reply.clone()));
    let (post, _) = w.read(&bob, r);
    assert_eq!(post.reply_to, Some(reply));
}

#[test]
fn only_the_agents_current_key_writes() {
    let mut w = World::new();
    let (alice, mallory) = (w.agent("alice"), w.agent("mallory"));
    let tx = w.tx(&alice, alice.channel, "post", args!["not alice", None::<PostRef>], &mallory.key);
    w.fails(tx, &mallory.proof, "only the agent's current key");
    let tx = w.tx(&alice, alice.channel, "follow", args!["mallory"], &mallory.key);
    w.fails(tx, &mallory.proof, "only the agent's current key");

    // The owner replaces Alice's key in the directory: the old key stops working on the channel at once.
    let (new_account, new_proof, new_key) = w.test.create_funded_account();
    let _ = new_account;
    let sig = sign(&alice.owner, &rotate_message(&w.directory, "alice", 0, &pk(&new_key)));
    let tx = w.test.transaction().call_method(w.directory, "rotate_agent_key", args!["alice", pk(&new_key), sig]).finish().seal(&alice.key);
    w.test.execute_expect_success(tx, vec![alice.proof.clone()]);
    let tx = w.tx(&alice, alice.channel, "post", args!["old key", None::<PostRef>], &alice.key);
    w.fails(tx, &alice.proof, "only the agent's current key");
    let tx = w.tx(&alice, alice.channel, "post", args!["new key", None::<PostRef>], &new_key);
    w.test.execute_expect_success(tx, vec![new_proof]);
}

#[test]
fn only_the_agent_can_create_its_channel() {
    let mut w = World::new();
    let (_alice, mallory) = (w.agent("alice"), w.agent("mallory"));
    let template = w.test.get_template_address("AgentChannel");
    let tx = w.test.transaction().call_function(template, "new", args![w.directory, "alice"]).finish().seal(&mallory.key);
    w.fails(tx, &mallory.proof, "only the agent's current key");
    let tx = w.test.transaction().call_function(template, "new", args![w.directory, "nobody"]).finish().seal(&mallory.key);
    w.test.execute_expect_failure(tx, vec![mallory.proof.clone()]);
}

#[test]
fn retired_agents_fall_silent() {
    let mut w = World::new();
    let (alice, bob) = (w.agent("alice"), w.agent("bob"));
    let sig = sign(&alice.owner, &retire_message(&w.directory, "alice", 0));
    let tx = w.test.transaction().call_method(w.directory, "retire", args!["alice", sig]).finish().seal(&alice.key);
    w.test.execute_expect_success(tx, vec![alice.proof.clone()]);
    let tx = w.tx(&alice, alice.channel, "post", args!["still here?", None::<PostRef>], &alice.key);
    w.fails(tx, &alice.proof, "agent is retired");
    let tx = w.tx(&bob, bob.channel, "follow", args!["alice"], &bob.key);
    w.fails(tx, &bob.proof, "that agent is retired");
}

#[test]
fn retraction_marks_but_keeps_the_post() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let seq = w.post(&alice, "oops, wrong lane id", None);
    w.call(&alice, "retract", args![seq]);
    let (post, retracted) = w.read(&alice, seq);
    assert!(retracted);
    assert_eq!(post.body, "oops, wrong lane id", "content stays on-chain");
    let tx = w.tx(&alice, alice.channel, "retract", args![9u64], &alice.key);
    w.fails(tx, &alice.proof, "no such post");
}

#[test]
fn follows_name_registered_agents() {
    let mut w = World::new();
    let (alice, _bob, _carol) = (w.agent("alice"), w.agent("bob"), w.agent("carol"));
    w.call(&alice, "follow", args!["bob"]);
    w.call(&alice, "follow", args!["carol"]);
    w.call(&alice, "follow", args!["bob"]);
    assert_eq!(w.follows(&alice), vec!["bob".to_string(), "carol".to_string()]);
    w.call(&alice, "unfollow", args!["bob"]);
    assert_eq!(w.follows(&alice), vec!["carol".to_string()]);
    let tx = w.tx(&alice, alice.channel, "follow", args!["nobody-here"], &alice.key);
    w.test.execute_expect_failure(tx, vec![alice.proof.clone()]);
    let tx = w.tx(&alice, alice.channel, "follow", args!["alice"], &alice.key);
    w.fails(tx, &alice.proof, "can't follow yourself");
}

#[test]
fn post_limits() {
    let mut w = World::new();
    let alice = w.agent("alice");
    let tx = w.tx(&alice, alice.channel, "post", args!["   ", None::<PostRef>], &alice.key);
    w.fails(tx, &alice.proof, "post is empty");
    let tx = w.tx(&alice, alice.channel, "post", args!["x".repeat(2_001), None::<PostRef>], &alice.key);
    w.fails(tx, &alice.proof, "post too long");
    w.post(&alice, &"x".repeat(2_000), None);
}

#[test]
fn posts_roll_over_into_a_new_page_vault() {
    let mut w = World::new();
    let alice = w.agent("alice");
    // A transaction may emit at most 256 events, so post in batches.
    let posts: Vec<u64> = (0..=PAGE_SIZE).collect();
    for batch in posts.chunks(50) {
        let mut builder = w.test.transaction();
        for i in batch {
            builder = builder.call_method(alice.channel, "post", args![format!("post {i}"), None::<PostRef>]);
        }
        let tx = builder.finish().seal(&alice.key);
        w.test.execute_expect_success(tx, vec![alice.proof.clone()]);
    }
    let (_, _, _, count, _) = w.info(&alice);
    assert_eq!(count, PAGE_SIZE + 1);
    let (post, _) = w.read(&alice, PAGE_SIZE);
    assert_eq!(post.body, format!("post {PAGE_SIZE}"));
    let _ = alice.account;
}
