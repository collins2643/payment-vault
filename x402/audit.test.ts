import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { AuditStore, auditPath, readAudit, type AuditEvent } from "./audit-store.ts";
import { createPaymentAudit } from "./payment-audit.ts";

const NETWORK = "stellar:testnet";
const VAULT = "CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = "GCNFTFXLRJOBXPNTCMQNGIZ5QRAOMCPBXFN55UMBFQX7JT6272GRDPYL";
const txFor = (tag: string) => createHash("sha256").update(tag).digest("hex");
const tagOf = (payload: PaymentPayload) => String(payload.payload.tag ?? "default");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t: TestContext, options: { remoteFailure?: boolean; failEvent?: AuditEvent["type"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "payment-audit-test-"));
  const path = join(dir, "audit.sqlite");
  const store = new AuditStore(path);
  const failures: unknown[] = [];
  let settlements = 0;
  let failEvent = options.failEvent;
  const audit = createPaymentAudit({
    append(event) {
      if (event.type === failEvent) throw new Error("DISK FAILURE SECRET MUST NOT BE LOGGED");
      store.append(event);
    },
  }, {
    network: NETWORK,
    deploymentId: "11111111-1111-4111-8111-111111111111",
    onWriteFailure: event => { failures.push(event); },
  });
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } }],
        extensions: [], signers: {},
      };
    },
    async verify() { return { isValid: true, payer: PAYER }; },
    async settle(payload) {
      settlements++;
      await sleep((Number(tagOf(payload)) || 1) % 5);
      if (options.remoteFailure) throw new Error("FACILITATOR SECRET MUST NOT BE LOGGED");
      return { success: true, transaction: txFor(tagOf(payload)), network: NETWORK, payer: PAYER };
    },
  };
  const resource = audit.attach(new x402ResourceServer(facilitator).register(NETWORK, new ExactStellarScheme()));
  const app = express();
  app.use(audit.middleware);
  app.use(paymentMiddleware({
    "GET /weather": {
      accepts: [{
        scheme: "exact", network: NETWORK, payTo: VAULT,
        price: { asset: TOKEN, amount: "10000" },
      }],
      description: "Weather data", mimeType: "application/json",
    },
  }, resource));
  app.get("/weather", (_req, res) => res.json({ forecast: "sunny" }));
  app.get("/health", (_req, res) => res.status(audit.isHealthy() ? 200 : 503).send("ok"));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const requirements: PaymentRequirements = {
    scheme: "exact", network: NETWORK, amount: "10000", asset: TOKEN, payTo: VAULT,
    maxTimeoutSeconds: 300, extra: { areFeesSponsored: true },
  };
  async function paid(tag = "default", path = "/weather") {
    const payment = {
      x402Version: 2, resource: { url: `${url}/weather` },
      accepted: requirements, payload: { tag },
    };
    return fetch(`${url}${path}`, { headers: {
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payment)).toString("base64"),
      "Authorization": "Bearer AUTH_SECRET_MUST_NOT_BE_LOGGED",
      "Cookie": "session=COOKIE_SECRET_MUST_NOT_BE_LOGGED",
      "X-Request-ID": "client-spoofed-request-id",
    } });
  }
  return {
    path, url, paid, audit, failures,
    countSettlements: () => settlements,
    failOn: (type: AuditEvent["type"] | undefined) => { failEvent = type; },
  };
}

