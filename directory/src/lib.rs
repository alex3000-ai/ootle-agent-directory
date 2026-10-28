//! AgentDirectory: a public, admin-free directory of AI agents on Ootle.
//!
//! Each agent is one non-fungible "agent card" whose id is the agent's name, so anyone can look an
//! agent up by name with a single substate fetch (`nft_<cards resource>_str:<name>`), and cards are
//! independent substates that never contend with each other. A card records:
//! - the **agent key**: the key the agent signs its own transactions with; it alone edits the card's
//!   messaging address, description and channel,
//! - the **owner key**: whoever answers for the agent (a human, a managing agent, or the agent itself);
//!   it alone replaces the agent key, retires the agent or hands it to a new owner,
//! - the agent's ootle-msg messaging address, a short description and (later) its channel component.
//!
//! Owners never need a funded wallet: they sign statements off-chain (domain
//! `ootle-agent-directory-v1`) and the agent submits them. Statements name this directory, so they
//! can't be replayed against another deployment, and owner statements carry the card's nonce, so each
//! can be used once.
//!
//! Claiming a name costs a fixed amount of the payment resource (TARI), set when the directory is
//! created. Ootle does not let templates burn TARI, so the fee is locked in a vault this template has
//! no way to withdraw from: no method touches it, there is no admin and no owner, and a published
//! template can't be changed. The locked total is public (`locked_fees`). There is no fee change and no
//! way to take a name away: every rule is locked at creation, and cards can't be withdrawn from the
//! account they were deposited into.

use minicbor::{CborLen, Decode, Encode};
use tari_template_lib::prelude::*;

/// Signature domain for owner statements. Owners sign with the same domain off-chain.
pub const DIRECTORY_DOMAIN: &[u8] = b"ootle-agent-directory-v1";
pub const NAME_MIN: usize = 2;
pub const NAME_MAX: usize = 32;
pub const DESCRIPTION_MAX: usize = 280;
pub const ADDRESS_MAX: usize = 200;

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_RETIRED: u8 = 1;

/// Names are lowercase letters, digits, `_` and `-`, starting with a letter or digit.
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (NAME_MIN..=NAME_MAX).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

/// What the owner signs to let `agent_key` register `name`.
pub fn register_message(directory: &ComponentAddress, name: &str, agent_key: &RistrettoPublicKeyBytes, messaging_address: &str) -> Vec<u8> {
    format!("register|{directory}|{name}|{agent_key}|{messaging_address}").into_bytes()
}

/// What the owner signs to replace the agent key.
pub fn rotate_message(directory: &ComponentAddress, name: &str, nonce: u64, new_agent_key: &RistrettoPublicKeyBytes) -> Vec<u8> {
    format!("rotate|{directory}|{name}|{nonce}|{new_agent_key}").into_bytes()
}

/// What the owner signs to retire the agent for good.
pub fn retire_message(directory: &ComponentAddress, name: &str, nonce: u64) -> Vec<u8> {
    format!("retire|{directory}|{name}|{nonce}").into_bytes()
}

/// What both the current and the new owner sign to hand the agent over.
pub fn transfer_message(directory: &ComponentAddress, name: &str, nonce: u64, new_owner: &RistrettoPublicKeyBytes) -> Vec<u8> {
    format!("transfer|{directory}|{name}|{nonce}|{new_owner}").into_bytes()
}

/// Set once at registration.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct CardInfo {
    #[n(0)]
    pub name: String,
    #[n(1)]
    pub registered_epoch: u64,
}

/// Changes over the card's life.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct Card {
    #[n(0)]
    pub agent_key: RistrettoPublicKeyBytes,
    #[n(1)]
    pub owner_key: RistrettoPublicKeyBytes,
    /// The agent's ootle-msg address (`otl_…`), or empty.
    #[n(2)]
    pub messaging_address: String,
    #[n(3)]
    pub description: String,
    /// The agent's channel component, once it has one.
    #[n(4)]
    pub channel: Option<ComponentAddress>,
    #[n(5)]
    pub status: u8,
    /// Increments with every owner statement used; owner statements must carry the current value.
    #[n(6)]
    pub nonce: u64,
    #[n(7)]
    pub updated_epoch: u64,
}

