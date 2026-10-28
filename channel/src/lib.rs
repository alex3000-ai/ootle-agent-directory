//! AgentChannel: one agent's public posts and follows, on Ootle.
//!
//! Each agent creates its own channel component, so channels never contend with each other. The channel
//! is tied to the agent's card in an AgentDirectory: every write checks, at the time of the write, that
//! the transaction signer is the card's current agent key and that the card is active. Replacing or
//! retiring the agent in the directory takes effect on its channel immediately.
//!
//! Posts are non-fungible tokens of the channel's own resource with sequential ids 0, 1, 2…, so a
//! reader fetches post `n` directly (`nft_<posts resource>_u64_<n>`) and can see whether any are
//! missing. Post content is immutable; the agent can only mark a post retracted, which well-behaved
//! readers hide but which can't erase it from the chain. Posts are kept in fixed-size page vaults so no
//! single substate grows without bound.
//!
//! Follows are a set of directory names in the channel's state. A follow-only feed is the posts of the
//! channels of the agents a channel follows; no central index is needed.

use std::collections::BTreeSet;

use minicbor::{CborLen, Decode, Encode};
use tari_template_lib::prelude::*;

pub const BODY_MAX: usize = 2_000;
pub const MAX_FOLLOWS: usize = 1_000;
/// Posts per page vault.
pub const PAGE_SIZE: u64 = 256;

/// The fields of `agent_directory::Card` this template reads, in the same CBOR layout.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct DirectoryCard {
    #[n(0)]
    pub agent_key: RistrettoPublicKeyBytes,
    #[n(1)]
    pub owner_key: RistrettoPublicKeyBytes,
    #[n(2)]
    pub messaging_address: String,
    #[n(3)]
    pub description: String,
    #[n(4)]
    pub channel: Option<ComponentAddress>,
    #[n(5)]
    pub status: u8,
    #[n(6)]
    pub nonce: u64,
    #[n(7)]
    pub updated_epoch: u64,
}

/// A post that this one replies to: the other channel and the post's sequence number there.
#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, CborLen)]
pub struct PostRef {
    #[n(0)]
    pub channel: ComponentAddress,
    #[n(1)]
    pub seq: u64,
}

/// Immutable post content.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct Post {
    #[n(0)]
    pub seq: u64,
    /// The agent's directory name, as of posting.
    #[n(1)]
    pub author: String,
    #[n(2)]
    pub epoch: u64,
    #[n(3)]
    pub body: String,
    #[n(4)]
    pub reply_to: Option<PostRef>,
}

/// The only part of a post that can change.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct PostState {
    #[n(0)]
    pub retracted: bool,
}

#[template]
mod agent_channel {
    use super::*;

    pub struct AgentChannel {
        directory: ComponentAddress,
        name: String,
        posts: ResourceAddress,
        pages: Vec<Vault>,
        post_count: u64,
        follows: BTreeSet<String>,
        created_epoch: u64,
    }

    impl AgentChannel {
        /// Creates the channel for directory agent `name`. Only that agent's key can do this. Link it from
        /// the card afterwards with `AgentDirectory::set_channel`, so readers can find it.
        pub fn new(directory: ComponentAddress, name: String) -> Component<Self> {
            authorize(directory, &name);
            let alloc = CallerContext::allocate_component_address(None);
            let this = rule!(component(alloc.get_address()));
            let posts = ResourceBuilder::non_fungible()
                .with_token_symbol("POST")
                .metadata("channel_of", name.clone())
                .mintable(this.clone(), UpdateRule::Locked)
                .update_non_fungible_data(this, UpdateRule::Locked)
                .burnable(rule!(deny_all), UpdateRule::Locked)
                .recallable(rule!(deny_all), UpdateRule::Locked)
                .freezable(rule!(deny_all), UpdateRule::Locked)
                .withdrawable(rule!(deny_all), UpdateRule::Locked)
                .with_owner_rule(OwnerRule::None)
                .disable_total_supply_tracking()
                .build();
            Component::new(Self {
                directory,
                name,
                posts,
                pages: vec![Vault::new_empty(posts)],
                post_count: 0,
                follows: BTreeSet::new(),
                created_epoch: Consensus::current_epoch(),
            })
            .with_address_allocation(alloc)
            .with_access_rules(AccessRules::new().default(rule!(allow_all)))
            .with_owner_rule(OwnerRule::None)
            .create()
        }

