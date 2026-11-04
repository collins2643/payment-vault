// Reviewer-facing demo: a public page (GET /), a status API (GET /api/status) and an
// optional "Pay 0.001 USDC" button (POST /api/demo-pay) that pays from a separate,
// capped Testnet wallet. The vault owner key is never used or needed here.
import type { Express, Request, Response } from "express";
import { readFileSync } from "node:fs";
import { rpc, Contract, Address, TransactionBuilder, Networks, Account, Keypair, scValToNative } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

export type Settlement = { tx: string; kind: string; at: string; amount?: string; payer?: string };

type DemoOptions = {
  mainnet: boolean;
  network: string;
  payTo: string;
  usdc: string;
  rpcUrl: string;
  port: number;
  priceUnits: string;
  facilitator: string;
  settlements: Settlement[];
};

const MAX_PER_HOUR = Number(process.env.DEMO_MAX_PER_HOUR ?? 20);
const MAX_PER_IP_PER_HOUR = Number(process.env.DEMO_MAX_PER_IP_PER_HOUR ?? 3);
const HOUR = 3_600_000;

// Verified Testnet history for the current vault, shown until live settlements arrive.
const SEED: Settlement[] = JSON.parse(readFileSync(new URL("./evidence.json", import.meta.url), "utf8"));

export function registerDemo(app: Express, o: DemoOptions) {
  const server = new rpc.Server(o.rpcUrl);
  const reader = new Account(Keypair.random().publicKey(), "0");
  const passphrase = o.mainnet ? Networks.PUBLIC : Networks.TESTNET;

  async function read(contract: string, fn: string, ...args: any[]) {
    const tx = new TransactionBuilder(reader, { fee: "100", networkPassphrase: passphrase })
      .addOperation(new Contract(contract).call(fn, ...args)).setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error.split("\n")[0]}`);
    return scValToNative(sim.result!.retval);
  }

  let cache: { at: number; data: any } | undefined;
  async function vaultState(fresh = false) {
    if (!fresh && cache && Date.now() - cache.at < 10_000) return cache.data;
    const isContract = o.payTo.startsWith("C");
    const [balance, owner] = await Promise.all([
      read(o.usdc, "balance", Address.fromString(o.payTo).toScVal()),
      isContract ? read(o.payTo, "owner").catch(() => null) : Promise.resolve(null),
    ]);
    cache = { at: Date.now(), data: { balanceUnits: String(balance), owner } };
    return cache.data;
  }

  // Demo payer: Testnet only, separate wallet, rate-limited.
  const secret = process.env.DEMO_PAYER_SECRET;
  const demoEnabled = !o.mainnet && !!secret;
  const payFetch = demoEnabled
    ? wrapFetchWithPayment(fetch, new x402Client().register(o.network as any,
        new ExactStellarScheme(createEd25519Signer(secret!, o.network as any))))
    : undefined;
  const demoPayer = demoEnabled ? Keypair.fromSecret(secret!).publicKey() : null;
  const recent: { at: number; ip: string }[] = [];

  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(new URL("./public/index.html", import.meta.url), "utf8"));
  });

  app.get("/api/status", async (_req, res) => {
    try {
      const state = await vaultState();
      res.json({
        network: o.network, vault: o.payTo, usdc: o.usdc, priceUnits: o.priceUnits,
        facilitator: o.facilitator.replace(/\/\/[^/]*@/, "//"), ...state,
        demoEnabled, demoPayer, settlements: [...o.settlements, ...SEED].slice(0, 15),
      });
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  app.post("/api/demo-pay", async (req: Request, res: Response) => {
    if (!payFetch) return res.status(404).json({ error: "Demo payments are disabled on this server." });
    const now = Date.now();
    while (recent.length && now - recent[0].at > HOUR) recent.shift();
    const ip = req.ip ?? "unknown";
    if (recent.length >= MAX_PER_HOUR) return res.status(429).json({ error: "Demo limit reached for this hour. Try again later." });
    if (recent.filter((r) => r.ip === ip).length >= MAX_PER_IP_PER_HOUR)
      return res.status(429).json({ error: `Limit is ${MAX_PER_IP_PER_HOUR} demo payments per hour per visitor.` });
    recent.push({ at: now, ip });

    try {
      const before = (await vaultState(true)).balanceUnits;
      const r = await payFetch(`http://127.0.0.1:${o.port}/weather`);
      const body = await r.text();
      const header = r.headers.get("PAYMENT-RESPONSE") ?? r.headers.get("X-PAYMENT-RESPONSE");
      const settle = header ? decodePaymentResponseHeader(header) : null;
      const after = (await vaultState(true)).balanceUnits;
      res.status(r.ok ? 200 : 502).json({ status: r.status, body, tx: settle?.transaction ?? null, before, after,
        error: r.ok ? undefined : "Payment did not settle. The payment service (facilitator) may be unavailable." });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
}
