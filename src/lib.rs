#![no_std]
//! Payment Vault: a simple contract that can receive tokens (like USDC)
//! and lets ONLY the owner withdraw them to any wallet.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

#[contracttype]
enum DataKey {
    Owner,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    InvalidAmount = 2,
    InsufficientBalance = 3,
}

#[contract]
pub struct PaymentVault;

#[contractimpl]
impl PaymentVault {
    /// Runs once at deploy time and sets who owns the vault.
    pub fn __constructor(env: Env, owner: Address) {
        env.storage().instance().set(&DataKey::Owner, &owner);
    }

    /// Who owns the vault.
    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    /// How much of a token the vault holds.
    pub fn balance(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Owner-only: send `amount` of `token` from the vault to `to`.
    pub fn withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<(), Error> {
        let owner = Self::owner(env.clone());
        owner.require_auth(); // only the owner can do this
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let client = token::Client::new(&env, &token);
        let me = env.current_contract_address();
        if client.balance(&me) < amount {
            return Err(Error::InsufficientBalance);
        }
        client.transfer(&me, &to, &amount);
        Ok(())
    }

    /// Owner-only: send the vault's entire balance of `token` to `to`.
    pub fn withdraw_all(env: Env, token: Address, to: Address) -> i128 {
        let owner = Self::owner(env.clone());
        owner.require_auth();
        let client = token::Client::new(&env, &token);
        let me = env.current_contract_address();
        let bal = client.balance(&me);
        if bal > 0 {
            client.transfer(&me, &to, &bal);
        }
        bal
    }

    /// Owner-only: hand the vault to a new owner (both must approve).
    pub fn set_owner(env: Env, new_owner: Address) {
        let owner = Self::owner(env.clone());
        owner.require_auth();
        new_owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &new_owner);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Env};

    fn setup() -> (Env, Address, Address, PaymentVaultClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin).address();
        let vault_id = env.register(PaymentVault, (owner.clone(),));
        let vault = PaymentVaultClient::new(&env, &vault_id);
        StellarAssetClient::new(&env, &token).mint(&vault_id, &1_000);
        (env, owner, token, vault)
    }

    #[test]
    fn owner_can_withdraw() {
        let (env, _owner, token, vault) = setup();
        let wallet = Address::generate(&env);
        vault.withdraw(&token, &wallet, &400);
        assert_eq!(token::Client::new(&env, &token).balance(&wallet), 400);
        assert_eq!(vault.balance(&token), 600);
        assert_eq!(vault.withdraw_all(&token, &wallet), 600);
        assert_eq!(vault.balance(&token), 0);
    }

    #[test]
    fn rejects_bad_amounts() {
        let (env, _o, token, vault) = setup();
        let w = Address::generate(&env);
        assert_eq!(vault.try_withdraw(&token, &w, &0), Err(Ok(Error::InvalidAmount)));
        assert_eq!(vault.try_withdraw(&token, &w, &5_000), Err(Ok(Error::InsufficientBalance)));
    }

    #[test]
    #[should_panic]
    fn stranger_cannot_withdraw() {
        let env = Env::default(); // no mocked auth
        let owner = Address::generate(&env);
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin).address();
        let vault_id = env.register(PaymentVault, (owner,));
        let vault = PaymentVaultClient::new(&env, &vault_id);
        vault.withdraw(&token, &Address::generate(&env), &1);
    }
}
