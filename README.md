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

### Facilitator fee limit
A USDC payment into the vault costs about 140,000 stroops (0.014 XLM) in network fees, versus about 24,000 to a regular `G...` wallet, because it writes contract storage. The public `x402.org` facilitator caps fees at 50,000 stroops, so it rejects vault payments with `fee_exceeds_maximum` even after the vault already holds USDC (observed on Testnet, 2026-10-09). Use the self-hosted facilitator instead:

```
cd x402 && npm install
npm run facilitator                                   # terminal 1: :4022, testnet, throwaway fee payer
FACILITATOR_URL=http://localhost:4022 npm start       # terminal 2: :4021, payTo = vault
cd ../demo && PAYER_SECRET=... node pay.mjs 1         # terminal 3
node balance.mjs                                      # vault USDC balance went up by 10000 units
```

The facilitator pays settlement fees from its own account. Set `FACILITATOR_API_KEY` (same value on both services) whenever it is reachable from the internet, or anyone can spend its XLM. See `x402/.env.facilitator.example`.

Verified run: 0.001 USDC settled to vault `CDGZ…PNJ65` in [7c7ef7de…62ff5e](https://stellar.expert/explorer/testnet/tx/7c7ef7de7c88847c4972facffebe7c3a6ba9263de62f761bbd7067860762ff5e) (fee 125,301 stroops); vault balance 1,000,000 → 1,010,000 units.

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
- `x402/facilitator.ts` — self-hosted x402 facilitator (verify + settle) with a configurable fee ceiling for vault payments. Run: `cd x402 && npm run facilitator`
- `demo/balance.mjs` — read-only check of the vault's USDC balance and owner. Run: `cd demo && node balance.mjs [vault C...]`
- `demo/pay.mjs` — paying x402 client for the Testnet demo. Run: `cd demo && npm install && PAYER_SECRET=$(stellar keys show demo-payer) node pay.mjs 3` (secret comes from the environment only)
- `docs/MAINNET-CHECKLIST.md` — steps before accepting real payments

## Testnet deployment
Vault: `CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65` ([stellar.expert](https://stellar.expert/explorer/testnet/contract/CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65)), deposit allowlist = Testnet USDC. Storage is renewed weekly with `extend_ttl`.

Previous build (no allowlist): `CCYIVV2DDYTTCJATQDBRJGQRY27E2XK5UT5E2Y2P2OMS53EJR2SMPU7G`, where an end-to-end x402 pay-and-withdraw run passed, including rejection of a non-owner withdrawal.

Status: unaudited. Do not use on mainnet until the checklist is complete.

## License
MIT. See `LICENSE`.
