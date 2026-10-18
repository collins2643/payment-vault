// demo/pay.mjs — makes N paid x402 requests to the vault-backed server.
// Testnet (default):
//   PAYER_SECRET=$(stellar keys show demo-payer) node pay.mjs 3
// Mainnet (real USDC; capped at 10 requests per run):
//   STELLAR_NETWORK=mainnet CONFIRM_MAINNET=yes URL=https://your-host/weather \
//   PAYER_SECRET=S... node pay.mjs 1
// The secret is read from the environment only; never commit it.
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

const raw = (process.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
const MAINNET = ["mainnet", "pubnet", "public", "stellar:pubnet"].includes(raw);
if (!MAINNET && !["testnet", "stellar:testnet", ""].includes(raw)) {
  console.error(`Unknown STELLAR_NETWORK "${process.env.STELLAR_NETWORK}". Use "testnet" or "mainnet".`);
  process.exit(1);
}
const NETWORK = MAINNET ? "stellar:pubnet" : "stellar:testnet";
const EXPLORER = `https://stellar.expert/explorer/${MAINNET ? "public" : "testnet"}`;

if (!process.env.PAYER_SECRET) {
  console.error(`Set PAYER_SECRET to a funded ${MAINNET ? "Mainnet" : "Testnet"} secret key (S...) with a USDC trustline.`);
  process.exit(1);
}

const url = process.env.URL ?? "http://localhost:4021/weather";
const n = Number(process.argv[2] ?? (MAINNET ? 1 : 3));
if (!Number.isInteger(n) || n < 1) { console.error("Request count must be a positive integer."); process.exit(1); }

if (MAINNET) {
  if (process.env.CONFIRM_MAINNET !== "yes") {
    console.error("Mainnet spends real USDC. Re-run with CONFIRM_MAINNET=yes to continue.");
    process.exit(1);
  }
  if (n > 10) { console.error("Mainnet runs are capped at 10 requests."); process.exit(1); }
}

const signer = createEd25519Signer(process.env.PAYER_SECRET, NETWORK);
const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

console.log(`Paying ${url} on ${NETWORK}, ${n} request(s)`);
for (let i = 1; i <= n; i++) {
  const r = await pay(url);
  const receipt = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
  let tx = "";
  if (receipt) {
    try { tx = JSON.parse(Buffer.from(receipt, "base64").toString()).transaction ?? ""; } catch {}
  }
  console.log(`request ${i}: HTTP ${r.status}`, await r.text(), tx ? `\n  tx: ${EXPLORER}/tx/${tx}` : "");
}
