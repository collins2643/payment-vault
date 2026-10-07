// x402 server for Stellar. Payments go to PAY_TO: a wallet (G...) or the Payment Vault (C...).
// Shape based on https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { StrKey, rpc } from "@stellar/stellar-sdk";

// ---- Settings --------------------------------------------------------------
// STELLAR_NETWORK: "testnet" (default) or "mainnet". Also accepts "pubnet",
// "stellar:pubnet", "public", and "stellar:testnet".
function parseNetwork(raw = "testnet"): boolean {
  const v = raw.trim().toLowerCase();
  if (["mainnet", "pubnet", "public", "stellar:pubnet"].includes(v)) return true;
  if (["testnet", "stellar:testnet", ""].includes(v)) return false;
  throw new Error(`Unknown STELLAR_NETWORK "${raw}". Use "testnet" or "mainnet".`);
}
const MAINNET = parseNetwork(process.env.STELLAR_NETWORK);
const NETWORK = MAINNET ? "stellar:pubnet" : "stellar:testnet";
const PAY_TO = (process.env.PAY_TO ?? process.env.STELLAR_PAY_TO ?? process.env.VAULT_ADDRESS ?? "").trim();
const USDC = MAINNET
  ? "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
  : "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_ISSUER = MAINNET
  ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON = MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.STELLAR_RPC_URL
  ?? (MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
const EXPLORER = `https://stellar.expert/explorer/${MAINNET ? "public" : "testnet"}`;
// Payment service (facilitator).
//  Testnet: Coinbase's free x402.org facilitator (no key).
//  Mainnet: Built on Stellar / OpenZeppelin facilitator; needs FACILITATOR_API_KEY
//           (generate at https://channels.openzeppelin.com/gen).
const OZ_MAINNET = "https://channels.openzeppelin.com/x402";
const FACILITATOR = process.env.FACILITATOR_URL
  ?? (MAINNET ? OZ_MAINNET : "https://www.x402.org/facilitator");
const FACILITATOR_KEY = process.env.FACILITATOR_API_KEY?.trim() || undefined;
const PRICE_UNITS = process.env.PRICE_UNITS ?? "10000"; // 10000 = 0.001 USDC (7 decimals)
// Mainnet price ceiling (raw units) to catch typos. Default 10_000_000 = 1 USDC.
const MAX_PRICE_UNITS = BigInt(process.env.MAX_PRICE_UNITS ?? "10000000");
// The vault is unaudited. On mainnet, paying a C... vault needs explicit opt-in.
const ALLOW_UNAUDITED_VAULT = process.env.ALLOW_UNAUDITED_VAULT === "yes";

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
}

function checkConfig() {
  if (!/^[1-9][0-9]*$/.test(PRICE_UNITS)) throw new Error(`PRICE_UNITS must be a positive integer, got "${PRICE_UNITS}"`);
  if (!FACILITATOR) throw new Error("Set FACILITATOR_URL");
  if (FACILITATOR.includes("x402.org") && MAINNET) {
    throw new Error("x402.org/facilitator is testnet-only. Use https://channels.openzeppelin.com/x402 for mainnet.");
  }
  if (!MAINNET) return;
  if (FACILITATOR.startsWith("https://channels.openzeppelin.com") && !FACILITATOR_KEY) {
    throw new Error("Mainnet facilitator needs FACILITATOR_API_KEY (generate at https://channels.openzeppelin.com/gen).");
  }
  if (BigInt(PRICE_UNITS) > MAX_PRICE_UNITS) {
    throw new Error(`PRICE_UNITS ${PRICE_UNITS} is above MAX_PRICE_UNITS ${MAX_PRICE_UNITS}. Raise MAX_PRICE_UNITS if intended.`);
  }
  if (StrKey.isValidContract(PAY_TO) && !ALLOW_UNAUDITED_VAULT) {
    throw new Error(
      "PAY_TO is a contract on mainnet, but the Payment Vault is unaudited. " +
      "Use a G... wallet you control, or set ALLOW_UNAUDITED_VAULT=yes to accept the risk (keep balances small).",
    );
  }
}

// Confirm the facilitator actually settles "exact" payments on this network.
async function checkFacilitator(client: HTTPFacilitatorClient) {
  let supported;
  try { supported = await client.getSupported(); }
  catch (e: any) { throw new Error(`Facilitator ${FACILITATOR} unreachable or rejected the API key: ${e?.message ?? e}`); }
  const ok = supported.kinds.some((k) => k.scheme === "exact" && k.network === NETWORK);
  if (!ok) throw new Error(`Facilitator ${FACILITATOR} does not list exact/${NETWORK} in /supported`);
}

// ---- Server ---------------------------------------------------------------
checkConfig();
await checkPayTo();
const headers = FACILITATOR_KEY ? { Authorization: `Bearer ${FACILITATOR_KEY}` } : undefined;
const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR,
  createAuthHeaders: headers ? async () => ({ verify: headers, settle: headers, supported: headers }) : undefined,
});
await checkFacilitator(facilitator);

const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactStellarScheme())
  // Log every settled payment so it can be reconciled against the vault balance.
  .onAfterSettle(async ({ result }) => {
    console.log(`[paid] ${result.network} payer=${result.payer ?? "?"} tx=${result.transaction} ${EXPLORER}/tx/${result.transaction}`);
  })
  .onSettleFailure(async ({ error }) => {
    console.error(`[settle-failed] ${error.message}`);
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
  resourceServer,
));
app.get("/health", (_req, res) => res.send("ok")); // free route for Railway health checks
app.get("/weather", (_req, res) => res.json({ forecast: "sunny" }));

const PORT = Number(process.env.PORT ?? 4021);
const usd = (Number(PRICE_UNITS) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
app.listen(PORT, () => console.log(
  `x402 server on :${PORT} (${NETWORK}), ${usd} USDC per request, paying ${PAY_TO}` +
  (MAINNET ? "  ** MAINNET: real money **" : ""),
));
