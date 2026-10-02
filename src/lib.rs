#![no_std]
//! Payment Vault — a Soroban contract that receives SEP-41 tokens (e.g. USDC)
//! and only lets the verified owner withdraw them.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, contractevent, panic_with_error, token, Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    InvalidOwner = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InsufficientBalance = 4,
    TokenNotAllowed = 5,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Owner,
    /// Instance-stored so one TTL bump covers the whole allowlist.
    Allowed(Address),
}

const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const LIFETIME_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contractevent(topics = ["deposit"], data_format = "single-value")]
pub struct Deposit {
    #[topic]
    pub token: Address,
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["withdraw"], data_format = "single-value")]
pub struct Withdraw {
    #[topic]
    pub token: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["owner_set"], data_format = "single-value")]
pub struct OwnerSet {
    pub owner: Address,
}

#[contractevent(topics = ["allow"], data_format = "single-value")]
pub struct TokenAllowed {
    #[topic]
    pub token: Address,
    pub allowed: bool,
}

#[contract]
pub struct PaymentVault;

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn is_allowed(env: &Env, token: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Allowed(token.clone()))
        .unwrap_or(false)
}

fn read_owner(env: &Env) -> Result<Address, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Owner)
        .ok_or(VaultError::NotInitialized)
}

#[contractimpl]
impl PaymentVault {
    /// Constructor: runs once, atomically, at deploy time — no front-running.
    /// `allowed_tokens`: token contracts accepted by `deposit` (e.g. the USDC SAC).
    pub fn __constructor(env: Env, owner: Address, allowed_tokens: Vec<Address>) {
        // Fix 3: the vault can never sign for itself, so this owner would lock funds forever.
        if owner == env.current_contract_address() {
            panic_with_error!(&env, VaultError::InvalidOwner);
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        for t in allowed_tokens.iter() {
            env.storage().instance().set(&DataKey::Allowed(t), &true);
        }
        bump(&env);
        OwnerSet { owner }.publish(&env);
    }

    /// Pull `amount` of `token` from `from` into the vault (requires `from` auth).
    /// Plain transfers straight to the contract address also work; this just
    /// adds a deposit event for indexers / x402 receipts.
    pub fn deposit(env: Env, token: Address, from: Address, amount: i128) -> Result<(), VaultError> {
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        read_owner(&env)?;
        // Fix 1: only allowlisted tokens, so a fake token can't mint fake deposit events.
        if !is_allowed(&env, &token) {
            return Err(VaultError::TokenNotAllowed);
        }
        from.require_auth();
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        bump(&env);
        Deposit { token, from, amount }.publish(&env);
        Ok(())
    }

    /// Owner-only: send `amount` of `token` to `to`.
    pub fn withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<(), VaultError> {
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let owner = read_owner(&env)?;
        owner.require_auth();
        let client = token::Client::new(&env, &token);
        let vault = env.current_contract_address();
        if client.balance(&vault) < amount {
            return Err(VaultError::InsufficientBalance);
        }
        client.transfer(&vault, &to, &amount);
        bump(&env);
        Withdraw { token, to, amount }.publish(&env);
        Ok(())
    }

    /// Owner-only: send the vault's entire `token` balance to `to`. Returns the amount.
    pub fn withdraw_all(env: Env, token: Address, to: Address) -> Result<i128, VaultError> {
        let owner = read_owner(&env)?;
        owner.require_auth();
        let client = token::Client::new(&env, &token);
        let vault = env.current_contract_address();
        let amount = client.balance(&vault);
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        client.transfer(&vault, &to, &amount);
        bump(&env);
        Withdraw { token, to, amount }.publish(&env);
        Ok(amount)
    }

    /// Owner-only: hand ownership to `new_owner` (both must sign).
    pub fn transfer_ownership(env: Env, new_owner: Address) -> Result<(), VaultError> {
        let owner = read_owner(&env)?;
        owner.require_auth();
        new_owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &new_owner);
        bump(&env);
        OwnerSet { owner: new_owner }.publish(&env);
        Ok(())
    }

    /// Owner-only: add or remove a token from the deposit allowlist.
    /// (Withdraw is intentionally NOT restricted, so the owner can rescue any token sent directly.)
    pub fn set_token_allowed(env: Env, token: Address, allowed: bool) -> Result<(), VaultError> {
        let owner = read_owner(&env)?;
        owner.require_auth();
        if allowed {
            env.storage().instance().set(&DataKey::Allowed(token.clone()), &true);
        } else {
            env.storage().instance().remove(&DataKey::Allowed(token.clone()));
        }
        bump(&env);
        TokenAllowed { token, allowed }.publish(&env);
        Ok(())
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        is_allowed(&env, &token)
    }

    /// Fix 4: permissionless keep-alive. Anyone (e.g. a cron job) can extend the
    /// vault's instance + code TTL so it never gets archived while idle.
    pub fn extend_ttl(env: Env) {
        bump(&env);
    }

    /// Alias of `extend_ttl`, kept for scripts written against the previous build.
    pub fn bump(env: Env) {
        bump(&env);
    }

    pub fn owner(env: Env) -> Result<Address, VaultError> {
        read_owner(&env)
    }

    pub fn balance(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }
}

#[cfg(test)]
mod test;
