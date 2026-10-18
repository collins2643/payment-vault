// Self-hosted x402 facilitator for Stellar (verify + settle), built on the official @x402 packages.
//
// Why: a USDC payment into a Soroban contract (the Payment Vault) costs ~140,000 stroops in
// resource fees, versus ~24,000 to a G... wallet. The public x402.org facilitator rejects anything
// over 50,000 stroops (`invalid_exact_stellar_payload_fee_exceeds_maximum`), so vault payments
// need a facilitator with a higher ceiling. This one sponsors fees from its own funded account.
//
// Run:  npm run facilitator              (Testnet; generates and Friendbot-funds a throwaway signer)
// Then: FACILITATOR_URL=http://localhost:4022 npm start
//
// Settings (environment):
//   FACILITATOR_SECRET     S... key that pays settlement fees. Required on mainnet. Never commit it.
//   STELLAR_NETWORK        testnet (default) or mainnet
//   MAX_FEE_STROOPS        fee ceiling per settlement (default 300000 = 0.03 XLM)
//   FACILITATOR_API_KEY    if set, /verify and /settle require "Authorization: Bearer <key>".
//                          Set it whenever this is reachable from the internet; otherwise anyone
//                          can make you pay their fees. server.ts already sends this header.
//   STELLAR_RPC_URL        optional custom Soroban RPC
//   PORT                   default 4022
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";

const MAINNET = process.env.STELLAR_NETWORK === "mainnet";
const NETWORK = MAINNET ? "stellar:pubnet" : "stellar:testnet";
const MAX_FEE = Number(process.env.MAX_FEE_STROOPS ?? 300_000);
const API_KEY = process.env.FACILITATOR_API_KEY;
const PORT = Number(process.env.PORT ?? 4022);

let secret = process.env.FACILITATOR_SECRET;
if (!secret) {
  if (MAINNET) throw new Error("Set FACILITATOR_SECRET to a funded mainnet account for mainnet");
  // Testnet convenience: throwaway signer funded by Friendbot. It changes on every restart.
  const k = Keypair.random();
  const r = await fetch(`https://friendbot.stellar.org?addr=${k.publicKey()}`);
  if (!r.ok) throw new Error(`Friendbot failed: ${r.status}`);
  secret = k.secret();
  console.log("No FACILITATOR_SECRET set; using a throwaway Friendbot-funded Testnet signer.");
}
if (MAINNET && !API_KEY) {
  throw new Error("Set FACILITATOR_API_KEY on mainnet so strangers cannot spend your XLM on fees");
}
if (!Number.isFinite(MAX_FEE) || MAX_FEE <= 0) throw new Error("MAX_FEE_STROOPS must be a positive number");

const signer = createEd25519Signer(secret, NETWORK);
const rpcConfig = process.env.STELLAR_RPC_URL ? { url: process.env.STELLAR_RPC_URL } : undefined;
const facilitator = new x402Facilitator().register(
  NETWORK,
  new ExactStellarScheme([signer], { maxTransactionFeeStroops: MAX_FEE, rpcConfig }),
);

const app = express();
app.use(express.json({ limit: "100kb" }));
const requireKey: express.RequestHandler = (req, res, next) => {
  if (!API_KEY || req.get("authorization") === `Bearer ${API_KEY}`) return next();
  res.status(401).json({ error: "unauthorized" });
};

app.get("/health", (_req, res) => res.send("ok"));
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
app.post("/verify", requireKey, async (req, res) => {
  try {
    const out = await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements);
    console.log("verify", out.isValid ? "ok" : out.invalidReason, out.payer ?? "");
    res.json(out);
  } catch (e) {
    console.error("verify error", e);
    res.status(400).json({ isValid: false, invalidReason: "verify_error" });
  }
});
app.post("/settle", requireKey, async (req, res) => {
  try {
    const out = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
    console.log("settle", out.success ? out.transaction : out.errorReason, out.payer ?? "");
    res.json(out);
  } catch (e) {
    console.error("settle error", e);
    res.status(400).json({ success: false, errorReason: "settle_error", transaction: "", network: NETWORK });
  }
});

app.listen(PORT, () =>
  console.log(`x402 facilitator on :${PORT} (${NETWORK}), fee payer ${signer.address}, max fee ${MAX_FEE} stroops`));
