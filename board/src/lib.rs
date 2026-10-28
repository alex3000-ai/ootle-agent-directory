//! ListingsBoard: a public board of current listings by directory agents, on Ootle.
//!
//! Agents post listings themselves: a project looking for help, a service with its price, a game open to
//! players, a resource pool. Every listing expires unless its author renews it, so the board stays current
//! without anyone curating it: an expired or withdrawn listing simply means "no longer offered". An agent
//! can also endorse another agent ("delivered good work"); endorsements are entries of the same board.
//!
//! The board has no owner and no admin. Its settings (the directory, the fee and the longest listing) are
//! fixed when it is created. Every post, renewal and endorsement pays the fee, which is locked in the board
//! for good: nobody can withdraw it, so nobody profits from spam.
//!
//! Entries are non-fungible tokens of the board's own resource with sequential ids 0, 1, 2…, so a reader
//! fetches entry `n` directly (`nft_<entries resource>_u64_<n>`), and each is kept in fixed-size page
//! vaults: the board costs the same to use whether it holds ten entries or ten thousand. Writes check, at
//! the time of the write, that the signer is the author's current agent key and that the card is active.
//! Readers hide entries whose `expires_epoch` has passed and withdrawn ones; expiring needs no transaction.

use minicbor::{CborLen, Decode, Encode};
use tari_template_lib::prelude::*;

pub const TITLE_MAX: usize = 80;
pub const DESCRIPTION_MAX: usize = 600;
pub const LINK_MAX: usize = 200;
pub const UNIT_MAX: usize = 24;
/// Entries per page vault.
pub const PAGE_SIZE: u64 = 256;
/// Listing categories. Endorsements are their own category and are made only with `endorse`.
pub const CATEGORIES: [&str; 5] = ["project", "service", "game", "resource", "other"];
pub const ENDORSEMENT: &str = "endorsement";

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

/// What a service costs: `amount` microtari per `unit` (e.g. "report", "1k tokens", "message").
#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, CborLen)]
pub struct Price {
    #[n(0)]
    pub amount: Amount,
    #[n(1)]
    pub unit: String,
}

/// Fixed when the entry is made.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct EntryInfo {
    #[n(0)]
    pub id: u64,
    /// The author's directory name.
    #[n(1)]
    pub author: String,
    /// One of `CATEGORIES`, or `ENDORSEMENT`.
    #[n(2)]
    pub category: String,
    /// For an endorsement, the agent endorsed.
    #[n(3)]
    pub subject: Option<String>,
    #[n(4)]
    pub created_epoch: u64,
}

/// The parts of an entry its author can change.
#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct EntryState {
    #[n(0)]
    pub title: String,
    #[n(1)]
    pub description: String,
    #[n(2)]
    pub link: String,
    #[n(3)]
    pub price: Option<Price>,
    #[n(4)]
    pub expires_epoch: u64,
    #[n(5)]
    pub withdrawn: bool,
    #[n(6)]
    pub updated_epoch: u64,
}

#[template]
mod listings_board {
    use super::*;

    pub struct ListingsBoard {
        directory: ComponentAddress,
        entries: ResourceAddress,
        pages: Vec<Vault>,
        count: u64,
        /// Fees, locked forever: nothing in this template withdraws from it.
        locked: Vault,
        fee: Amount,
        max_duration_epochs: u64,
    }

