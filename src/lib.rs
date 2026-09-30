#![no_std]
//! Payment Vault: a simple contract that can receive tokens (like USDC)
//! and lets ONLY the owner withdraw them to any wallet.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

/// About 30 days of ledgers (5s each). Storage is renewed when it drops below this.
const TTL_THRESHOLD: u32 = 518_400;
/// About 120 days of ledgers. Storage is renewed up to this.
const TTL_EXTEND_TO: u32 = 2_073_600;

#[contracttype]
enum DataKey {
    Owner,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 2,
    InsufficientBalance = 3,
}

/// Emitted on every withdrawal.
#[contractevent(topics = ["withdraw"])]
pub struct Withdraw {
    #[topic]
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

/// Emitted when ownership changes.
#[contractevent(topics = ["owner_changed"])]
pub struct OwnerChanged {
    pub old_owner: Address,
    pub new_owner: Address,
}

#[contract]
pub struct PaymentVault;

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn do_withdraw(env: &Env, token: &Address, to: &Address, amount: i128) -> Result<i128, Error> {
    let owner = PaymentVault::owner(env.clone());
    owner.require_auth(); // only the owner can do this
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let client = token::Client::new(env, token);
    let me = env.current_contract_address();
    if client.balance(&me) < amount {
        return Err(Error::InsufficientBalance);
    }
    client.transfer(&me, to, &amount);
    Withdraw {
        token: token.clone(),
        to: to.clone(),
        amount,
    }
    .publish(env);
    bump(env);
    Ok(amount)
}

#[contractimpl]
impl PaymentVault {
    /// Runs once at deploy time and sets who owns the vault.
    pub fn __constructor(env: Env, owner: Address) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        bump(&env);
    }

    /// Who owns the vault.
    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    /// How much of a token the vault holds.
    pub fn balance(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Anyone can call this to keep the vault's storage from being archived.
    pub fn bump(env: Env) {
        bump(&env);
    }

    /// Owner-only: send `amount` of `token` from the vault to `to`.
    pub fn withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<(), Error> {
        do_withdraw(&env, &token, &to, amount).map(|_| ())
    }

    /// Owner-only: send the vault's entire balance of `token` to `to`.
    /// Returns the amount sent. Fails with InvalidAmount if the vault is empty.
    pub fn withdraw_all(env: Env, token: Address, to: Address) -> Result<i128, Error> {
        let bal = token::Client::new(&env, &token).balance(&env.current_contract_address());
        do_withdraw(&env, &token, &to, bal)
    }

    /// Owner-only: hand the vault to a new owner (both must approve).
    pub fn set_owner(env: Env, new_owner: Address) {
        let owner = Self::owner(env.clone());
        owner.require_auth();
        new_owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &new_owner);
        OwnerChanged {
            old_owner: owner,
            new_owner,
        }
        .publish(&env);
        bump(&env);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::storage::Instance as _,
        testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        Env, IntoVal,
    };

    fn setup() -> (Env, Address, Address, Address, PaymentVaultClient<'static>) {
        let env = Env::default();
        let owner = Address::generate(&env);
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin).address();
        let vault_id = env.register(PaymentVault, (owner.clone(),));
        let vault = PaymentVaultClient::new(&env, &vault_id);
        env.mock_all_auths();
        StellarAssetClient::new(&env, &token).mint(&vault_id, &1_000);
        (env, owner, token, vault_id, vault)
    }

    #[test]
    fn owner_can_withdraw() {
        let (env, _owner, token, _id, vault) = setup();
        let wallet = Address::generate(&env);
        vault.withdraw(&token, &wallet, &400);
        assert_eq!(token::Client::new(&env, &token).balance(&wallet), 400);
        assert_eq!(vault.balance(&token), 600);
        assert_eq!(vault.withdraw_all(&token, &wallet), 600);
        assert_eq!(vault.balance(&token), 0);
    }

    #[test]
    fn rejects_bad_amounts() {
        let (env, _o, token, _id, vault) = setup();
        let w = Address::generate(&env);
        assert_eq!(
            vault.try_withdraw(&token, &w, &0),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            vault.try_withdraw(&token, &w, &-1),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            vault.try_withdraw(&token, &w, &5_000),
            Err(Ok(Error::InsufficientBalance))
        );
        vault.withdraw_all(&token, &w);
        assert_eq!(
            vault.try_withdraw_all(&token, &w),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn stranger_cannot_withdraw_from_funded_vault() {
        let (env, _owner, token, vault_id, vault) = setup();
        let stranger = Address::generate(&env);
        // Only the stranger signs; the owner's auth is missing.
        env.set_auths(&[]);
        let res = vault
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &vault_id,
                    fn_name: "withdraw",
                    args: (&token, &stranger, 1_000_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_withdraw(&token, &stranger, &1_000);
        assert!(res.is_err(), "stranger withdrawal must fail");
        assert_eq!(vault.balance(&token), 1_000);
        assert_eq!(token::Client::new(&env, &token).balance(&stranger), 0);
    }

    #[test]
    fn owner_change_needs_both_and_emits_event() {
        let (env, owner, _token, _id, vault) = setup();
        let new_owner = Address::generate(&env);
        vault.set_owner(&new_owner);
        let auths = env.auths();
        let events = env.events().all();
        assert!(auths.iter().any(|(a, _)| *a == owner));
        assert!(auths.iter().any(|(a, _)| *a == new_owner));
        assert!(!events.events().is_empty());
        assert_eq!(vault.owner(), new_owner);
    }

    #[test]
    fn withdraw_emits_event() {
        let (env, _o, token, _id, vault) = setup();
        vault.withdraw(&token, &Address::generate(&env), &10);
        // SAC transfer event + vault withdraw event
        assert!(env.events().all().events().len() >= 2);
    }

    #[test]
    fn storage_ttl_is_extended() {
        let (env, _o, _t, vault_id, vault) = setup();
        let ttl = env.as_contract(&vault_id, || env.storage().instance().get_ttl());
        assert!(ttl >= TTL_THRESHOLD);
        env.ledger()
            .with_mut(|l| l.sequence_number += TTL_EXTEND_TO - 100);
        vault.bump();
        let ttl2 = env.as_contract(&vault_id, || env.storage().instance().get_ttl());
        assert!(ttl2 >= TTL_THRESHOLD);
    }
}
