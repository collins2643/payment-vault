// Paid wheat-cent valuation API. Mounted by server.ts; payment terms come from coinPaidRoutes().
// Handlers answer 400 for bad input; @x402/express cancels settlement on any status >= 400,
// so callers are not charged for rejected requests.
import { Router, type Request, type Response } from "express";
import { DATA_AS_OF, FALLBACK_COPPER_USD_LB, KEY_DATES, LEGAL_NOTICE, type Channel } from "./data.ts";
import { bulk, findKeyDate, keyDateView, melt, PRESETS, scenario, type ScenarioParams } from "./model.ts";

// ---- Pricing (raw USDC units, 7 decimals: 10000 = 0.001 USDC) -------------
export const COIN_PRICES = {
  melt: process.env.COIN_PRICE_MELT ?? "10000",         // 0.001 USDC
  bulk: process.env.COIN_PRICE_BULK ?? "10000",         // 0.001 USDC
  keydates: process.env.COIN_PRICE_KEYDATES ?? "20000", // 0.002 USDC
  scenario: process.env.COIN_PRICE_SCENARIO ?? "50000", // 0.005 USDC
};

const ROUTES = {
  melt: { path: "/coins/melt", description: "Wheat cent copper melt value from live copper spot" },
  bulk: { path: "/coins/bulk", description: "Wheat cent bulk price observations and channel medians" },
  keydates: { path: "/coins/keydates", description: "Key-date wheat cent value history, grade ladder, and CAGR" },
  scenario: { path: "/coins/scenario", description: "Wheat cent bulk and key-date value projections" },
} as const;

/** Payment-middleware entries for the paid coin routes. */
export function coinPaidRoutes(network: string, payTo: string, asset: string) {
  return Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [
    `GET ${r.path}`,
    {
      accepts: [{ scheme: "exact", network, payTo, price: { asset, amount: COIN_PRICES[k as keyof typeof COIN_PRICES] } }],
      description: r.description,
      mimeType: "application/json",
    },
  ]));
}

// ---- Live copper with a short cache ---------------------------------------
const COPPER_URL = process.env.COPPER_PRICE_URL ?? "https://api.gold-api.com/price/HG";
const CACHE_MS = 60_000;
let cache: { price: number; at: number; updatedAt: string } | null = null;