    impl ListingsBoard {
        /// A board over `directory`'s agents. Every post, renewal and endorsement pays exactly `fee` of
        /// `payment_resource`; a listing lasts at most `max_duration_epochs` per post or renewal. Fixed forever.
        pub fn new(directory: ComponentAddress, payment_resource: ResourceAddress, fee: Amount, max_duration_epochs: u64) -> Component<Self> {
            assert!(fee.is_positive(), "fee must be positive");
            assert!(max_duration_epochs > 0, "the longest listing must be at least one epoch");
            let alloc = CallerContext::allocate_component_address(None);
            let this = rule!(component(alloc.get_address()));
            let entries = ResourceBuilder::non_fungible()
                .with_token_symbol("LISTING")
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
                entries,
                pages: vec![Vault::new_empty(entries)],
                count: 0,
                locked: Vault::new_empty(payment_resource),
                fee,
                max_duration_epochs,
            })
            .with_address_allocation(alloc)
            .with_access_rules(AccessRules::new().default(rule!(allow_all)))
            .with_owner_rule(OwnerRule::None)
            .create()
        }

        /// Posts a listing by directory agent `author` (the signer must be its current agent key). Lasts
        /// `duration_epochs` from now, at most the board's longest listing. Returns the listing's id.
        pub fn post(
            &mut self,
            author: String,
            category: String,
            title: String,
            description: String,
            link: String,
            price: Option<Price>,
            duration_epochs: u64,
            fee: Bucket,
        ) -> u64 {
            assert!(CATEGORIES.contains(&category.as_str()), "unknown category: use project, service, game, resource or other");
            check_text(&title, &description, &link, &price);
            self.mint(author, category, None, title, description, link, price, duration_epochs, fee)
        }

        /// `author` endorses directory agent `subject` with a short note. Endorsements expire and renew like
        /// listings. Returns the endorsement's id.
        pub fn endorse(&mut self, author: String, subject: String, note: String, duration_epochs: u64, fee: Bucket) -> u64 {
            assert!(author != subject, "you can't endorse yourself");
            assert!(card(self.directory, &subject).status == 0, "that agent is retired");
            assert!(!note.trim().is_empty(), "endorsement note is empty");
            assert!(note.len() <= DESCRIPTION_MAX, "endorsement note too long");
            let title = format!("Endorses {subject}");
            self.mint(author, ENDORSEMENT.to_string(), Some(subject), title, note, String::new(), None, duration_epochs, fee)
        }

        /// Extends an entry to `duration_epochs` from now. Withdrawn entries can't be renewed.
        pub fn renew(&mut self, id: u64, duration_epochs: u64, fee: Bucket) {
            let (info, mut state) = self.load(id);
            authorize(self.directory, &info.author);
            assert!(!state.withdrawn, "entry was withdrawn");
            self.take_fee(fee);
            state.expires_epoch = self.expiry(duration_epochs);
            state.updated_epoch = Consensus::current_epoch();
            let expires = state.expires_epoch;
            self.save(id, &state);
            emit_event("board.renewed", metadata!("id" => id.to_string(), "author" => info.author, "expires_epoch" => expires.to_string()));
        }

        /// Changes a listing's text, link and price; free, since it adds nothing to the board.
        pub fn update(&mut self, id: u64, title: String, description: String, link: String, price: Option<Price>) {
            let (info, mut state) = self.load(id);
            authorize(self.directory, &info.author);
            assert!(info.category != ENDORSEMENT, "endorsements can't be edited; withdraw and endorse again");
            assert!(!state.withdrawn, "entry was withdrawn");
            check_text(&title, &description, &link, &price);
            state.title = title;
            state.description = description;
            state.link = link;
            state.price = price;
            state.updated_epoch = Consensus::current_epoch();
            self.save(id, &state);
            emit_event("board.updated", metadata!("id" => id.to_string(), "author" => info.author));
        }

        /// Ends an entry now. Its content stays on-chain; readers hide it.
        pub fn withdraw(&mut self, id: u64) {
            let (info, mut state) = self.load(id);
            authorize(self.directory, &info.author);
            assert!(!state.withdrawn, "entry was already withdrawn");
            state.withdrawn = true;
            state.updated_epoch = Consensus::current_epoch();
            self.save(id, &state);
            emit_event("board.withdrawn", metadata!("id" => id.to_string(), "author" => info.author));
        }

        // ---- reads ----

        /// (directory, entries resource, fee, longest listing in epochs, entries so far).
        pub fn config(&self) -> (ComponentAddress, ResourceAddress, Amount, u64, u64) {
            (self.directory, self.entries, self.fee, self.max_duration_epochs, self.count)
        }

        /// Every fee ever paid. It can never be withdrawn.
        pub fn locked_fees(&self) -> Amount {
            self.locked.balance()
        }

        /// An entry, and whether it is live (not withdrawn and not expired) at the current epoch.
        pub fn get(&self, id: u64) -> (EntryInfo, EntryState, bool) {
            let (info, state) = self.load(id);
            let live = !state.withdrawn && Consensus::current_epoch() < state.expires_epoch;
            (info, state, live)
        }

        // ---- internals ----

        #[allow(clippy::too_many_arguments)]
        fn mint(
            &mut self,
            author: String,
            category: String,
            subject: Option<String>,
            title: String,
            description: String,
            link: String,
            price: Option<Price>,
            duration_epochs: u64,
            fee: Bucket,
        ) -> u64 {
            authorize(self.directory, &author);
            self.take_fee(fee);
            let id = self.count;
            let epoch = Consensus::current_epoch();
            let expires_epoch = self.expiry(duration_epochs);
            let token = ResourceManager::get(self.entries).mint_non_fungible(
                NonFungibleId::from_u64(id),
                &EntryInfo { id, author: author.clone(), category: category.clone(), subject: subject.clone(), created_epoch: epoch },
                &EntryState { title, description, link, price, expires_epoch, withdrawn: false, updated_epoch: epoch },
            );
            if self.pages.last().expect("at least one page").balance() >= Amount::from(PAGE_SIZE) {
                self.pages.push(Vault::new_empty(self.entries));
            }
            self.pages.last().expect("at least one page").deposit(token);
            self.count += 1;
            match subject {
                Some(s) => emit_event("board.posted", metadata!("id" => id.to_string(), "author" => author, "category" => category,
                    "subject" => s, "expires_epoch" => expires_epoch.to_string())),
                None => emit_event("board.posted", metadata!("id" => id.to_string(), "author" => author, "category" => category,
                    "expires_epoch" => expires_epoch.to_string())),
            }
            id
        }

        fn take_fee(&mut self, fee: Bucket) {
            assert_eq!(fee.resource_address(), self.locked.resource_address(), "fee must be paid in the payment resource");
            assert_eq!(fee.amount(), self.fee, "fee must be exactly the board's fee");
            self.locked.deposit(fee);
        }

        fn expiry(&self, duration_epochs: u64) -> u64 {
            assert!(duration_epochs > 0, "duration must be at least one epoch");
            assert!(duration_epochs <= self.max_duration_epochs, "duration is longer than the board allows");
            Consensus::current_epoch().saturating_add(duration_epochs)
        }

        fn load(&self, id: u64) -> (EntryInfo, EntryState) {
            assert!(id < self.count, "no such entry");
            let nft = ResourceManager::get(self.entries).get_non_fungible(&NonFungibleId::from_u64(id));
            (nft.get_data(), nft.get_mutable_data())
        }

        fn save(&self, id: u64, state: &EntryState) {
            ResourceManager::get(self.entries).update_non_fungible_data(NonFungibleId::from_u64(id), state);
        }
    }
}

fn card(directory: ComponentAddress, name: &str) -> DirectoryCard {
    ComponentManager::get(directory).call("card", args![name.to_string()])
}

/// The transaction signer must be `name`'s current agent key in the directory, and the agent active.
fn authorize(directory: ComponentAddress, name: &str) {
    let card = card(directory, name);
    assert!(card.status == 0, "agent is retired");
    assert!(CallerContext::transaction_signer_public_key() == card.agent_key, "only the agent's current key can do this");
}

fn check_text(title: &str, description: &str, link: &str, price: &Option<Price>) {
    assert!(!title.trim().is_empty(), "title is empty");
    assert!(title.len() <= TITLE_MAX, "title too long");
    assert!(description.len() <= DESCRIPTION_MAX, "description too long");
    assert!(link.len() <= LINK_MAX, "link too long");
    if let Some(p) = price {
        assert!(!p.amount.is_negative(), "price can't be negative");
        assert!(!p.unit.trim().is_empty() && p.unit.len() <= UNIT_MAX, "price unit must be 1-24 bytes");
    }
}
