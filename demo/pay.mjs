// demo/pay.mjs — makes N paid x402 requests to the vault-backed server (Stellar Testnet).
// Usage: PAYER_SECRET=$(stellar keys show demo-payer) node demo/pay.mjs 3
// The secret is read from the environment only; never commit it.
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

if (!process.env.PAYER_SECRET) {
  console.error("Set PAYER_SECRET to a funded Testnet secret key (S...).");
  process.exit(1);
}

const signer = createEd25519Signer(process.env.PAYER_SECRET, "stellar:testnet");
const client = new x402Client().register("stellar:testnet", new ExactStellarScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

const url = process.env.URL ?? "http://localhost:4021/weather";
const n = Number(process.argv[2] ?? 3);
for (let i = 1; i <= n; i++) {
  const r = await pay(url);
  console.log(`request ${i}: HTTP ${r.status}`, await r.text());
}
