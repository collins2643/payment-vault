import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const {
  PORT = 4021,
  FACILITATOR_URL = "https://x402.org/facilitator",
  EVM_PAY_TO, SVM_PAY_TO, AVM_PAY_TO, STELLAR_PAY_TO,
  EVM_NETWORK = "eip155:84532",
  SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  AVM_NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
  STELLAR_NETWORK = "stellar:testnet",
} = process.env;

// 1. Facilitator client: verifies + settles payments on-chain for you.
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// 2. Resource server: register one "exact" scheme per enabled network.
const server = new x402ResourceServer(facilitator);
const chains = [
  { payTo: EVM_PAY_TO, network: EVM_NETWORK, scheme: () => new ExactEvmScheme() },
  { payTo: SVM_PAY_TO, network: SVM_NETWORK, scheme: () => new ExactSvmScheme() },
  { payTo: AVM_PAY_TO, network: AVM_NETWORK, scheme: () => new ExactAvmScheme() },
  { payTo: STELLAR_PAY_TO, network: STELLAR_NETWORK, scheme: () => new ExactStellarScheme() },
].filter((c) => c.payTo);
if (!chains.length) throw new Error("Set at least one of EVM_PAY_TO / SVM_PAY_TO / AVM_PAY_TO / STELLAR_PAY_TO");
for (const c of chains) server.register(c.network, c.scheme());

// Helper: build an `accepts` list so clients may pay on any enabled chain.
const accepts = (price) =>
  chains.map(({ network, payTo }) => ({ scheme: "exact", price, network, payTo }));

// 3. Route pricing table ("METHOD /path" -> requirements).
const routes = {
  "GET /api/weather": {
    accepts: accepts("$0.001"),
    description: "Current weather report",
    mimeType: "application/json",
  },
  "POST /api/summarize": {
    accepts: accepts("$0.01"),
    description: "Summarize a text payload",
    mimeType: "application/json",
  },
};

const app = express();
app.use(express.json());

// Free routes go BEFORE the middleware (or simply aren't listed in `routes`).
app.get("/health", (_req, res) => res.json({ ok: true, networks: chains.map((c) => c.network) }));

// 4. Payment middleware: returns 402 + PAYMENT-REQUIRED until a valid payment header arrives,
//    then runs your handler and settles after a successful response.
app.use(paymentMiddleware(routes, server));

// 5. Protected handlers — only reached after payment verification.
app.get("/api/weather", (_req, res) => {
  res.json({ city: "Atlanta", tempF: 78, conditions: "sunny", paid: true });
});

app.post("/api/summarize", (req, res) => {
  const text = String(req.body?.text ?? "");
  res.json({ summary: text.split(/\s+/).slice(0, 20).join(" "), words: text.split(/\s+/).filter(Boolean).length });
});

app.listen(PORT, () => console.log(`x402 server on http://localhost:${PORT} (${chains.map((c) => c.network).join(", ")})`));
