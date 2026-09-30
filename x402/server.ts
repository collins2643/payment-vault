// x402 server for Stellar. Payments go to PAY_TO: a wallet (G...) or the Payment Vault (C...).
// Shape based on https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { StrKey, rpc } from "@stellar/stellar-sdk";

// ---- Settings --------------------------------------------------------------
const MAINNET = process.env.STELLAR_NETWORK === "mainnet";
const NETWORK = MAINNET ? "stellar:pubnet" : "stellar:testnet";
const PAY_TO = process.env.PAY_TO ?? process.env.VAULT_ADDRESS ?? "";
const USDC = MAINNET
  ? "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
  : "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_ISSUER = MAINNET
  ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON = MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.STELLAR_RPC_URL
  ?? (MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
// Payment service. Testnet default: Coinbase's free one. Mainnet: you must set one
// (e.g. OpenZeppelin https://channels.openzeppelin.com/x402 with FACILITATOR_API_KEY).
const FACILITATOR = process.env.FACILITATOR_URL ?? (MAINNET ? "" : "https://www.x402.org/facilitator");
const FACILITATOR_KEY = process.env.FACILITATOR_API_KEY;
const PRICE_UNITS = process.env.PRICE_UNITS ?? "10000"; // 0.001 USDC (7 decimals)

// ---- Safety checks at startup ---------------------------------------------
async function checkPayTo() {
  if (PAY_TO === USDC) throw new Error("PAY_TO cannot be the USDC contract itself");
  if (StrKey.isValidEd25519PublicKey(PAY_TO)) {
    // Wallet: must exist and hold a USDC trustline, or payments fail.
    const r = await fetch(`${HORIZON}/accounts/${PAY_TO}`);
    if (!r.ok) throw new Error(`Wallet ${PAY_TO} does not exist on ${NETWORK}`);
    const acct: any = await r.json();
    const ok = acct.balances.some((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
    if (!ok) throw new Error(`Wallet ${PAY_TO} has no USDC trustline on ${NETWORK}. Add one in your wallet app.`);
  } else if (StrKey.isValidContract(PAY_TO)) {
    // Contract: something must actually be deployed there.
    try { await new rpc.Server(RPC_URL).getContractWasmByContractId(PAY_TO); }
    catch { throw new Error(`No contract deployed at ${PAY_TO} on ${NETWORK}`); }
  } else {
    throw new Error(`Bad PAY_TO address: "${PAY_TO}" (use a G... wallet or C... contract; M... is not supported)`);
  }
  if (!FACILITATOR) throw new Error("Set FACILITATOR_URL for mainnet");
}

// ---- Server ---------------------------------------------------------------
await checkPayTo();
const headers = FACILITATOR_KEY ? { Authorization: `Bearer ${FACILITATOR_KEY}` } : undefined;
const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR,
  createAuthHeaders: headers ? async () => ({ verify: headers, settle: headers, supported: headers }) : undefined,
});

const app = express();
app.use(paymentMiddleware(
  {
    "GET /weather": {
      accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: { asset: USDC, amount: PRICE_UNITS } }],
      description: "Weather data",
      mimeType: "application/json",
    },
  },
  new x402ResourceServer(facilitator).register(NETWORK, new ExactStellarScheme()),
));
app.get("/weather", (_req, res) => res.json({ forecast: "sunny" }));

const PORT = Number(process.env.PORT ?? 4021);
app.listen(PORT, () => console.log(`x402 server on :${PORT} (${NETWORK}), paying ${PAY_TO}`));
