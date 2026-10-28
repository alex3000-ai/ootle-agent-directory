//! End-to-end tests for AgentDirectory, executed in-process by the Ootle engine
//! (`tari_template_test_tooling`).

use agent_directory::{register_message, retire_message, rotate_message, transfer_message, Card, DIRECTORY_DOMAIN, STATUS_RETIRED};
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

struct Party {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
}

impl Party {
    fn public_key(&self) -> RistrettoPublicKeyBytes {
        pk(&self.key)
    }
}

fn pk(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

fn new_key() -> RistrettoSecretKey {
    RistrettoSecretKey::random(&mut rand::rng())
}

/// Signs an owner statement exactly as the off-chain client does.
fn sign(key: &RistrettoSecretKey, message: &[u8]) -> SignaturePayload {
    let (nonce, public_nonce) = RistrettoPublicKey::random_keypair(&mut rand::rng());
    let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(DIRECTORY_DOMAIN, message, &pk(key), &public_nonce.to_byte_type());
    let signature = RistrettoSchnorr::sign_raw_uniform(key, nonce, &challenge).expect("sign");
    SignaturePayload::RistrettoSchnorrBlake2b(signature.to_byte_type())
}

struct Dir {
    test: TemplateTest,
    directory: ComponentAddress,
    cards: ResourceAddress,
}

impl Dir {
    fn deploy() -> Self {
        let mut test = TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../directory"]);
        let directory = Self::instantiate(&mut test);
        let cards = test.call_method(directory, "cards_resource", args![], vec![]);
        Self { test, directory, cards }
    }

    fn instantiate(test: &mut TemplateTest) -> ComponentAddress {
        let template = test.get_template_address("AgentDirectory");
        let (account, proof, key) = test.create_funded_account();
        let _ = account;
        test.execute_expect_success(
            test.transaction().call_function(template, "new", args![TARI_TOKEN, Amount::from(FEE)]).finish().seal(&key),
            vec![proof],
        );
        *test.return_values()[0].component_addresses().first().expect("no component")
    }

    fn party(&mut self) -> Party {
        let (account, proof, key) = self.test.create_funded_account();
        Party { account, proof, key }
    }

    fn register_tx(&self, agent: &Party, name: &str, owner_key: RistrettoPublicKeyBytes, sig: SignaturePayload, fee: u64) -> Transaction {
        self.test
            .transaction()
            .call_method(agent.account, "withdraw", args![TARI_TOKEN, fee])
            .put_last_instruction_output_on_workspace("fee")
            .call_method(self.directory, "register", args![name, owner_key, "otl_esm_example", "test agent", sig, Workspace("fee")])
            .put_last_instruction_output_on_workspace("card")
            .call_method(agent.account, "deposit", args![Workspace("card")])
            .finish()
            .seal(&agent.key)
    }

    /// Registers `name` for `agent`, owned by `owner`.
    fn register(&mut self, agent: &Party, owner: &RistrettoSecretKey, name: &str) {
        let sig = sign(owner, &register_message(&self.directory, name, &agent.public_key(), "otl_esm_example"));
        let tx = self.register_tx(agent, name, pk(owner), sig, FEE);
        self.test.execute_expect_success(tx, vec![agent.proof.clone()]);
    }

    fn rejected(&mut self, tx: Transaction, proofs: Vec<NonFungibleAddress>, expected: &str) {
        let reason = self.test.execute_expect_failure(tx, proofs).to_string();
        assert!(reason.contains(expected), "expected rejection containing {expected:?}, got: {reason}");
    }

    fn call(&mut self, party: &Party, method: &str, args: Vec<NamedArg>) {
        let tx = self.test.transaction().call_method(self.directory, method, args).finish().seal(&party.key);
        self.test.execute_expect_success(tx, vec![party.proof.clone()]);
    }

    fn call_fails(&mut self, party: &Party, method: &str, args: Vec<NamedArg>, expected: &str) {
        let tx = self.test.transaction().call_method(self.directory, method, args).finish().seal(&party.key);
        self.rejected(tx, vec![party.proof.clone()], expected);
    }

    /// `Card` is CBOR-only, so read it from a transaction's return value.
    fn card(&mut self, name: &str) -> Card {
        let reader = self.party();
        let tx = self.test.transaction().call_method(self.directory, "card", args![name]).finish().seal(&reader.key);
        self.test.execute_expect_success(tx, vec![reader.proof.clone()]);
        self.test.return_values()[0].decoded().expect("decode card")
    }

    fn nonce(&mut self, name: &str) -> u64 {
        self.card(name).nonce
    }

    fn tari(&mut self, party: &Party) -> Amount {
        self.test.call_method(party.account, "balance", args![TARI_TOKEN], vec![])
    }

    fn cards_held(&mut self, party: &Party) -> Amount {
        self.test.call_method(party.account, "balance", args![self.cards], vec![])
    }
}

#[test]
fn register_records_the_card_locks_the_fee_and_hands_the_card_to_the_agent() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let owner = new_key();
    let before = d.tari(&agent);
    d.register(&agent, &owner, "hexherald");

    let card = d.card("hexherald");
    assert_eq!(card.agent_key, agent.public_key());
    assert_eq!(card.owner_key, pk(&owner));
    assert_eq!(card.messaging_address, "otl_esm_example");
    assert_eq!(card.nonce, 0);
    assert_eq!(d.cards_held(&agent), Amount::from(1u64));
    assert!(before - d.tari(&agent) >= Amount::from(FEE), "the fee left the agent's account");
    let fee: Amount = d.test.call_method(d.directory, "name_fee", args![], vec![]);
    assert_eq!(fee, Amount::from(FEE));
    let locked: Amount = d.test.call_method(d.directory, "locked_fees", args![], vec![]);
    assert_eq!(locked, Amount::from(FEE));
}

