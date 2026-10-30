// Pure valuation functions for the /coins routes. No I/O here, so they are unit-testable.
import { BULK_OBSERVATIONS, COIN, KEY_DATES, type Channel, type KeyDate } from "./data.ts";

export const LB_COPPER_PER_COIN = (COIN.grams * COIN.copperShare) / COIN.gramsPerLb;
export const COINS_PER_LB = COIN.gramsPerLb / COIN.grams;

const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Melt value of one wheat cent in US cents for a copper spot in USD/lb. */
export const meltCents = (spotUsdLb: number) => spotUsdLb * LB_COPPER_PER_COIN * 100;

export interface MeltInput { spot: number; coins?: number; lb?: number; steelPct?: number }

export function melt({ spot, coins, lb, steelPct = 0 }: MeltInput) {
  const total = coins ?? (lb !== undefined ? lb * COINS_PER_LB : 1);
  const copperCoins = total * (1 - Math.min(100, Math.max(0, steelPct)) / 100);
  const copperLb = copperCoins * LB_COPPER_PER_COIN;
  return {
    copperUsdPerLb: r(spot),
    perCoinCents: r(meltCents(spot)),
    perLbUsd: r((meltCents(spot) * COINS_PER_LB) / 100),
    coins: r(total, 1),
    copperCoins: r(copperCoins, 1),
    copperLb: r(copperLb),
    totalMeltUsd: r(copperLb * spot, 2),
    faceValueUsd: r(total / 100, 2),
    copperBreakevenUsdLb: { for2c: r(0.02 / LB_COPPER_PER_COIN, 2), for4c: r(0.04 / LB_COPPER_PER_COIN, 2) },
  };
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

export function bulk(spot: number, channel?: Channel) {
  const m = meltCents(spot);
  const rows = BULK_OBSERVATIONS.filter(o => !channel || o.channel === channel).map(o => {
    const c = (o.totalUsd / o.coins) * 100;
    return { ...o, centsPerCoin: r(c), vsMeltCents: r(c - m) };
  });
  const channels: Channel[] = ["dealer", "auction", "wholesale", "retail"];
  const summary = Object.fromEntries(channels.map(ch => {
    const v = rows.filter(o => o.channel === ch).map(o => o.centsPerCoin);
    const md = median(v);
    return [ch, { n: v.length, medianCents: md === null ? null : r(md), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null }];
  }).filter(([, s]: any) => s.n > 0));
  return { meltCents: r(m), summary, observations: rows };
}

export const cagr = (a: number, b: number, years: number) => (Math.pow(b / a, 1 / years) - 1) * 100;

export function keyDateView(k: KeyDate, spot: number) {
  const h = k.fineHistory;
  const has = (y: number) => typeof h[y] === "number";
  return {
    id: k.id, name: k.name, mintage: k.mintage,
    fineHistory: h, ladder: k.ladder,
    cagrPct: {
      since1958: has(1958) && has(2026) ? r(cagr(h[1958], h[2026], 68), 2) : null,
      since2000: has(2000) && has(2026) ? r(cagr(h[2000], h[2026], 26), 2) : null,
    },
    fineMultipleOfMelt: has(2026) ? Math.round(h[2026] / (meltCents(spot) / 100)) : null,
    sources: k.sources,
  };
}

export const findKeyDate = (id: string) => KEY_DATES.find(k => k.id === id.toLowerCase());

// ---- Scenario model (same math as the Wheat Cent Ledger web app) ----------

export interface ScenarioParams {
  years: number;      // horizon
  copperPct: number;  // copper trend %/yr
  demandPct: number;  // collector demand growth %/yr
  liquidationPct: number; // share of older collections sold per year
  haltPct: number;    // production-halt attention premium (peak, %)
  attritionPct: number;   // supply leaving the market %/yr
}

export const PRESETS: Record<"boom" | "base" | "liquidation", Omit<ScenarioParams, "years">> = {
  boom: { copperPct: 3, demandPct: 6, liquidationPct: 2, haltPct: 25, attritionPct: 1.5 },
  base: { copperPct: 2, demandPct: 3, liquidationPct: 3, haltPct: 10, attritionPct: 1 },
  liquidation: { copperPct: 0, demandPct: 1, liquidationPct: 7, haltPct: 5, attritionPct: 0.5 },
};

/** Attention bump that builds over ~2 years and fades with a 4-year half-life. */
export const haltFactor = (h: number, t: number) => 1 + h * (1 - 2 ** -t) * 2 ** (-t / 4);

export function projectBulk(p: ScenarioParams, bulkCentsToday: number, spot: number) {
  const m0 = meltCents(spot);
  const path = [];
  for (let t = 0; t <= p.years; t++) {
    const s = spot * (1 + p.copperPct / 100) ** t;
    const m = meltCents(s);
    const supply = (1 + p.liquidationPct / 100 - p.attritionPct / 100) ** t;
    const demand = (1 + p.demandPct / 100) ** t;
    const b = bulkCentsToday * (m / m0) ** 0.8 * (demand / supply) * haltFactor(p.haltPct / 100, t);
    path.push({ year: t, copperUsdLb: r(s, 3), meltCents: r(m), bulkCents: r(b) });
  }
  return path;
}

export function projectKeyDate(k: KeyDate, p: ScenarioParams) {
  const h = k.fineHistory;
  if (!h[2000] || !h[2026]) return null;
  const g = cagr(h[2000], h[2026], 26) / 100 + (0.5 * (p.demandPct - p.liquidationPct)) / 100;
  return r(h[2026] * (1 + g) ** p.years * haltFactor(p.haltPct / 300, p.years), 2);
}

export function scenario(p: ScenarioParams, bulkCentsToday: number, holdings: number, spot: number) {
  const run = (pp: ScenarioParams) => {
    const path = projectBulk(pp, bulkCentsToday, spot);
    const end = path[path.length - 1];
    return {
      params: pp,
      end: {
        bulkCents: end.bulkCents, meltCents: end.meltCents,
        holdingsUsd: r((holdings * end.bulkCents) / 100, 2),
        holdingsMeltFloorUsd: r((holdings * end.meltCents) / 100, 2),
      },
      keyDatesFine: Object.fromEntries(KEY_DATES.filter(k => k.fineHistory[2026]).map(k => [k.id, projectKeyDate(k, pp)])),
      path,
    };
  };
  return {
    inputs: { bulkCentsToday, holdings, copperUsdLb: spot },
    custom: run(p),
    presets: Object.fromEntries(Object.entries(PRESETS).map(([n, v]) => [n, run({ ...v, years: p.years })])),
  };
}
