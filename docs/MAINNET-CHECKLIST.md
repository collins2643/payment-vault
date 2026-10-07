# Mainnet Deployment Checklist

Scope: moving the x402 Express server and Soroban Payment Vault from testnet to Stellar mainnet (`stellar:pubnet`), plus the other chains if enabled. Check every box before accepting real payments.

## 1. Contract readiness
- [ ] Independent security audit of the Payment Vault contract completed and findings fixed.
- [ ] Final WASM rebuilt from the audited source; record its hash (testnet build: `19b4a5da…b870`) and confirm the deployed hash matches.
- [ ] Unit tests pass on the audited build (withdraw, withdraw_all, transfer_ownership, token allowlist, unauthorized rejection, invalid/excess amounts, TTL extension).
- [ ] Testnet pay-then-withdraw run (`scripts/e2e-pay-withdraw.mjs`) passes on the exact audited WASM.

## 2. Owner and keys
- [ ] Mainnet owner is a wallet you control (hardware wallet or multisig preferred), **not** a test key generated in a sandbox.
- [ ] Owner secret never stored on the server, in `.env`, in git, or in chat. The server only needs the vault's `C…` address.
- [ ] Recovery plan written down: who can call `set_owner`, and how (requires both current and new owner signatures).
- [ ] Owner account funded with enough XLM for reserves and Soroban fees (withdrawals, TTL extensions).

## 3. Deploy the vault
- [ ] Deploy with `__constructor(owner = <mainnet owner G…>, allowed_tokens = [<mainnet USDC SAC>])` on `stellar:pubnet`.
- [ ] Verify on-chain: `owner()` returns the intended address, and the contract's WASM hash matches the audited build.
- [ ] Extend instance and code TTL so the contract doesn't get archived; set a reminder to renew.
- [ ] Seed the vault with a tiny USDC transfer (e.g. 0.0001) **before** the first x402 payment; otherwise settlement fails with `invalid_exact_stellar_payload_fee_exceeds_maximum`.

## 4. Assets and addresses
- [ ] Mainnet USDC SAC: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (Circle issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`). Never the testnet `CBIELTK6…`.
- [ ] Withdrawal destination wallet has a USDC trustline, and the issuer starts with `GA5ZSEJY`.
- [ ] `PAY_TO` = vault `C…` address (or a `G…` wallet); startup check confirms a contract exists there (or the wallet has a Circle USDC trustline) and it isn't the USDC contract itself. Paying a `C…` vault on mainnet also requires `ALLOW_UNAUDITED_VAULT=yes` until the audit is done.
- [ ] Double-check every address by pasting it into a block explorer (stellar.expert) rather than retyping.

## 5. Facilitator
- [ ] Pick a facilitator that lists `exact` / `stellar:pubnet` in its `/supported` response (the public `x402.org/facilitator` is testnet-only). Default: Built on Stellar / OpenZeppelin, `https://channels.openzeppelin.com/x402`. The server checks `/supported` at startup and refuses to run if mainnet isn't listed.
- [ ] API key from https://channels.openzeppelin.com/gen stored as the host secret `FACILITATOR_API_KEY`, not in the repo.
- [ ] Confirm it sponsors fees (`areFeesSponsored: true`) or budget for payer fees.
- [ ] Understand its limits: max fee cap, rate limits, uptime/SLA, settlement latency.

## 6. Server configuration
- [ ] `.env` on the host:
  - `STELLAR_NETWORK=mainnet` (also accepts `pubnet` / `stellar:pubnet`)
  - `PAY_TO=<wallet G… or vault C… address>`
  - `FACILITATOR_URL=https://channels.openzeppelin.com/x402` (default on mainnet)
  - `FACILITATOR_API_KEY=<key>`
  - `PRICE_UNITS=<raw units>`; startup refuses prices above `MAX_PRICE_UNITS` (default 1 USDC)
  - Mainnet IDs for any other enabled chain (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`), or leave their `*_PAY_TO` blank to disable them.
- [ ] Prices reviewed in real dollars (Stellar USDC has 7 decimals: `$0.001` = 10000 units).
- [ ] All `@x402/*` packages pinned to the same version (currently 2.27.0); lockfile committed.
- [ ] HTTPS only, behind a proxy with request logging; `PORT` taken from the host.
- [ ] Handlers idempotent: settlement runs after a successful (<400) response, so failed settlements must not double-deliver or double-charge.

## 7. Monitoring and operations
- [ ] Log every `PAYMENT-RESPONSE` transaction hash with the request ID. (The x402 server prints a `[paid] … tx=…` line with a stellar.expert link for each settlement.)
- [ ] Alert on 402 error spikes, facilitator errors, and settlement failures.
- [ ] Daily reconciliation: sum of settled payments vs. vault USDC `balance()`.
- [ ] Withdrawal schedule set (e.g. weekly `withdraw_all` to the owner/treasury wallet) to limit funds held in the contract.
- [ ] Incident plan: how to pause (disable `STELLAR_PAY_TO`/stop server) and move funds out if a bug is found.

## 8. Go-live
- [ ] Single real payment at the lowest price; verify it on stellar.expert and in the vault balance.
- [ ] Small real withdrawal to the destination wallet; verify arrival.
- [ ] Then open to traffic, and watch monitoring closely for the first 24 hours.
