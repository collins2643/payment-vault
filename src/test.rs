#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, IntoVal, Symbol,
};
use soroban_sdk::{
    contract as test_contract, contractimpl as test_contractimpl,
    testutils::{storage::Instance as _, Ledger as _},
};

struct Setup<'a> {
    env: Env,
    owner: Address,
    payer: Address,
    vault: PaymentVaultClient<'a>,
    usdc: TokenClient<'a>,
    usdc_admin: StellarAssetClient<'a>,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let usdc = TokenClient::new(&env, &sac.address());
    let usdc_admin = StellarAssetClient::new(&env, &sac.address());
    usdc_admin.mint(&payer, &1_000_0000000);
    let id = env.register(PaymentVault, (owner.clone(), vec![&env, sac.address()]));
    let vault = PaymentVaultClient::new(&env, &id);
    Setup { env, owner, payer, vault, usdc, usdc_admin }
}

#[test]
fn constructor_sets_owner() {
    let s = setup();
    assert_eq!(s.vault.owner(), s.owner);
    assert_eq!(s.vault.balance(&s.usdc.address), 0);
}

#[test]
fn deposit_moves_tokens_and_requires_payer_auth() {
    let s = setup();
    s.vault.deposit(&s.usdc.address, &s.payer, &250_0000000);
    assert_eq!(
        s.env.auths()[0],
        (
            s.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.vault.address.clone(),
                    Symbol::new(&s.env, "deposit"),
                    (s.usdc.address.clone(), s.payer.clone(), 250_0000000_i128).into_val(&s.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        s.usdc.address.clone(),
                        Symbol::new(&s.env, "transfer"),
                        (s.payer.clone(), s.vault.address.clone(), 250_0000000_i128).into_val(&s.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )
    );
    assert_eq!(s.vault.balance(&s.usdc.address), 250_0000000);
    assert_eq!(s.usdc.balance(&s.payer), 750_0000000);
}

#[test]
fn direct_transfer_counts_toward_balance() {
    let s = setup();
    s.usdc.transfer(&s.payer, &s.vault.address, &10_0000000);
    assert_eq!(s.vault.balance(&s.usdc.address), 10_0000000);
}

#[test]
fn owner_can_withdraw() {
    let s = setup();
    let dest = Address::generate(&s.env);
    s.vault.deposit(&s.usdc.address, &s.payer, &100_0000000);
    s.vault.withdraw(&s.usdc.address, &dest, &40_0000000);
    assert_eq!(s.env.auths()[0].0, s.owner);
    assert_eq!(s.usdc.balance(&dest), 40_0000000);
    assert_eq!(s.vault.balance(&s.usdc.address), 60_0000000);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn non_owner_cannot_withdraw() {
    let s = setup();
    s.vault.deposit(&s.usdc.address, &s.payer, &100_0000000);
    let attacker = Address::generate(&s.env);
    // Only the attacker signs; owner auth is missing.
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "withdraw",
            args: (s.usdc.address.clone(), attacker.clone(), 100_0000000_i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.withdraw(&s.usdc.address, &attacker, &100_0000000);
}

#[test]
fn withdraw_rejects_bad_amounts() {
    let s = setup();
    let dest = Address::generate(&s.env);
    s.vault.deposit(&s.usdc.address, &s.payer, &5);
    assert_eq!(s.vault.try_withdraw(&s.usdc.address, &dest, &0), Err(Ok(VaultError::InvalidAmount)));
    assert_eq!(s.vault.try_withdraw(&s.usdc.address, &dest, &-1), Err(Ok(VaultError::InvalidAmount)));
    assert_eq!(s.vault.try_withdraw(&s.usdc.address, &dest, &6), Err(Ok(VaultError::InsufficientBalance)));
    assert_eq!(s.vault.try_deposit(&s.usdc.address, &s.payer, &0), Err(Ok(VaultError::InvalidAmount)));
}

#[test]
fn supports_multiple_tokens() {
    let s = setup();
    let other = s.env.register_stellar_asset_contract_v2(Address::generate(&s.env));
    s.vault.set_token_allowed(&other.address(), &true);
    StellarAssetClient::new(&s.env, &other.address()).mint(&s.payer, &77);
    s.vault.deposit(&other.address(), &s.payer, &77);
    s.vault.deposit(&s.usdc.address, &s.payer, &1);
    assert_eq!(s.vault.balance(&other.address()), 77);
    assert_eq!(s.vault.balance(&s.usdc.address), 1);
    let _ = &s.usdc_admin;
}

#[test]
fn ownership_transfer_moves_withdraw_rights() {
    let s = setup();
    let new_owner = Address::generate(&s.env);
    s.vault.transfer_ownership(&new_owner);
    let auths = s.env.auths();
    assert!(auths.iter().any(|a| a.0 == s.owner));
    assert!(auths.iter().any(|a| a.0 == new_owner));
    assert_eq!(s.vault.owner(), new_owner);

    s.vault.deposit(&s.usdc.address, &s.payer, &10);
    s.vault.withdraw(&s.usdc.address, &new_owner, &10);
    assert_eq!(s.env.auths()[0].0, new_owner);
}

#[test]
fn emits_events() {
    let s = setup();
    s.vault.deposit(&s.usdc.address, &s.payer, &3);
    assert!(!s.env.events().all().events().is_empty());
}

// ---------- Fix 1: token allowlist ----------

/// A malicious "token" whose transfer silently does nothing.
#[test_contract]
pub struct FakeToken;
#[test_contractimpl]
impl FakeToken {
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
    pub fn balance(_env: Env, _id: Address) -> i128 { 1_000_000_0000000 }
}

#[test]
fn fake_token_deposit_rejected() {
    let s = setup();
    let fake = s.env.register(FakeToken, ());
    assert_eq!(
        s.vault.try_deposit(&fake, &s.payer, &100),
        Err(Ok(VaultError::TokenNotAllowed))
    );
    assert!(!s.vault.is_token_allowed(&fake));
}

#[test]
fn unlisted_real_token_rejected_until_allowed_then_removed() {
    let s = setup();
    let other = s.env.register_stellar_asset_contract_v2(Address::generate(&s.env)).address();
    StellarAssetClient::new(&s.env, &other).mint(&s.payer, &50);
    assert_eq!(s.vault.try_deposit(&other, &s.payer, &10), Err(Ok(VaultError::TokenNotAllowed)));
    s.vault.set_token_allowed(&other, &true);
    assert_eq!(s.env.auths()[0].0, s.owner);
    s.vault.deposit(&other, &s.payer, &10);
    s.vault.set_token_allowed(&other, &false);
    assert_eq!(s.vault.try_deposit(&other, &s.payer, &10), Err(Ok(VaultError::TokenNotAllowed)));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn non_owner_cannot_change_allowlist() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    let fake = s.env.register(FakeToken, ());
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "set_token_allowed",
            args: (fake.clone(), true).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.set_token_allowed(&fake, &true);
}

#[test]
fn owner_can_rescue_unlisted_token_sent_directly() {
    let s = setup();
    let other = s.env.register_stellar_asset_contract_v2(Address::generate(&s.env)).address();
    let oc = StellarAssetClient::new(&s.env, &other);
    oc.mint(&s.vault.address, &30);
    s.vault.withdraw(&other, &s.owner, &30);
    assert_eq!(TokenClient::new(&s.env, &other).balance(&s.owner), 30);
}

// ---------- Fix 3: owner validation ----------

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_vault_as_owner() {
    let env = Env::default();
    let id = Address::generate(&env);
    // Pre-pick the contract id so the owner equals the vault address.
    env.register_at(&id, PaymentVault, (id.clone(), Vec::<Address>::new(&env)));
}

// ---------- Fix 4: permissionless TTL extension ----------

#[test]
fn anyone_can_extend_ttl_without_auth() {
    let s = setup();
    s.env.set_auths(&[]); // no signatures at all
    // Let the TTL decay well below the threshold.
    s.env.ledger().with_mut(|l| l.sequence_number += 20 * DAY_IN_LEDGERS);
    let before = s.env.as_contract(&s.vault.address, || s.env.storage().instance().get_ttl());
    assert!(before < LIFETIME_THRESHOLD);
    s.vault.extend_ttl();
    assert!(s.env.auths().is_empty());
    let after = s.env.as_contract(&s.vault.address, || s.env.storage().instance().get_ttl());
    assert_eq!(after, BUMP_AMOUNT);
}

#[test]
fn withdraw_all_empties_vault_and_rejects_empty() {
    let s = setup();
    let dest = Address::generate(&s.env);
    s.vault.deposit(&s.usdc.address, &s.payer, &42);
    assert_eq!(s.vault.withdraw_all(&s.usdc.address, &dest), 42);
    assert_eq!(s.env.auths()[0].0, s.owner);
    assert_eq!(s.usdc.balance(&dest), 42);
    assert_eq!(s.vault.try_withdraw_all(&s.usdc.address, &dest), Err(Ok(VaultError::InvalidAmount)));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn non_owner_cannot_withdraw_all() {
    let s = setup();
    s.vault.deposit(&s.usdc.address, &s.payer, &42);
    let attacker = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "withdraw_all",
            args: (s.usdc.address.clone(), attacker.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.withdraw_all(&s.usdc.address, &attacker);
}

#[test]
fn bump_alias_extends_ttl() {
    let s = setup();
    s.env.set_auths(&[]);
    s.env.ledger().with_mut(|l| l.sequence_number += 20 * DAY_IN_LEDGERS);
    s.vault.bump();
    let ttl = s.env.as_contract(&s.vault.address, || s.env.storage().instance().get_ttl());
    assert_eq!(ttl, BUMP_AMOUNT);
}