#[test]
fn names_are_unique() {
    let mut d = Dir::deploy();
    let (a, b) = (d.party(), d.party());
    d.register(&a, &new_key(), "shard-scout");
    let owner = new_key();
    let sig = sign(&owner, &register_message(&d.directory, "shard-scout", &b.public_key(), "otl_esm_example"));
    let tx = d.register_tx(&b, "shard-scout", pk(&owner), sig, FEE);
    d.rejected(tx, vec![b.proof.clone()], "Duplicate NFT token id");
    assert_eq!(d.card("shard-scout").agent_key, a.public_key(), "the first registration stands");
}

#[test]
fn invalid_names_are_rejected() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let owner = new_key();
    for name in ["a", "HexHerald", "-dash", "has space", "émoji", &"x".repeat(33)] {
        let sig = sign(&owner, &register_message(&d.directory, name, &agent.public_key(), "otl_esm_example"));
        let tx = d.register_tx(&agent, name, pk(&owner), sig, FEE);
        d.rejected(tx, vec![agent.proof.clone()], "invalid name");
    }
}

#[test]
fn the_fee_must_be_exact() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let owner = new_key();
    for fee in [FEE - 1, FEE + 1] {
        let sig = sign(&owner, &register_message(&d.directory, "fee-test", &agent.public_key(), "otl_esm_example"));
        let tx = d.register_tx(&agent, "fee-test", pk(&owner), sig, fee);
        d.rejected(tx, vec![agent.proof.clone()], "exactly the name fee");
    }
}

#[test]
fn the_owner_signature_must_cover_this_name_key_and_directory() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let owner = new_key();
    let reject = |d: &mut Dir, sig: SignaturePayload| {
        let tx = d.register_tx(&agent, "signed", pk(&owner), sig, FEE);
        d.rejected(tx, vec![agent.proof.clone()], "invalid owner signature");
    };
    let dir = d.directory;
    let impostor = new_key();
    reject(&mut d, sign(&impostor, &register_message(&dir, "signed", &agent.public_key(), "otl_esm_example")));
    reject(&mut d, sign(&owner, &register_message(&dir, "other-name", &agent.public_key(), "otl_esm_example")));
    reject(&mut d, sign(&owner, &register_message(&dir, "signed", &pk(&new_key()), "otl_esm_example")));
    reject(&mut d, sign(&owner, &register_message(&dir, "signed", &agent.public_key(), "otl_esm_attacker")));
    let other_directory = Dir::instantiate(&mut d.test);
    reject(&mut d, sign(&owner, &register_message(&other_directory, "signed", &agent.public_key(), "otl_esm_example")));
}

#[test]
fn an_agent_can_own_itself() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let key = agent.key.clone();
    d.register(&agent, &key, "autonomous");
    assert_eq!(d.card("autonomous").owner_key, agent.public_key());
}

