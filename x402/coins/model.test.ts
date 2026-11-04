import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { bulk, cagr, COINS_PER_LB, findKeyDate, keyDateView, melt, meltCents, projectBulk, PRESETS, scenario } from "./model.ts";
import { coinPaidRoutes, coinRouter, COIN_PRICES } from "./routes.ts";

test("melt value per coin matches 3.11 g x 95% copper", () => {
  // 3.11 * 0.95 / 453.592 lb copper; at $6.55/lb that is ~4.27 cents
  assert.ok(Math.abs(meltCents(6.55) - 4.2667) < 0.001);
  assert.ok(Math.abs(COINS_PER_LB - 145.85) < 0.01);
});

test("melt totals, pounds input, and steel exclusion", () => {
  const m = melt({ spot: 6.6, coins: 5000 });
  assert.equal(m.totalMeltUsd, 214.95);
  const byLb = melt({ spot: 6.6, lb: 1 });
  assert.equal(byLb.coins, 145.8);
  const steel = melt({ spot: 6.6, coins: 1000, steelPct: 10 });
  assert.equal(steel.copperCoins, 900);
  assert.equal(m.copperBreakevenUsdLb.for4c, 6.14);
});

test("bulk medians by channel", () => {
  const b = bulk(6.55);
  assert.equal(b.summary.dealer.medianCents, 3);
  assert.equal(b.summary.retail.n, 2);
  assert.equal(bulk(6.55, "auction").observations.length, 3);
});

test("key-date CAGR since 2000 is in the 3-5% range", () => {
  const v = keyDateView(findKeyDate("1909-S-VDB")!, 6.55);
  assert.ok(v.cagrPct.since2000! > 3.4 && v.cagrPct.since2000! < 3.8);
  assert.equal(keyDateView(findKeyDate("1955-ddo")!, 6.55).cagrPct.since2000, null);
  assert.ok(Math.abs(cagr(100, 200, 10) - 7.177) < 0.01);
});

test("scenario starts at today's bulk price and presets order correctly", () => {
  const path = projectBulk({ years: 10, ...PRESETS.base }, 3, 6.55);
  assert.equal(path[0].bulkCents, 3);
  const s = scenario({ years: 10, ...PRESETS.base }, 3, 10000, 6.55);
  const end = (k: string) => (s.presets as any)[k].end.bulkCents;
  assert.ok(end("boom") > end("base") && end("base") > end("liquidation"));
  assert.equal(s.custom.end.holdingsUsd, Math.round(10000 * s.custom.end.bulkCents) / 100);
});

test("paid route config covers all four data routes", () => {
  const cfg = coinPaidRoutes("stellar:testnet", "CPAYTO", "CUSDC");
  assert.deepEqual(Object.keys(cfg).sort(), ["GET /coins/bulk", "GET /coins/keydates", "GET /coins/melt", "GET /coins/scenario"]);
  assert.equal((cfg["GET /coins/scenario"] as any).accepts[0].price.amount, COIN_PRICES.scenario);
});

test("handlers: 200 on valid input, 400 on bad input (unpaid router)", async () => {
  const app = express().use(coinRouter());
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const ok = await fetch(`${base}/coins/melt?spot=6.6&coins=5000`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).totalMeltUsd, 214.95);
    assert.equal((await fetch(`${base}/coins/melt?coins=1&lb=1&spot=6`)).status, 400);
    assert.equal((await fetch(`${base}/coins/keydates?id=nope&spot=6`)).status, 400);
    assert.equal((await fetch(`${base}/coins/scenario?preset=moon&spot=6`)).status, 400);
    assert.equal((await fetch(`${base}/coins/bulk?channel=pawn&spot=6`)).status, 400);
    const sc = await (await fetch(`${base}/coins/scenario?preset=boom&years=5&holdings=100&spot=6.55`)).json();
    assert.equal(sc.custom.path.length, 6);
    const cat = await (await fetch(`${base}/coins`)).json();
    assert.equal(cat.routes["/coins/scenario"].priceUsdc, 0.005);
  } finally { srv.close(); }
});