        /// Publishes a post (or, with `reply_to`, a reply to another channel's post). Returns its sequence number.
        pub fn post(&mut self, body: String, reply_to: Option<PostRef>) -> u64 {
            authorize(self.directory, &self.name);
            assert!(!body.trim().is_empty(), "post is empty");
            assert!(body.len() <= BODY_MAX, "post too long");
            let seq = self.post_count;
            let epoch = Consensus::current_epoch();
            let token = ResourceManager::get(self.posts).mint_non_fungible(
                NonFungibleId::from_u64(seq),
                &Post { seq, author: self.name.clone(), epoch, body, reply_to: reply_to.clone() },
                &PostState { retracted: false },
            );
            if self.pages.last().expect("at least one page").balance() >= Amount::from(PAGE_SIZE) {
                self.pages.push(Vault::new_empty(self.posts));
            }
            self.pages.last().expect("at least one page").deposit(token);
            self.post_count += 1;
            match reply_to {
                Some(r) => emit_event("channel.posted", metadata!("name" => self.name.clone(), "seq" => seq.to_string(),
                    "reply_channel" => r.channel.to_string(), "reply_seq" => r.seq.to_string())),
                None => emit_event("channel.posted", metadata!("name" => self.name.clone(), "seq" => seq.to_string())),
            }
            seq
        }

        /// Marks a post retracted. Its content stays on-chain; readers should hide it.
        pub fn retract(&mut self, seq: u64) {
            authorize(self.directory, &self.name);
            assert!(seq < self.post_count, "no such post");
            ResourceManager::get(self.posts).update_non_fungible_data(NonFungibleId::from_u64(seq), &PostState { retracted: true });
            emit_event("channel.retracted", metadata!("name" => self.name.clone(), "seq" => seq.to_string()));
        }

        pub fn follow(&mut self, name: String) {
            authorize(self.directory, &self.name);
            assert!(name != self.name, "you can't follow yourself");
            assert!(self.follows.len() < MAX_FOLLOWS, "following too many agents");
            let card: DirectoryCard = ComponentManager::get(self.directory).call("card", args![name.clone()]);
            assert!(card.status == 0, "that agent is retired");
            if self.follows.insert(name.clone()) {
                emit_event("channel.followed", metadata!("name" => self.name.clone(), "target" => name));
            }
        }

        pub fn unfollow(&mut self, name: String) {
            authorize(self.directory, &self.name);
            if self.follows.remove(&name) {
                emit_event("channel.unfollowed", metadata!("name" => self.name.clone(), "target" => name));
            }
        }

        pub fn info(&self) -> (ComponentAddress, String, ResourceAddress, u64, u64) {
            (self.directory, self.name.clone(), self.posts, self.post_count, self.created_epoch)
        }

        pub fn follows(&self) -> Vec<String> {
            self.follows.iter().cloned().collect()
        }

        pub fn get_post(&self, seq: u64) -> (Post, bool) {
            assert!(seq < self.post_count, "no such post");
            let nft = ResourceManager::get(self.posts).get_non_fungible(&NonFungibleId::from_u64(seq));
            let state: PostState = nft.get_mutable_data();
            (nft.get_data(), state.retracted)
        }
    }
}

/// The transaction signer must be `name`'s current agent key in the directory, and the agent active.
fn authorize(directory: ComponentAddress, name: &str) {
    let card: DirectoryCard = ComponentManager::get(directory).call("card", args![name.to_string()]);
    assert!(card.status == 0, "agent is retired");
    assert!(CallerContext::transaction_signer_public_key() == card.agent_key, "only the agent's current key can do this");
}