test("real Express/x402 middleware links settlement hash to request ID and final HTTP status", async t => {
  const f = await fixture(t);
  const response = await f.paid("one", "/weather?api_key=QUERY_SECRET_MUST_NOT_BE_LOGGED");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { forecast: "sunny" });
  const requestId = response.headers.get("x-request-id")!;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(requestId, "client-spoofed-request-id");
  const events = readAudit(f.path, { transaction: txFor("one") });
  assert.deepEqual(events.map(e => e.type), [
    "request.started", "settlement.attempted", "settlement.succeeded", "request.completed",
  ]);
  assert.ok(events.every(e => e.requestId === requestId));
  assert.equal(events[2].attemptId, events[1].attemptId);
  assert.equal(events[2].amount, "10000");
  assert.equal(events[2].asset, TOKEN);
  assert.equal(events[2].payTo, VAULT);
  assert.equal(events[2].payer, PAYER);
  assert.equal(events[3].status, 200);
  assert.equal(events[2].deploymentId, "11111111-1111-4111-8111-111111111111");
  assert.equal(events[0].ingress, "loopback");
  assert.doesNotMatch(JSON.stringify(events), /SECRET|PAYMENT-SIGNATURE|Authorization|Cookie|client-spoofed/);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("unpaid requests record 402 without creating a settlement; health checks do not grow history", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/weather`)).status, 402);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
  const events = readAudit(f.path);
  assert.deepEqual(events.map(e => e.type), ["request.started", "request.completed"]);
  assert.equal(events[1].status, 402);
  assert.equal(f.countSettlements(), 0);
});

test("concurrent requests keep distinct request/attempt IDs and correct transaction links", async t => {
  const f = await fixture(t);
  const tags = Array.from({ length: 12 }, (_, index) => String(index));
  const responses = await Promise.all(tags.map(tag => f.paid(tag)));
  assert.ok(responses.every(r => r.status === 200));
  const requestIds = responses.map(r => r.headers.get("x-request-id"));
  assert.equal(new Set(requestIds).size, tags.length);
  for (const [index, tag] of tags.entries()) {
    const events = readAudit(f.path, { transaction: txFor(tag) });
    assert.equal(events.length, 4);
    assert.ok(events.every(event => event.requestId === requestIds[index]));
    assert.equal(events[3].status, 200);
  }
});

test("facilitator exceptions are unconfirmed, never successful, and messages are not persisted", async t => {
  const f = await fixture(t, { remoteFailure: true });
  const response = await f.paid();
  assert.notEqual(response.status, 200);
  const events = readAudit(f.path);
  assert.equal(events.filter(e => e.type === "settlement.attempted").length, 1);
  assert.ok(events.some(e => e.type === "settlement.unconfirmed"));
  assert.ok(!events.some(e => e.type === "settlement.succeeded"));
  assert.equal(events.at(-1)!.type, "request.completed");
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test("failure to persist request.started prevents payment and returns 503", async t => {
  const f = await fixture(t, { failEvent: "request.started" });
  assert.equal((await f.paid()).status, 503);
  assert.equal(f.countSettlements(), 0);
  assert.equal(f.audit.isHealthy(), false);
  assert.equal(readAudit(f.path).length, 0);
  assert.doesNotMatch(JSON.stringify(f.failures), /SECRET/);
});

test("failure to persist settlement intent explicitly aborts x402 before it calls settle", async t => {
  const f = await fixture(t, { failEvent: "settlement.attempted" });
  assert.notEqual((await f.paid()).status, 200);
  assert.equal(f.countSettlements(), 0);
  assert.equal(f.audit.isHealthy(), false);
  assert.equal((await f.paid()).status, 503);
});

test("post-settlement disk failure does not retry payment; future payments fail closed", async t => {
  const f = await fixture(t, { failEvent: "settlement.succeeded" });
  const response = await f.paid("paid-once");
  assert.equal(response.status, 200);
  assert.equal(f.countSettlements(), 1);
  assert.equal(f.audit.isHealthy(), false);
  assert.deepEqual(f.failures[0], {
    type: "audit_write_failed", requestId: response.headers.get("x-request-id"),
    transaction: txFor("paid-once"),
  });
  assert.equal((await f.paid("do-not-retry")).status, 503);
  assert.equal(f.countSettlements(), 1);
});

test("failure to persist final HTTP status marks audit unhealthy without an unhandled exception", async t => {
  const f = await fixture(t, { failEvent: "request.completed" });
  assert.equal((await f.paid()).status, 200);
  assert.equal(f.audit.isHealthy(), false);
  assert.equal(readAudit(f.path).filter(e => e.type === "settlement.succeeded").length, 1);
  assert.equal((await fetch(`${f.url}/health`)).status, 503);
});

test("route normalization audits mixed-case and trailing-slash forms accepted by Express", async t => {
  const f = await fixture(t);
  assert.equal((await f.paid("alias", "/WeAtHeR/")).status, 200);
  assert.equal(readAudit(f.path, { transaction: txFor("alias") })[0].route, "/weather");
});

test("repeated transaction hashes are retained, not overwritten or silently double-counted", async t => {
  const f = await fixture(t);
  await f.paid("same-hash");
  await f.paid("same-hash");
  const events = readAudit(f.path, { transaction: txFor("same-hash") });
  assert.equal(events.filter(e => e.type === "settlement.succeeded").length, 2);
  assert.equal(new Set(events.map(e => e.requestId)).size, 2);
});

test("database survives close/reopen and read-only filtering preserves the lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-restart-"));
  const path = join(dir, "audit.sqlite");
  try {
    let store = new AuditStore(path);
    const event: AuditEvent = {
      version: 1, type: "request.started", at: new Date().toISOString(),
      requestId: "11111111-1111-4111-8111-111111111111",
      method: "GET", route: "/weather", network: NETWORK,
    };
    store.append(event);
    store.close();
    store = new AuditStore(path);
    store.append({ ...event, type: "request.completed", status: 402 });
    store.close();
    assert.equal(readAudit(path, { requestId: event.requestId }).length, 2);
    assert.equal(readAudit(path, { transaction: "a".repeat(64) }).length, 0);
    assert.throws(() => readAudit(join(dir, "missing.sqlite")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("production and Railway reject ephemeral/missing/relative paths and symlink escapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-mount-"));
  const outside = mkdtempSync(join(tmpdir(), "audit-outside-"));
  try {
    assert.throws(() => auditPath({ NODE_ENV: "production" }), /required/);
    assert.throws(() => auditPath({ AUDIT_DB_PATH: "./relative.sqlite" }), /absolute/);
    const env = { RAILWAY_ENVIRONMENT_ID: "test", AUDIT_DB_PATH: join(dir, "audit.sqlite") };
    assert.throws(() => auditPath(env), /attached Railway volume/);
    assert.equal(auditPath({ ...env, RAILWAY_VOLUME_MOUNT_PATH: dir }), env.AUDIT_DB_PATH);
    assert.throws(() => auditPath({
      ...env, RAILWAY_VOLUME_MOUNT_PATH: dir, AUDIT_DB_PATH: join(outside, "audit.sqlite"),
    }), /attached Railway volume/);
    symlinkSync(outside, join(dir, "escape"));
    assert.throws(() => auditPath({
      ...env, RAILWAY_VOLUME_MOUNT_PATH: dir, AUDIT_DB_PATH: join(dir, "escape/audit.sqlite"),
    }), /symlink/);
    mkdirSync(join(dir, "nested"));
    symlinkSync(join(outside, "db.sqlite"), join(dir, "nested/link.sqlite"));
    // A dangling symlink must never be followed when the database is created.
    assert.throws(() => auditPath({
      ...env, RAILWAY_VOLUME_MOUNT_PATH: dir, AUDIT_DB_PATH: join(dir, "nested/link.sqlite"),
    }), /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("export CLI retrieves a transaction lifecycle and rejects invalid filters", async t => {
  const f = await fixture(t);
  await f.paid("export-me");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "audit-export.ts", "--tx", txFor("export-me"),
  ], {
    cwd: new URL(".", import.meta.url), encoding: "utf8",
    env: { ...process.env, AUDIT_DB_PATH: f.path },
  });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.length, 4);
  assert.equal(events[2].transaction, txFor("export-me"));
  assert.equal(events[3].status, 200);
  const invalid = spawnSync(process.execPath, [
    "--import", "tsx", "audit-export.ts", "--tx", "not-a-hash",
  ], {
    cwd: new URL(".", import.meta.url), encoding: "utf8",
    env: { ...process.env, AUDIT_DB_PATH: f.path },
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});