export async function copperSpot(): Promise<{ usdPerLb: number; source: "live" | "cached" | "fallback"; updatedAt: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { usdPerLb: cache.price, source: "cached", updatedAt: cache.updatedAt };
  try {
    const r = await fetch(COPPER_URL, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    const j: any = await r.json();
    const p = Number(j.price);
    if (!(p > 0 && p < 100)) throw new Error("implausible copper price");
    cache = { price: p, at: Date.now(), updatedAt: j.updatedAt ?? new Date().toISOString() };
    return { usdPerLb: p, source: "live", updatedAt: cache.updatedAt };
  } catch {
    if (cache) return { usdPerLb: cache.price, source: "cached", updatedAt: cache.updatedAt };
    return { usdPerLb: FALLBACK_COPPER_USD_LB, source: "fallback", updatedAt: `${DATA_AS_OF}T21:00:00Z` };
  }
}

// ---- Query parsing ---------------------------------------------------------
class BadRequest extends Error {}
function num(q: Request["query"], key: string, opts: { min?: number; max?: number; def?: number } = {}): number | undefined {
  const raw = q[key];
  if (raw === undefined || raw === "") return opts.def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new BadRequest(`${key} must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new BadRequest(`${key} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new BadRequest(`${key} must be <= ${opts.max}`);
  return v;
}

async function spotFor(req: Request) {
  const override = num(req.query, "spot", { min: 0.01, max: 100 });
  if (override !== undefined) return { usdPerLb: override, source: "caller" as const, updatedAt: new Date().toISOString() };
  return copperSpot();
}

const wrap = (fn: (req: Request) => Promise<object>) => async (req: Request, res: Response) => {
  try {
    res.json({ ...(await fn(req)), dataAsOf: DATA_AS_OF });
  } catch (e) {
    if (e instanceof BadRequest) res.status(400).json({ error: e.message, charged: false });
    else { console.error("coins route error", e); res.status(500).json({ error: "internal error", charged: false }); }
  }
};

// ---- Router ----------------------------------------------------------------
export function coinRouter() {
  const router = Router();

  // Free catalog so agents and buyers can discover routes and prices before paying.
  router.get("/coins", (_req, res) => {
    res.json({
      name: "Wheat Cent Valuation API",
      coverage: "Lincoln wheat cents, 1909–1958",
      payment: "x402 (Stellar USDC). Unpaid requests return HTTP 402 with payment terms. Requests rejected with 400 are not charged.",
      dataAsOf: DATA_AS_OF,
      routes: Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [r.path, {
        description: r.description,
        priceUsdc: Number(COIN_PRICES[k as keyof typeof COIN_PRICES]) / 1e7,
      }])),
      params: {
        "/coins/melt": "spot? (USD/lb override), coins? | lb?, steelPct? (share of 1943 steel cents)",
        "/coins/bulk": "spot?, channel? (dealer|auction|wholesale|retail)",
        "/coins/keydates": `id? (${KEY_DATES.map(k => k.id).join("|")}), spot?`,
        "/coins/scenario": "preset? (boom|base|liquidation), years?, copperPct?, demandPct?, liquidationPct?, haltPct?, attritionPct?, bulkCents?, holdings?, spot?",
      },
      notice: LEGAL_NOTICE,
    });
  });

  router.get(ROUTES.melt.path, wrap(async req => {
    const coins = num(req.query, "coins", { min: 0, max: 1e9 });
    const lb = num(req.query, "lb", { min: 0, max: 1e7 });
    if (coins !== undefined && lb !== undefined) throw new BadRequest("pass coins or lb, not both");
    const steelPct = num(req.query, "steelPct", { min: 0, max: 100, def: 0 });
    const copper = await spotFor(req);
    return { copper, ...melt({ spot: copper.usdPerLb, coins, lb, steelPct }), notice: LEGAL_NOTICE };
  }));

  router.get(ROUTES.bulk.path, wrap(async req => {
    const ch = req.query.channel as string | undefined;
    const channels = ["dealer", "auction", "wholesale", "retail"];
    if (ch && !channels.includes(ch)) throw new BadRequest(`channel must be one of ${channels.join(", ")}`);
    const copper = await spotFor(req);
    return { copper, ...bulk(copper.usdPerLb, ch as Channel | undefined),
      note: "Observations marked estimate are owner-supplied dealer ranges, not public listings." };
  }));

  router.get(ROUTES.keydates.path, wrap(async req => {
    const copper = await spotFor(req);
    const id = req.query.id as string | undefined;
    if (id) {
      const k = findKeyDate(id);
      if (!k) throw new BadRequest(`unknown id; use one of ${KEY_DATES.map(k => k.id).join(", ")}`);
      return { copper, keyDate: keyDateView(k, copper.usdPerLb) };
    }
    return { copper, keyDates: KEY_DATES.map(k => keyDateView(k, copper.usdPerLb)),
      note: "Fine history: 1958–2015 guide values (Fine-12), 2026 market (F 12–15). Ladder values blend raw and graded sales." };
  }));

  router.get(ROUTES.scenario.path, wrap(async req => {
    const preset = (req.query.preset as string | undefined) ?? "base";
    if (!(preset in PRESETS)) throw new BadRequest("preset must be boom, base, or liquidation");
    const b = PRESETS[preset as keyof typeof PRESETS];
    const p: ScenarioParams = {
      years: num(req.query, "years", { min: 1, max: 25, def: 10 })!,
      copperPct: num(req.query, "copperPct", { min: -10, max: 15, def: b.copperPct })!,
      demandPct: num(req.query, "demandPct", { min: 0, max: 20, def: b.demandPct })!,
      liquidationPct: num(req.query, "liquidationPct", { min: 0, max: 20, def: b.liquidationPct })!,
      haltPct: num(req.query, "haltPct", { min: 0, max: 100, def: b.haltPct })!,
      attritionPct: num(req.query, "attritionPct", { min: 0, max: 10, def: b.attritionPct })!,
    };
    const bulkCents = num(req.query, "bulkCents", { min: 0.1, max: 100, def: 3 })!;
    const holdings = num(req.query, "holdings", { min: 0, max: 1e9, def: 0 })!;
    const copper = await spotFor(req);
    return { copper, preset, ...scenario(p, bulkCents, holdings, copper.usdPerLb),
      disclaimer: "Illustrative model, not a forecast or investment advice." };
  }));

  return router;
}