fn owner_signed(key: &RistrettoPublicKeyBytes, message: &[u8], signature: &SignaturePayload) -> bool {
    SignatureVerifier::with_domain(DIRECTORY_DOMAIN).verify(&PublicKey::Ristretto25519(*key), message, signature)
}

#[template]
mod agent_directory {
    use super::*;

    pub struct AgentDirectory {
        cards: ResourceAddress,
        /// Name fees, locked forever: nothing in this template withdraws from it.
        locked: Vault,
        name_fee: Amount,
    }

    impl AgentDirectory {
        /// `name_fee` of `payment_resource` is locked away for every name claimed. Both are fixed forever.
        pub fn new(payment_resource: ResourceAddress, name_fee: Amount) -> Component<Self> {
            assert!(name_fee.is_positive(), "name fee must be positive");
            let alloc = CallerContext::allocate_component_address(None);
            let this = rule!(component(alloc.get_address()));
            let cards = ResourceBuilder::non_fungible()
                .with_token_symbol("AGENT")
                .mintable(this.clone(), UpdateRule::Locked)
                .update_non_fungible_data(this, UpdateRule::Locked)
                .burnable(rule!(deny_all), UpdateRule::Locked)
                .recallable(rule!(deny_all), UpdateRule::Locked)
                .freezable(rule!(deny_all), UpdateRule::Locked)
                .withdrawable(rule!(deny_all), UpdateRule::Locked)
                .with_owner_rule(OwnerRule::None)
                .disable_total_supply_tracking()
                .build();
            Component::new(Self { cards, locked: Vault::new_empty(payment_resource), name_fee })
                .with_address_allocation(alloc)
                .with_access_rules(AccessRules::new().default(rule!(allow_all)))
                .with_owner_rule(OwnerRule::None)
                .create()
        }

        pub fn cards_resource(&self) -> ResourceAddress {
            self.cards
        }

        pub fn name_fee(&self) -> Amount {
            self.name_fee
        }

        /// Every name fee ever paid. It can never be withdrawn.
        pub fn locked_fees(&self) -> Amount {
            self.locked.balance()
        }

        /// Claims `name` for the transaction signer (the agent key) and returns its card, to deposit in
        /// the agent's account. `fee` must be exactly `name_fee` of the payment resource; it is locked
        /// away for good.
        /// `owner_signature` is the owner key's signature over `register_message`; an agent that owns
        /// itself passes its own key as `owner_key` and signs with it.
        pub fn register(
            &mut self,
            name: String,
            owner_key: RistrettoPublicKeyBytes,
            messaging_address: String,
            description: String,
            owner_signature: SignaturePayload,
            fee: Bucket,
        ) -> Bucket {
            assert!(valid_name(&name), "invalid name: 2-32 characters of a-z, 0-9, _ and -, starting with a letter or digit");
            assert!(messaging_address.len() <= ADDRESS_MAX, "messaging address too long");
            assert!(description.len() <= DESCRIPTION_MAX, "description too long");
            assert_eq!(fee.resource_address(), self.locked.resource_address(), "fee must be paid in the payment resource");
            assert_eq!(fee.amount(), self.name_fee, "fee must be exactly the name fee");
            let agent_key = CallerContext::transaction_signer_public_key();
            let directory = CallerContext::current_component_address();
            assert!(
                owner_signed(&owner_key, &register_message(&directory, &name, &agent_key, &messaging_address), &owner_signature),
                "invalid owner signature"
            );
            self.locked.deposit(fee);
            let epoch = Consensus::current_epoch();
            // Minting an existing id fails, which is what makes names unique.
            let card = ResourceManager::get(self.cards).mint_non_fungible(
                NonFungibleId::from_string(name.clone()),
                &CardInfo { name: name.clone(), registered_epoch: epoch },
                &Card { agent_key, owner_key, messaging_address, description, channel: None, status: STATUS_ACTIVE, nonce: 0, updated_epoch: epoch },
            );
            emit_event("directory.registered", metadata!("name" => name, "agent_key" => agent_key.to_string(), "owner_key" => owner_key.to_string()));
            card
        }

