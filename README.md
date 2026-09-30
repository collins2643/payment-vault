# Payment Vault (Stellar / Soroban)

A simple contract that can receive tokens (like USDC) and lets only the owner move them out.

## Functions
- `owner()`: shows who owns the vault
- `balance(token)`: shows how much of a token the vault holds
- `withdraw(token, to, amount)`: owner only; sends an amount to any address
- `withdraw_all(token, to)`: owner only; sends everything (fails with `InvalidAmount` if the vault is empty)
- `bump()`: anyone can call; renews the vault's storage so it isn't archived. Owner actions renew it automatically.

Events: `withdraw` (token, to, amount) and `owner_changed` (old_owner, new_owner).

Note: `payment_vault.wasm` in this repo was built from the previous version. Rebuild with `stellar contract build` (stellar-cli v25.2.0+) for these changes.
- `set_owner(new_owner)`: owner only; hands over control (the new owner must also sign)

## Build and test
```
cargo test
stellar contract build   # needs stellar-cli v25.2.0 or newer
```

## Deploy to testnet (Stellar CLI)
```
stellar contract deploy --wasm target/wasm32v1-none/release/payment_vault.wasm \
  --source <your-key> --network testnet -- --owner <your G... address>
```
Use the printed C... address as x402 `payTo`. Before the first x402 payment, send the vault a tiny amount of USDC (e.g. 0.0001): a vault that has never held USDC rejects its first payment with `fee_exceeds_maximum`, whichever facilitator you use.

## Withdraw
```
stellar contract invoke --id <vault C...> --source <owner-key> --network testnet -- \
  withdraw_all --token <USDC contract C...> --to <your G... address>
```

Not audited. Test on testnet before using real money, and keep the owner key safe: losing it locks the funds.

## Repository layout
- `src/lib.rs` — Soroban Payment Vault contract (with unit tests)
- `payment_vault.wasm` — Testnet build of the contract
- `x402/` — x402 server config that sends Stellar payments to the vault (`payTo` = vault `C...`, `asset` = USDC SAC). Run: `cd x402 && cp .env.example .env && npm install && npm start` (defaults to testnet)
- `express-server/` — multi-network x402 Express server (EVM, Solana, Algorand, Stellar). Run: `cd express-server && cp .env.example .env && npm install && npm start`
- `demo/pay.mjs` — paying x402 client for the Testnet demo. Run: `cd demo && npm install && PAYER_SECRET=$(stellar keys show demo-payer) node pay.mjs 3` (secret comes from the environment only)
- `docs/MAINNET-CHECKLIST.md` — steps before accepting real payments

## Testnet deployment
Vault: `CCYIVV2DDYTTCJATQDBRJGQRY27E2XK5UT5E2Y2P2OMS53EJR2SMPU7G` ([stellar.expert](https://stellar.expert/explorer/testnet/contract/CCYIVV2DDYTTCJATQDBRJGQRY27E2XK5UT5E2Y2P2OMS53EJR2SMPU7G)). An end-to-end x402 pay-and-withdraw run passed, including rejection of a non-owner withdrawal.

Status: unaudited. Do not use on mainnet until the checklist is complete.

## License
MIT. See `LICENSE`.
