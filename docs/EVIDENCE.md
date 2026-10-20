# Payment Vault: Evidence Pack

Everything below can be checked independently on Stellar Testnet. Last updated 2026-10-20.

## What it is

An x402 pay-per-request API on Stellar whose payments settle directly into a Soroban vault contract. The contract allowlists deposit tokens, allows withdrawals only with the owner's signature, and lets any account renew its storage TTL without being able to move funds.

```
client (agent / app) ──HTTP──▶ x402 server ──verify/settle──▶ facilitator (fee payer)
                                   │                                │
                                   │ 402 → signed USDC auth          │ submits tx
                                   ▼                                ▼
                         USDC Stellar Asset Contract ──transfer──▶ Payment Vault (Soroban)
                                                                  owner-only withdraw
```

## Links

| Item | Value |
|---|---|
| Live demo | https://payment-vault-production-38e9.up.railway.app |
| Source | https://github.com/collins2643/payment-vault (MIT) |
| Vault contract (Testnet) | [`CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65`](https://stellar.expert/explorer/testnet/contract/CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65) |
| WASM SHA-256 | `0a6825847e7bba03c1fae344b56b302809184c42b7f98d5d5ee4a4e85fd68e47` |
| Owner | [`GCNFTFXLRJOBXPNTCMQNGIZ5QRAOMCPBXFN55UMBFQX7JT6272GRDPYL`](https://stellar.expert/explorer/testnet/account/GCNFTFXLRJOBXPNTCMQNGIZ5QRAOMCPBXFN55UMBFQX7JT6272GRDPYL) |
| Accepted asset | Circle Testnet USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Price | 0.001 USDC (10,000 units) per `GET /weather` |

## On-chain record

| Date (UTC) | Event | Transaction |
|---|---|---|
| 2026-10-20 | x402 payment via the demo button, 0.001 USDC into the vault (local server + self-hosted facilitator) | [2b5f9c17…f7a659](https://stellar.expert/explorer/testnet/tx/2b5f9c1773c1ac8a0d76fc8885f8d2dca08b9be52c22d8aa217f837cfaf7a659) |
| 2026-10-20 | x402 payment via the demo button, 0.001 USDC; vault 1,020,000 → 1,030,000 units; fee 291,559 stroops paid by the facilitator | [0b3618a7…968534](https://stellar.expert/explorer/testnet/tx/0b3618a7641dc1566f7fb8f7c1262ecd8f0eebb2faa760d8b4d6930511968534) |
| 2026-10-20 | **Rejected:** a non-owner account submitted `withdraw`; the transaction fails because the owner's authorization is missing | [25be1ef0…3d01f2](https://stellar.expert/explorer/testnet/tx/25be1ef0412665ff4ca02b08f973c87accaf68f14680e085b325572bd03d01f2) |
| 2026-10-19 | Weekly keep-alive `extend_ttl` from a separate account | [1115bf08…aa2755](https://stellar.expert/explorer/testnet/tx/1115bf08cb1062b4ba83acbdc1b54d8d037e2fe1a7abf42f5a514bebcdaa2755) |
| 2026-10-12 | Weekly keep-alive | [6ba2503b…468792](https://stellar.expert/explorer/testnet/tx/6ba2503bc4b76a45ad7cccdd64b02ed1ec8d6b226a08c7d8f2eab582ad468792) |
| 2026-10-09 | First x402 payment into the vault, 0.001 USDC (self-hosted facilitator) | [7c7ef7de…62ff5e](https://stellar.expert/explorer/testnet/tx/7c7ef7de7c88847c4972facffebe7c3a6ba9263de62f761bbd7067860762ff5e) |
| 2026-10-05 | Weekly keep-alive | [4789d70d…41554c](https://stellar.expert/explorer/testnet/tx/4789d70d1e6e51453c82b4c5f51cc1aaf74022a4fb9d55477c413e425541554c) |
| 2026-10-03 | Owner-signed withdrawal | [f5721f59…fcdfa8](https://stellar.expert/explorer/testnet/tx/f5721f59260f558eb1035cd94d22311a1e8ef1f3b4148eb340a35debeefcdfa8) |
| 2026-10-03 | Deposit into the vault | [ee78a2c4…c34913](https://stellar.expert/explorer/testnet/tx/ee78a2c4e0946b93a12bcb93885339a0e6985f273f9b0fc5e68320e28fc34913) |

Hosted settlement on the public Railway URL: **pending** until the `x402-facilitator` service is deployed there. Add the first hosted transaction here when it lands.

## Tests

```
cargo test        # 18 passed, 0 failed (soroban-sdk 28)
```

Covers: owner-only `withdraw` / `withdraw_all` / `set_token_allowed`, deposit allowlist (`TokenNotAllowed`), constructor rejecting the vault as its own owner, two-party `transfer_ownership`, permissionless `extend_ttl`, and recovery of non-allowlisted tokens.

## Operations

- Weekly storage keep-alive runs every Monday from a dedicated account with no withdrawal rights.
- The owner key is kept off all servers. The demo button pays from a separate, low-balance Testnet wallet and is rate-limited.
- Facilitator fee ceiling: 1,000,000 stroops. Vault payments cost more than wallet payments because they write contract storage, which is why the public x402.org facilitator (50,000-stroop cap) cannot settle them.

## Known limits

- Testnet only. The contract has not been audited; a Mainnet release waits for an audit (planned through the Soroban Audit Bank).
- Mainnet configuration (OpenZeppelin facilitator, startup safety checks) is proposed in PR #6 and not merged.
- Traction so far is the author's own test payments; outside users are the next milestone.