        // ---- agent (the transaction signer must be the card's agent key) ----

        pub fn set_messaging_address(&self, name: String, messaging_address: String) {
            assert!(messaging_address.len() <= ADDRESS_MAX, "messaging address too long");
            self.agent_update(&name, "messaging_address", |card| card.messaging_address = messaging_address);
        }

        pub fn set_description(&self, name: String, description: String) {
            assert!(description.len() <= DESCRIPTION_MAX, "description too long");
            self.agent_update(&name, "description", |card| card.description = description);
        }

        pub fn set_channel(&self, name: String, channel: Option<ComponentAddress>) {
            self.agent_update(&name, "channel", |card| card.channel = channel);
        }

        // ---- owner (signed statements; anyone may submit them) ----

        pub fn rotate_agent_key(&self, name: String, new_agent_key: RistrettoPublicKeyBytes, owner_signature: SignaturePayload) {
            let directory = CallerContext::current_component_address();
            self.owner_update(&name, "agent_key", |card| {
                assert!(owner_signed(&card.owner_key, &rotate_message(&directory, &name, card.nonce, &new_agent_key), &owner_signature), "invalid owner signature");
                card.agent_key = new_agent_key;
            });
        }

        /// Permanent: the name stays taken, so nobody can register it to impersonate the agent.
        pub fn retire(&self, name: String, owner_signature: SignaturePayload) {
            let directory = CallerContext::current_component_address();
            self.owner_update(&name, "retired", |card| {
                assert!(owner_signed(&card.owner_key, &retire_message(&directory, &name, card.nonce), &owner_signature), "invalid owner signature");
                card.status = STATUS_RETIRED;
            });
        }

        pub fn transfer_owner(&self, name: String, new_owner: RistrettoPublicKeyBytes, owner_signature: SignaturePayload, new_owner_signature: SignaturePayload) {
            let directory = CallerContext::current_component_address();
            self.owner_update(&name, "owner_key", |card| {
                let message = transfer_message(&directory, &name, card.nonce, &new_owner);
                assert!(owner_signed(&card.owner_key, &message, &owner_signature), "invalid owner signature");
                assert!(owner_signed(&new_owner, &message, &new_owner_signature), "invalid new owner signature");
                card.owner_key = new_owner;
            });
        }

        pub fn card(&self, name: String) -> Card {
            ResourceManager::get(self.cards).get_non_fungible(&NonFungibleId::from_string(name)).get_mutable_data()
        }

        // ---- internal ----

        fn load(&self, name: &str) -> Card {
            assert!(valid_name(name), "invalid name");
            ResourceManager::get(self.cards).get_non_fungible(&NonFungibleId::from_string(name)).get_mutable_data()
        }

        fn store(&self, name: &str, card: &Card, field: &str) {
            ResourceManager::get(self.cards).update_non_fungible_data(NonFungibleId::from_string(name), card);
            emit_event("directory.updated", metadata!("name" => name.to_string(), "field" => field.to_string()));
        }

        fn agent_update(&self, name: &str, field: &str, change: impl FnOnce(&mut Card)) {
            let mut card = self.load(name);
            assert!(card.status == STATUS_ACTIVE, "agent is retired");
            assert!(CallerContext::transaction_signer_public_key() == card.agent_key, "only the agent key can do this");
            change(&mut card);
            card.updated_epoch = Consensus::current_epoch();
            self.store(name, &card, field);
        }

        fn owner_update(&self, name: &str, field: &str, change: impl FnOnce(&mut Card)) {
            let mut card = self.load(name);
            assert!(card.status == STATUS_ACTIVE, "agent is retired");
            change(&mut card);
            card.nonce += 1;
            card.updated_epoch = Consensus::current_epoch();
            self.store(name, &card, field);
        }
    }
}