#[test]
fn only_the_agent_key_edits_its_card() {
    let mut d = Dir::deploy();
    let (agent, stranger) = (d.party(), d.party());
    d.register(&agent, &new_key(), "editor");
    d.call(&agent, "set_messaging_address", args!["editor", "otl_esm_new"]);
    d.call(&agent, "set_description", args!["editor", "builds escrow templates"]);
    d.call(&agent, "set_channel", args!["editor", Some(agent.account)]);
    let card = d.card("editor");
    assert_eq!((card.messaging_address.as_str(), card.description.as_str(), card.channel), ("otl_esm_new", "builds escrow templates", Some(agent.account)));
    d.call_fails(&stranger, "set_messaging_address", args!["editor", "otl_esm_attacker"], "only the agent key");
    d.call_fails(&agent, "set_description", args!["editor", "x".repeat(281)], "description too long");
    assert_eq!(d.card("editor").nonce, 0, "agent edits don't use owner nonces");
}

#[test]
fn the_owner_rotates_the_agent_key_once_per_signature() {
    let mut d = Dir::deploy();
    let (agent, relayer) = (d.party(), d.party());
    let owner = new_key();
    d.register(&agent, &owner, "rotating");
    let replacement = d.party();
    let nonce = d.nonce("rotating");
    let sig = sign(&owner, &rotate_message(&d.directory, "rotating", nonce, &replacement.public_key()));
    d.call(&relayer, "rotate_agent_key", args!["rotating", replacement.public_key(), sig.clone()]);
    assert_eq!(d.card("rotating").agent_key, replacement.public_key());
    d.call_fails(&relayer, "rotate_agent_key", args!["rotating", replacement.public_key(), sig], "invalid owner signature");
    d.call_fails(&agent, "set_description", args!["rotating", "old key"], "only the agent key");
    d.call(&replacement, "set_description", args!["rotating", "new key"]);
    let forged = sign(&new_key(), &rotate_message(&d.directory, "rotating", 1, &agent.public_key()));
    d.call_fails(&relayer, "rotate_agent_key", args!["rotating", agent.public_key(), forged], "invalid owner signature");
}

#[test]
fn retiring_is_permanent_and_keeps_the_name_taken() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let owner = new_key();
    d.register(&agent, &owner, "sunset");
    let sig = sign(&owner, &retire_message(&d.directory, "sunset", 0));
    d.call(&agent, "retire", args!["sunset", sig]);
    assert_eq!(d.card("sunset").status, STATUS_RETIRED);
    d.call_fails(&agent, "set_description", args!["sunset", "back"], "retired");
    let sig = sign(&owner, &rotate_message(&d.directory, "sunset", 1, &agent.public_key()));
    d.call_fails(&agent, "rotate_agent_key", args!["sunset", agent.public_key(), sig], "retired");
    let squatter = d.party();
    let squat_owner = new_key();
    let sig = sign(&squat_owner, &register_message(&d.directory, "sunset", &squatter.public_key(), "otl_esm_example"));
    let tx = d.register_tx(&squatter, "sunset", pk(&squat_owner), sig, FEE);
    d.rejected(tx, vec![squatter.proof.clone()], "Duplicate NFT token id");
}

#[test]
fn transferring_ownership_needs_both_owners() {
    let mut d = Dir::deploy();
    let agent = d.party();
    let (old, new) = (new_key(), new_key());
    d.register(&agent, &old, "handover");
    let message = transfer_message(&d.directory, "handover", 0, &pk(&new));
    d.call_fails(&agent, "transfer_owner", args!["handover", pk(&new), sign(&old, &message), sign(&new_key(), &message)], "invalid new owner signature");
    d.call_fails(&agent, "transfer_owner", args!["handover", pk(&new), sign(&new_key(), &message), sign(&new, &message)], "invalid owner signature");
    d.call(&agent, "transfer_owner", args!["handover", pk(&new), sign(&old, &message), sign(&new, &message)]);
    assert_eq!(d.card("handover").owner_key, pk(&new));
    let stale = sign(&old, &retire_message(&d.directory, "handover", 1));
    d.call_fails(&agent, "retire", args!["handover", stale], "invalid owner signature");
}

#[test]
fn cards_cannot_leave_the_agents_account() {
    let mut d = Dir::deploy();
    let (agent, buyer) = (d.party(), d.party());
    d.register(&agent, &new_key(), "soulbound");
    let tx = d
        .test
        .transaction()
        .call_method(agent.account, "withdraw", args![d.cards, Amount::from(1u64)])
        .put_last_instruction_output_on_workspace("card")
        .call_method(buyer.account, "deposit", args![Workspace("card")])
        .finish()
        .seal(&agent.key);
    d.rejected(tx, vec![agent.proof.clone()], "Access Denied: native.resource.Withdraw");
    assert_eq!(d.cards_held(&agent), Amount::from(1u64));
}
