# Wheat Cent Valuation API

Paid x402 routes for 1909–1958 Lincoln wheat cents, served by the same Express server as `/weather`. Payments go to `PAY_TO` (the Payment Vault) in USDC, like the other routes.

| Route | Price | Returns |
|---|---|---|
| `GET /coins` | free | Catalog: routes, prices, parameters |
| `GET /coins/melt` | 0.001 USDC | Copper melt value per coin, per lb, and per lot from live copper spot |
| `GET /coins/bulk` | 0.001 USDC | Bulk price observations by channel, medians, and spread vs. melt |
| `GET /coins/keydates` | 0.002 USDC | Fine-12 history since 1958, grade ladder, CAGR (1909-S VDB, 1914-D, 1931-S, 1909-S, 1922 No D, 1955 DDO) |
| `GET /coins/scenario` | 0.005 USDC | Bulk and key-date projections: custom inputs plus boom / base / liquidation presets |

Prices are set with `COIN_PRICE_*` env vars (see `.env.example`).

## Parameters

- `/coins/melt`: `spot` (USD/lb override), `coins` or `lb`, `steelPct` (share of 1943 steel cents)
- `/coins/bulk`: `spot`, `channel` = `dealer|auction|wholesale|retail`
- `/coins/keydates`: `id` (e.g. `1909-s-vdb`), `spot`
- `/coins/scenario`: `preset` = `boom|base|liquidation`, `years` (1–25), `copperPct`, `demandPct`, `liquidationPct`, `haltPct`, `attritionPct`, `bulkCents`, `holdings`, `spot`

Invalid input returns 400. `@x402/express` cancels settlement for any response >= 400, so rejected requests are not charged.

## Data

- Copper: live from `COPPER_PRICE_URL` (default gold-api.com, 60 s cache). Falls back to the last cached value, then to $6.55/lb (2026-10-30 close). Every response reports `copper.source` (`live`, `cached`, `fallback`, or `caller`).
- Bulk and key-date figures are dated snapshots in `data.ts` (`DATA_AS_OF`). The two dealer rows are owner-supplied estimates and are flagged `estimate: true`.
- Melt value is a reference floor only. Melting or exporting U.S. cents is prohibited by 31 CFR Part 82.

## Try it

```bash
cd x402 && npm test                                   # model + handler tests
curl localhost:4021/coins                             # free catalog
curl -i localhost:4021/coins/melt?coins=5000          # 402 with payment terms
URL="http://localhost:4021/coins/melt?coins=5000" PAYER_SECRET=... node ../demo/pay.mjs 1   # paid Testnet request
```
