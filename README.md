# Payment Vault (Stellar / Soroban)

A simple contract that can receive tokens (like USDC) and lets only the owner move them out.

## Functions
- `__constructor(owner, allowed_tokens)`: runs once at deploy. Rejects the vault's own address as owner (`InvalidOwner`).
- `owner()`: shows who owns the vault
- `balance(token)`: shows how much of a token the vault holds
- `deposit(token, from, amount)`: payer-signed; pulls an **allowlisted** token into the vault (`TokenNotAllowed` otherwise). Plain transfers to the vault address (x402 `payTo`) also work.
- `withdraw(token, to, amount)`: owner only; sends an amount to any address. Works for any token, so stray tokens can be recovered.
- `withdraw_all(token, to)`: owner only; sends everything (fails with `InvalidAmount` if the vault is empty)
- `transfer_ownership(new_owner)`: owner only; the new owner must also sign. (Replaces `set_owner`.)
- `set_token_allowed(token, allowed)`: owner only; edits the deposit allowlist. `is_token_allowed(token)` queries it.
- `extend_ttl()` / `bump()`: anyone can call, no signature needed; renews storage (allowlist included) for 30 days. Needs `--send=yes` in the CLI because it writes no data.

Errors: `InvalidOwner=1`, `NotInitialized=2`, `InvalidAmount=3`, `InsufficientBalance=4`, `TokenNotAllowed=5`.

Events: `deposit` (token, from; amount), `withdraw` (token, to; amount), `owner_set` (owner), `allow` (token; allowed).

`payment_vault.wasm` in this repo is built from this source with Rust 1.98.1 (from `rust-toolchain.toml`) and `stellar contract build` (stellar-cli 28.1.0). SHA-256:

```
0a6825847e7bba03c1fae344b56b302809184c42b7f98d5d5ee4a4e85fd68e47
```

Verify: `stellar contract build && sha256sum target/wasm32v1-none/release/payment_vault.wasm`

## Build and test
```
cargo test
stellar contract build   # needs stellar-cli v25.2.0 or newer
```

## Deploy to testnet (Stellar CLI)
```
stellar contract deploy --wasm target/wasm32v1-none/release/payment_vault.wasm \
  --source <your-key> --network testnet -- --owner <your G... address> \
  --allowed_tokens '["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"]'   # Testnet USDC SAC
```
Use the printed C... address as x402 `payTo`. Before the first x402 payment, send the vault a tiny amount of USDC (e.g. 0.0001): a vault that has never held USDC rejects its first payment with `fee_exceeds_maximum`, whichever facilitator you use.

## Withdraw
```
stellar contract invoke --id <vault C...> --source <owner-key> --network testnet -- \
  withdraw_all --token <USDC contract C...> --to <your G... address>
```

Not audited. Test on testnet before using real money, and keep the owner key safe: losing it locks the funds.

## Repository layout
- `src/lib.rs` — Soroban Payment Vault contract
- `src/test.rs` — unit tests (18)
- `payment_vault.wasm` — Testnet build of the contract
- `x402/` — x402 server config that sends Stellar payments to the vault (`payTo` = vault `C...`, `asset` = USDC SAC). Run: `cd x402 && cp .env.example .env && npm install && npm start` (defaults to testnet)
- `express-server/` — multi-network x402 Express server (EVM, Solana, Algorand, Stellar). Run: `cd express-server && cp .env.example .env && npm install && npm start`
- `demo/setup-trustline.mjs` — one-time payer setup: Friendbot funding, Circle Testnet USDC trustline (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`), and verification of an active 0-balance trustline. Run before `pay.mjs`: `cd demo && npm install && PAYER_SECRET=$(stellar keys show demo-payer) node setup-trustline.mjs` (omit `PAYER_SECRET` to generate a new account). Then fund the payer from Circle's Testnet faucet.
- `demo/pay.mjs` — paying x402 client for the Testnet demo. Run: `cd demo && npm install && PAYER_SECRET=$(stellar keys show demo-payer) node pay.mjs 3` (secret comes from the environment only)
- `docs/MAINNET-CHECKLIST.md` — steps before accepting real payments

## Going live on Mainnet

The x402 server and demo scripts switch to Mainnet with one variable: `STELLAR_NETWORK=mainnet`. On Mainnet the server uses Circle USDC (`CCW67TSZ…MI75`), Horizon/RPC for `pubnet`, and the Built on Stellar / OpenZeppelin facilitator (`https://channels.openzeppelin.com/x402`).

Safety checks at startup (the server refuses to start if any fail):
- `FACILITATOR_API_KEY` is set (generate at https://channels.openzeppelin.com/gen), and the facilitator's `/supported` lists `exact` on `stellar:pubnet`.
- The testnet-only `x402.org` facilitator is rejected on Mainnet.
- `PAY_TO` exists on Mainnet: a `G…` wallet must hold a Circle USDC trustline; a `C…` contract must be deployed.
- Because the vault is unaudited, a `C…` `PAY_TO` on Mainnet also needs `ALLOW_UNAUDITED_VAULT=yes`. Recommended until the audit: pay a `G…` wallet you control.
- `PRICE_UNITS` must be a positive integer at or below `MAX_PRICE_UNITS` (default 1 USDC).

Railway variables for Mainnet:
```
STELLAR_NETWORK=mainnet
PAY_TO=G...your-wallet
FACILITATOR_API_KEY=...
PRICE_UNITS=100000        # 0.01 USDC
```

First real payment (spends real USDC; capped at 10 requests per run):
```
cd demo && npm install
STELLAR_NETWORK=mainnet PAYER_SECRET=S... node setup-trustline.mjs     # once; account needs >= 1.5 XLM
STELLAR_NETWORK=mainnet CONFIRM_MAINNET=yes URL=https://<your-host>/weather PAYER_SECRET=S... node pay.mjs 1
```
Each settled payment is logged by the server as `[paid] … tx=<hash>` with a stellar.expert link. Work through `docs/MAINNET-CHECKLIST.md` before opening to traffic.

## Testnet deployment
Vault: `CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65` ([stellar.expert](https://stellar.expert/explorer/testnet/contract/CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65)), deposit allowlist = Testnet USDC. Storage is renewed weekly with `extend_ttl`.

Previous build (no allowlist): `CCYIVV2DDYTTCJATQDBRJGQRY27E2XK5UT5E2Y2P2OMS53EJR2SMPU7G`, where an end-to-end x402 pay-and-withdraw run passed, including rejection of a non-owner withdrawal.

Status: unaudited. The server can run on Mainnet paying a wallet (`G…`); paying the vault contract on Mainnet requires explicit opt-in until the audit and checklist are complete.

## License
MIT. See `LICENSE`.
